// Last-known usage per account. Orca polls only the active account in the background and fetches
// inactive ones only when its usage view opens or right after an account switch; an inactive
// Claude account with an expired token reports nothing until it runs again. So the plugin keeps
// the last reading Orca gave for every account and shows it with its
// age, treating windows whose reset time has passed as reset.
import { LIVE_FRESH_MS, type LiveReading } from './live-usage.ts'
import type { Provider, Seat, SeatUsage, UsageWindow } from './types.ts'

export type CachedSeat = {
  session?: UsageWindow
  weekly?: UsageWindow
  monthly?: UsageWindow
  model?: UsageWindow & { name: string }
  ordinaryUsageAllowed?: boolean
  rateLimitReachedType?: string
  /** When Orca took this reading (its `updatedAt`), or when the plugin first saw it. */
  asOf: number
  /** Orca's last numbers and reset times, so a repeated cached row never looks fresh. */
  sig: string
  /** Set when session and weekly come from a pane's status line (`observeLive`), not from Orca. */
  origin?: SeatUsage['origin']
}

export type UsageCache = { v: 1; seats: Record<string, CachedSeat> }

export function emptyUsageCache(): UsageCache {
  return { v: 1, seats: {} }
}

/** A stored value, or an empty cache when it is missing or from another version. */
export function loadedUsageCache(value: unknown): UsageCache {
  const c = value as UsageCache | null
  return c && c.v === 1 && c.seats && typeof c.seats === 'object' ? c : emptyUsageCache()
}

const HOUR = 3_600_000
/** How long a window lasts when Orca gave no reset time. */
const WINDOW_MS = { session: 5 * HOUR, weekly: 7 * 24 * HOUR, monthly: 31 * 24 * HOUR, model: 7 * 24 * HOUR }

function strip(w: UsageWindow | undefined): UsageWindow | undefined {
  return w ? { usedPercent: w.usedPercent, resetsAt: w.resetsAt } : undefined
}

function signature(u: SeatUsage): string {
  const part = (w: UsageWindow | undefined) => (w ? `${w.usedPercent}@${w.resetsAt ?? '-'}` : '-')
  const windows = [part(u.session), part(u.weekly), part(u.monthly), u.model ? `${u.model.name}:${part(u.model)}` : '-'].join('|')
  return u.ordinaryUsageAllowed === undefined ? windows : `${windows}|${u.ordinaryUsageAllowed}|${u.rateLimitReachedType ?? ''}`
}

/**
 * Is this seat's current reading really Orca's live numbers for it? Right after an account switch
 * Orca's active slot can still hold the previous account's numbers: a reading older than the
 * switch is not trusted for the new account.
 */
export function isLive(seat: Seat, activeSince: Partial<Record<Provider, number>>): boolean {
  if (!seat.usage.known) return false
  if (seat.usage.origin && seat.usage.origin !== 'pane') return true
  const since = seat.active ? activeSince[seat.provider] : undefined
  return !(since !== undefined && seat.usage.updatedAt !== undefined && seat.usage.updatedAt < since)
}

function cacheKey(scope: string | undefined, seatKey: string): string {
  return scope ? `${scope}|${seatKey}` : seatKey
}

function inScope(scope: string | undefined, key: string): boolean {
  return scope ? key.startsWith(`${scope}|`) : !key.includes('|')
}

/** Records every live reading; prunes accounts Orca no longer lists. Returns whether it changed. */
export function observe(
  cache: UsageCache,
  seats: readonly Seat[],
  now: number,
  activeSince: Partial<Record<Provider, number>>,
  scope?: string
): boolean {
  let changed = false
  const listed = new Set(seats.map((s) => cacheKey(scope, s.key)))
  for (const key of Object.keys(cache.seats)) {
    if (inScope(scope, key) && !listed.has(key)) {
      delete cache.seats[key]
      changed = true
    }
  }
  for (const seat of seats) {
    if (!isLive(seat, activeSince)) continue
    const key = cacheKey(scope, seat.key)
    const sig = signature(seat.usage)
    const prev = cache.seats[key]
    const asOf = seat.usage.updatedAt ?? now
    const direct = seat.usage.origin && seat.usage.origin !== 'pane'
    if (prev?.origin && prev.origin !== 'pane' && (prev.asOf > asOf || (!direct && seat.usage.updatedAt === undefined))) continue
    if (prev && prev.sig === sig && !(direct && asOf > prev.asOf)) continue
    if (prev?.origin === 'pane' && prev.asOf >= asOf) {
      // A pane reported after Orca took this reading: its session and weekly stand. The model
      // bucket only ever comes from Orca.
      prev.sig = sig
      if (seat.usage.model) prev.model = { ...strip(seat.usage.model)!, name: seat.usage.model.name }
      else delete prev.model
      changed = true
      continue
    }
    const entry: CachedSeat = { asOf, sig }
    if (direct) entry.origin = seat.usage.origin
    if (seat.usage.ordinaryUsageAllowed !== undefined) entry.ordinaryUsageAllowed = seat.usage.ordinaryUsageAllowed
    if (seat.usage.rateLimitReachedType) entry.rateLimitReachedType = seat.usage.rateLimitReachedType
    const session = strip(seat.usage.session)
    const weekly = strip(seat.usage.weekly)
    const monthly = strip(seat.usage.monthly)
    if (session) entry.session = session
    if (weekly) entry.weekly = weekly
    if (monthly) entry.monthly = monthly
    if (seat.usage.model) entry.model = { ...strip(seat.usage.model)!, name: seat.usage.model.name }
    cache.seats[key] = entry
    changed = true
  }
  return changed
}

/** Two readings of one window: both give its reset time, at most a minute apart. */
function sameWindow(a: UsageWindow, b: UsageWindow): boolean {
  return a.resetsAt !== null && b.resetsAt !== null && Math.abs(a.resetsAt - b.resetsAt) <= 60_000
}

/** One window of a pane reading against what is remembered. Panes of one account each show the
 *  limits of their own last answer from Claude, so an idle pane can report older numbers than a
 *  busy one: within one window usage never goes down, and a pane that only knows a window that
 *  has ended does not replace a current one. */
function merged(prev: UsageWindow | undefined, next: UsageWindow | undefined, now: number): UsageWindow | undefined {
  if (!next) return prev
  if (!prev) return kept(next)
  if (next.reset && prev.resetsAt !== null && prev.resetsAt > now) return prev
  if (sameWindow(prev, next) && next.usedPercent < prev.usedPercent) return { usedPercent: prev.usedPercent, resetsAt: next.resetsAt }
  return kept(next)
}

function kept(w: UsageWindow): UsageWindow {
  return w.reset ? { usedPercent: w.usedPercent, resetsAt: w.resetsAt, reset: true } : { usedPercent: w.usedPercent, resetsAt: w.resetsAt }
}

/**
 * Records a pane's own reading for a seat (live-usage.ts). It replaces session and weekly, keeps
 * the model bucket (only Orca reports it) and marks the entry `origin: 'pane'`. A reading no newer
 * than what is remembered is ignored. Returns whether the cache changed.
 */
export function observeLive(cache: UsageCache, seatKey: string, reading: LiveReading, now: number): boolean {
  const prev = cache.seats[seatKey]
  if (prev && reading.asOf <= prev.asOf) return false
  const entry: CachedSeat = { asOf: reading.asOf, sig: prev?.sig ?? '', origin: 'pane' }
  const session = merged(prev?.session, reading.session, now)
  const weekly = merged(prev?.weekly, reading.weekly, now)
  if (session) entry.session = session
  if (weekly) entry.weekly = weekly
  if (prev?.model) entry.model = prev.model
  cache.seats[seatKey] = entry
  return true
}

/** A cached window as it stands now: reset when its reset time has passed, gone when too old. */
function project(w: UsageWindow | undefined, asOf: number, lengthMs: number, now: number): UsageWindow | undefined {
  if (!w) return undefined
  // A pane reading taken after its window had ended (see `parseLive`).
  if (w.reset && w.resetsAt === null) return now - asOf > lengthMs ? undefined : { usedPercent: 0, resetsAt: null, reset: true }
  if (w.resetsAt !== null && w.resetsAt <= now) return { usedPercent: 0, resetsAt: null, reset: true }
  if (w.resetsAt === null && now - asOf > lengthMs) return undefined
  return { usedPercent: w.usedPercent, resetsAt: w.resetsAt }
}

/**
 * The usage the plugin should use for a seat: Orca's live numbers when it has them, else the last
 * reading (projected past resets), else unknown. Orca's current reason (stale token, rate limited,
 * …) is kept either way.
 *
 * A pane's own reading (`observeLive`) wins over Orca's when it is the newer of the two, and counts
 * as live for 10 minutes. It belongs to the account whose pane wrote it, so the `activeSince` guard
 * (which protects against Orca's active slot still holding the previous account) does not apply.
 */
export function resolve(
  seat: Seat,
  cache: UsageCache,
  now: number,
  maxAgeMs: number,
  activeSince: Partial<Record<Provider, number>>,
  scope?: string
): SeatUsage {
  const current = seat.usage
  const key = cacheKey(scope, seat.key)
  const cachedEntry = cache.seats[key]
  const cachedPane = cachedEntry?.origin === 'pane' ? cachedEntry : undefined
  const orcaLive = isLive(seat, activeSince)
  const newerCachedReading = !!cachedEntry?.origin && cachedEntry.asOf > (current.updatedAt ?? 0)
    && (!!cachedPane || (maxAgeMs > 0 && now - cachedEntry.asOf <= maxAgeMs))
  if (orcaLive && !newerCachedReading) {
    const live: SeatUsage = { ...current, known: true, source: 'live' }
    if (current.updatedAt !== undefined) live.asOf = current.updatedAt
    return live
  }
  const keep: Partial<SeatUsage> = {}
  if (current.reason) keep.reason = current.reason
  if (current.detail) keep.detail = current.detail
  if (current.retryAt) keep.retryAt = current.retryAt
  const cached = cachedEntry
  const paneFresh = !!cachedPane && now - cachedPane.asOf <= LIVE_FRESH_MS
  const upToDate = paneFresh || (orcaLive && !!cachedPane)
  if (!cached || (!upToDate && (maxAgeMs <= 0 || now - cached.asOf > maxAgeMs))) {
    return { ...keep, known: false, source: 'unknown' }
  }
  const session = project(cached.session, cached.asOf, seat.provider === 'devin' ? 24 * HOUR : WINDOW_MS.session, now)
  const weekly = project(cached.weekly, cached.asOf, WINDOW_MS.weekly, now)
  const monthly = project(cached.monthly, cached.asOf, WINDOW_MS.monthly, now)
  const modelWin = project(cached.model, cached.asOf, WINDOW_MS.model, now)
  const blockedWindow = cached.rateLimitReachedType === 'weekly' ? cached.weekly
    : cached.rateLimitReachedType === 'session' ? cached.session : undefined
  const knownBlocked = cached.ordinaryUsageAllowed === false
    && (blockedWindow?.resetsAt == null || blockedWindow.resetsAt > now)
  const usage: SeatUsage = { ...keep, known: !!(session || weekly || monthly || modelWin || knownBlocked), source: upToDate ? 'live' : 'cached', asOf: cached.asOf }
  if (knownBlocked) {
    usage.ordinaryUsageAllowed = false
    if (cached.rateLimitReachedType) usage.rateLimitReachedType = cached.rateLimitReachedType
  }
  if (cached.origin) usage.origin = cached.origin
  if (session) usage.session = session
  if (weekly) usage.weekly = weekly
  if (monthly) usage.monthly = monthly
  if (modelWin && cached.model) usage.model = { ...modelWin, name: cached.model.name }
  if ([session, weekly, monthly, modelWin].some((w) => w?.reset)) usage.source = 'projected'
  if (!usage.known) usage.source = 'unknown'
  return usage
}
