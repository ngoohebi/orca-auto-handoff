// Last-known usage per account. Orca polls only the active account in the background and fetches
// inactive ones only when its usage view opens or right after an account switch; an inactive
// Claude account with an expired token reports nothing until it runs again. So the plugin keeps
// the last reading Orca gave for every account (like cux's usage-cache.json) and shows it with its
// age, treating windows whose reset time has passed as reset.
import type { Provider, Seat, SeatUsage, UsageWindow } from './types'

export type CachedSeat = {
  session?: UsageWindow
  weekly?: UsageWindow
  model?: UsageWindow & { name: string }
  /** When Orca took this reading (its `updatedAt`), or when the plugin first saw it. */
  asOf: number
  /** The numbers and reset times, so a repeated cached row never looks fresh. */
  sig: string
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
const WINDOW_MS = { session: 5 * HOUR, weekly: 7 * 24 * HOUR, model: 7 * 24 * HOUR }

function strip(w: UsageWindow | undefined): UsageWindow | undefined {
  return w ? { usedPercent: w.usedPercent, resetsAt: w.resetsAt } : undefined
}

function signature(u: SeatUsage): string {
  const part = (w: UsageWindow | undefined) => (w ? `${w.usedPercent}@${w.resetsAt ?? '-'}` : '-')
  return [part(u.session), part(u.weekly), u.model ? `${u.model.name}:${part(u.model)}` : '-'].join('|')
}

/**
 * Is this seat's current reading really Orca's live numbers for it? Right after an account switch
 * Orca's active slot can still hold the previous account's numbers: a reading older than the
 * switch is not trusted for the new account.
 */
export function isLive(seat: Seat, activeSince: Partial<Record<Provider, number>>): boolean {
  if (!seat.usage.known) return false
  const since = seat.active ? activeSince[seat.provider] : undefined
  return !(since !== undefined && seat.usage.updatedAt !== undefined && seat.usage.updatedAt < since)
}

/** Records every live reading; prunes accounts Orca no longer lists. Returns whether it changed. */
export function observe(
  cache: UsageCache,
  seats: readonly Seat[],
  now: number,
  activeSince: Partial<Record<Provider, number>>
): boolean {
  let changed = false
  const listed = new Set(seats.map((s) => s.key))
  for (const key of Object.keys(cache.seats)) {
    if (!listed.has(key)) {
      delete cache.seats[key]
      changed = true
    }
  }
  for (const seat of seats) {
    if (!isLive(seat, activeSince)) continue
    const sig = signature(seat.usage)
    const prev = cache.seats[seat.key]
    if (prev && prev.sig === sig) continue
    const entry: CachedSeat = { asOf: seat.usage.updatedAt ?? now, sig }
    const session = strip(seat.usage.session)
    const weekly = strip(seat.usage.weekly)
    if (session) entry.session = session
    if (weekly) entry.weekly = weekly
    if (seat.usage.model) entry.model = { ...strip(seat.usage.model)!, name: seat.usage.model.name }
    cache.seats[seat.key] = entry
    changed = true
  }
  return changed
}

/** A cached window as it stands now: reset when its reset time has passed, gone when too old. */
function project(w: UsageWindow | undefined, asOf: number, lengthMs: number, now: number): UsageWindow | undefined {
  if (!w) return undefined
  if (w.resetsAt !== null && w.resetsAt <= now) return { usedPercent: 0, resetsAt: null, reset: true }
  if (w.resetsAt === null && now - asOf > lengthMs) return undefined
  return { usedPercent: w.usedPercent, resetsAt: w.resetsAt }
}

/**
 * The usage the plugin should use for a seat: Orca's live numbers when it has them, else the last
 * reading (projected past resets), else unknown. Orca's current reason (stale token, rate limited,
 * …) is kept either way.
 */
export function resolve(
  seat: Seat,
  cache: UsageCache,
  now: number,
  maxAgeMs: number,
  activeSince: Partial<Record<Provider, number>>
): SeatUsage {
  const current = seat.usage
  if (isLive(seat, activeSince)) {
    const live: SeatUsage = { ...current, known: true, source: 'live' }
    if (current.updatedAt !== undefined) live.asOf = current.updatedAt
    return live
  }
  const keep: Partial<SeatUsage> = {}
  if (current.reason) keep.reason = current.reason
  if (current.detail) keep.detail = current.detail
  if (current.retryAt) keep.retryAt = current.retryAt
  const cached = cache.seats[seat.key]
  if (!cached || maxAgeMs <= 0 || now - cached.asOf > maxAgeMs) {
    return { ...keep, known: false, source: 'unknown' }
  }
  const session = project(cached.session, cached.asOf, WINDOW_MS.session, now)
  const weekly = project(cached.weekly, cached.asOf, WINDOW_MS.weekly, now)
  const modelWin = project(cached.model, cached.asOf, WINDOW_MS.model, now)
  const usage: SeatUsage = { ...keep, known: !!(session || weekly || modelWin), source: 'cached', asOf: cached.asOf }
  if (session) usage.session = session
  if (weekly) usage.weekly = weekly
  if (modelWin && cached.model) usage.model = { ...modelWin, name: cached.model.name }
  if ([session, weekly, modelWin].some((w) => w?.reset)) usage.source = 'projected'
  if (!usage.known) usage.source = 'unknown'
  return usage
}
