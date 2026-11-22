// A short history of each account's usage, so the pace of use is known and not only its level:
// "94 % used" says little, "94 % used and rising 1 point a minute" says about 6 minutes are left.
// Observe only: nothing here decides a move. Kept under its own storage key (`usage-samples`),
// apart from the rotator's state, and holds numbers and times only.
import type { Seat, UsageWindow } from './types.ts'

/** One reading of an account, as taken (not projected). `s`, `w`, `m`: percent used of the
 *  5-hour, weekly and model windows; `null` when the reading had none, or that window has been
 *  dropped because a new one started. */
export type Sample = {
  /** When the reading was taken. */
  t: number
  s: number | null
  w: number | null
  m?: number | null
  sReset: number | null
  wReset: number | null
  mReset?: number | null
  /** Where the quota reading came from. */
  src: NonNullable<Seat['usage']['origin']> | 'orca'
}

/** The weekly level at the end of one UTC day, kept across weekly resets for the weekly pace. */
export type DailySample = { day: number; t: number; w: number; wReset: number | null }

export type SeatSamples = { recent: Sample[]; daily: DailySample[] }
export type UsageSamples = { v: 1; seats: Record<string, SeatSamples> }

export type WindowName = 's' | 'w' | 'm'
const WINDOWS: readonly WindowName[] = ['s', 'w', 'm']
const RESET_OF = { s: 'sReset', w: 'wReset', m: 'mReset' } as const

const MIN = 60_000
/** Recent samples kept per account: about 4 h at one per 5 minutes. */
export const RECENT_CAP = 48
/** Daily weekly levels kept per account. */
export const DAILY_CAP = 14
/** An unchanged reading is sampled this often. */
export const SAMPLE_EVERY_MS = 5 * MIN
/** Changing readings closer together than this replace each other, so the 48 kept always span
 *  well over the 30 minutes a rate looks back. */
const MIN_SPACING_MS = 150_000
/** How far back a rate looks. */
export const RATE_WINDOW_MS = 30 * MIN
/** A rate needs samples at least this far apart… */
export const RATE_MIN_SPAN_MS = 3 * MIN
/** …and a rise of at least this many points. */
export const RATE_MIN_RISE = 1
/** A runway is only given from a reading this recent. */
export const RUNWAY_MAX_AGE_MS = 10 * MIN
/** Reset times this close are the same window (Orca and Claude round differently). */
const RESET_JITTER_MS = MIN
/** Usage only rises within a window; a fall larger than rounding means a new window. */
const FALL_TOLERANCE = 2

export function emptyUsageSamples(): UsageSamples {
  return { v: 1, seats: {} }
}

/** A stored value, or an empty history when it is missing, from another version or malformed. */
export function loadedUsageSamples(value: unknown): UsageSamples {
  const h = value as UsageSamples | null
  if (!h || h.v !== 1 || !h.seats || typeof h.seats !== 'object') return emptyUsageSamples()
  const seats: UsageSamples['seats'] = {}
  for (const [key, entry] of Object.entries(h.seats)) {
    if (!entry || !Array.isArray(entry.recent) || !Array.isArray(entry.daily)) continue
    seats[key] = {
      recent: entry.recent.filter((x) => x && typeof x.t === 'number').slice(-RECENT_CAP),
      daily: entry.daily.filter((x) => x && typeof x.day === 'number' && typeof x.w === 'number').slice(-DAILY_CAP)
    }
  }
  return { v: 1, seats }
}

const valueOf = (x: Sample, win: WindowName): number | null => x[win] ?? null
const resetOf = (x: Sample, win: WindowName): number | null => x[RESET_OF[win]] ?? null

/** Two reset times of one window: equal, or within the jitter. An unknown one decides nothing. */
function sameReset(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b
  return Math.abs(a - b) <= RESET_JITTER_MS
}

/** Has this window started over between two samples? Its reset time moved, or usage fell. */
function restarted(prev: Sample, next: Sample, win: WindowName): boolean {
  const before = valueOf(prev, win)
  const after = valueOf(next, win)
  if (before === null || after === null) return false
  const a = resetOf(prev, win)
  const b = resetOf(next, win)
  if (a !== null && b !== null && !sameReset(a, b)) return true
  return after < before - FALL_TOLERANCE
}

/** The sample a seat's current usage makes, or `null` when it is not a reading as taken:
 *  unknown, remembered or projected numbers say nothing new about the pace. */
export function sampleOf(seat: Pick<Seat, 'usage'>, now: number): Sample | null {
  const u = seat.usage
  if (!u.known || (u.source !== undefined && u.source !== 'live')) return null
  const level = (w: UsageWindow | undefined) => (w && !w.reset && Number.isFinite(w.usedPercent) ? w.usedPercent : null)
  const s = level(u.session)
  const w = level(u.weekly)
  const m = level(u.model)
  if (s === null && w === null && m === null) return null
  const sample: Sample = {
    t: Math.min(u.asOf ?? now, now),
    s,
    w,
    sReset: s === null ? null : (u.session?.resetsAt ?? null),
    wReset: w === null ? null : (u.weekly?.resetsAt ?? null),
    src: u.origin ?? 'orca'
  }
  if (m !== null) {
    sample.m = m
    sample.mReset = u.model?.resetsAt ?? null
  }
  return sample
}

/**
 * Adds a seat's current reading to its history. A sample is kept when a value changed, or every
 * 5 minutes otherwise; a reading no newer than the last one is not a new sample. When a window's
 * reset time changes (or its usage falls), that window's earlier samples are dropped. Keeps the
 * last 48 samples and 14 daily weekly levels. Returns whether the history changed.
 */
export function addSample(history: UsageSamples, seat: Pick<Seat, 'key' | 'usage'>, now: number): boolean {
  const sample = sampleOf(seat, now)
  if (!sample) return false
  const entry = (history.seats[seat.key] ??= { recent: [], daily: [] })
  const last = entry.recent[entry.recent.length - 1]
  if (last) {
    if (sample.t <= last.t) return false
    for (const win of WINDOWS) {
      if (!restarted(last, sample, win)) continue
      for (const old of entry.recent) {
        if (win === 'm') {
          delete old.m
          delete old.mReset
        } else {
          old[win] = null
          old[RESET_OF[win]] = null
        }
      }
    }
    entry.recent = entry.recent.filter((x) => WINDOWS.some((win) => valueOf(x, win) !== null))
  }
  const prev = entry.recent[entry.recent.length - 1]
  const changed = !prev || WINDOWS.some((win) => valueOf(prev, win) !== valueOf(sample, win))
  if (prev && !changed && sample.t - prev.t < SAMPLE_EVERY_MS) return last !== prev
  const beforePrev = entry.recent[entry.recent.length - 2]
  if (prev && beforePrev && sample.t - beforePrev.t < MIN_SPACING_MS) entry.recent[entry.recent.length - 1] = sample
  else entry.recent.push(sample)
  if (entry.recent.length > RECENT_CAP) entry.recent = entry.recent.slice(-RECENT_CAP)
  if (sample.w !== null) {
    const daily: DailySample = { day: Math.floor(sample.t / 86_400_000), t: sample.t, w: sample.w, wReset: sample.wReset }
    const lastDay = entry.daily[entry.daily.length - 1]
    if (lastDay && lastDay.day === daily.day) entry.daily[entry.daily.length - 1] = daily
    else if (!lastDay || lastDay.day < daily.day) entry.daily.push(daily)
    if (entry.daily.length > DAILY_CAP) entry.daily = entry.daily.slice(-DAILY_CAP)
  }
  return true
}

/** Forgets accounts that are no longer listed. Returns whether any went. */
export function pruneSamples(history: UsageSamples, listed: Iterable<string>): boolean {
  const keep = new Set(listed)
  let changed = false
  for (const key of Object.keys(history.seats)) {
    if (keep.has(key)) continue
    delete history.seats[key]
    changed = true
  }
  return changed
}

/**
 * How fast one window fills, in points per minute: the slope from the first to the last sample of
 * the current window within the last 30 minutes. `null` without at least two samples 3 minutes
 * apart that rise by a point: too little to call a pace.
 */
export function rateOf(samples: readonly Sample[], win: WindowName, now: number): number | null {
  const withValue = samples.filter((x) => valueOf(x, win) !== null && x.t <= now)
  const latest = withValue[withValue.length - 1]
  if (!latest) return null
  const recent = withValue.filter((x) => x.t >= now - RATE_WINDOW_MS && sameReset(resetOf(x, win), resetOf(latest, win)))
  const first = recent[0]
  if (!first || first === latest || recent.length < 2) return null
  const span = latest.t - first.t
  const rise = valueOf(latest, win)! - valueOf(first, win)!
  if (span < RATE_MIN_SPAN_MS || rise < RATE_MIN_RISE) return null
  return rise / (span / MIN)
}

/**
 * How long until the first window is used up, from `now`, and which window that is. `scale`
 * multiplies the pace (more sessions on the account). A window that resets before it would run
 * out, or has reset since the last reading, does not count. `null` when no window has a pace, or the last reading is more than 10
 * minutes old.
 */
export function runwayOf(samples: readonly Sample[], now: number, scale = 1): { ms: number; win: WindowName } | null {
  const latest = samples[samples.length - 1]
  if (!latest || now - latest.t > RUNWAY_MAX_AGE_MS) return null
  let best: { ms: number; win: WindowName } | null = null
  for (const win of WINDOWS) {
    const used = valueOf(latest, win)
    const rate = rateOf(samples, win, now)
    if (used === null || rate === null) continue
    const emptyAt = latest.t + (Math.max(0, 100 - used) / (rate * Math.max(1, scale))) * MIN
    const reset = resetOf(latest, win)
    // A reset that has passed since the reading started a new window: the old pace is not its pace.
    if (reset !== null && (reset <= emptyAt || reset <= now)) continue
    const left = Math.max(0, emptyAt - now)
    if (best === null || left < best.ms) best = { ms: left, win }
  }
  return best
}

/** How long until the first window is used up at the current pace (see `runwayOf`). */
export function runwayMs(samples: readonly Sample[], now: number): number | null {
  return runwayOf(samples, now)?.ms ?? null
}

/**
 * How fast the weekly window fills over days, in points per millisecond: the slope of the daily
 * levels of the current week. `null` without two of them at least 12 hours apart.
 */
export function weeklyPace(daily: readonly DailySample[], weeklyReset: number | null): number | null {
  const week = daily.filter((d) => sameReset(d.wReset, weeklyReset))
  const first = week[0]
  const last = week[week.length - 1]
  if (!first || !last || last.t - first.t < 12 * 60 * MIN) return null
  return Math.max(0, last.w - first.w) / (last.t - first.t)
}
