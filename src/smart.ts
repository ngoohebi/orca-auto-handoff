// The Smart strategy: how full each account is, how fast it fills, which account to use next, and
// one line saying why. Pure: numbers in, a decision out. The engine supplies the readings, the
// pane counts and the clock, and does the moving.
//
// - `assess`: an account is Out (limited), Low (about to run out), OK, or Unknown (no numbers).
// - `rank`: the order in which accounts are worth moving to.
// - `shouldLeave`: is a session's account one to move away from at the next safe moment?
// - `explain`: the reason for a move, for the history and the notification.
import { RUNWAY_MAX_AGE_MS, rateOf, runwayOf, weeklyPace, type Sample, type SeatSamples, type WindowName } from './usage-history'
import type { Config, Seat, SeatHealth, UsageWindow } from './types'

const MIN = 60_000
const HOUR = 60 * MIN
/** Weekly quota counts as expiring only this close to its reset… */
export const EXPIRING_WITHIN_MS = 48 * HOUR
/** …and only with more than this much of it left. */
export const EXPIRING_MIN_LEFT = 15
/** A target should last at least this many horizons at its projected pace. */
export const TARGET_HORIZONS = 3
/** The horizon used for targets when forecasting is off ("only at the limit"). */
const FALLBACK_HORIZON_MINUTES = 10
/** Park instead of moving when the account being left resets this soon. */
export const SHORT_WAIT_MS = 5 * MIN
const WEEK_MS = 7 * 24 * HOUR

export type SeatState = 'out' | 'low' | 'ok' | 'unknown'

export type Assessment = {
  state: SeatState
  /** Percent left per window, where known. */
  left: { s?: number; w?: number; m?: number }
  /** Points per minute per window; `null` when the pace is not known. */
  rate: { s: number | null; w: number | null; m: number | null }
  /** Time until the first window is used up at the current pace; `null` without a pace. */
  runwayMs: number | null
  /** At or over a limit by its own numbers (not merely cooling down after a banner). */
  over: boolean
  /** Why it is Low: which window, and whether by its pace or only by its level. */
  low?: { window: WindowName; by: 'pace' | 'level' }
}

/** What the engine knows beyond the accounts themselves. */
export type SmartContext = {
  /** Usage history per account (usage-history.ts). */
  samples: Readonly<Record<string, SeatSamples>>
  /** Sessions running on each account now. */
  panes: Readonly<Record<string, number>>
  /** Accounts left as Low that are not to be used again yet. */
  avoid: ReadonlySet<string>
}

export const NO_CONTEXT: SmartContext = { samples: {}, panes: {}, avoid: new Set() }

function current(w: UsageWindow | undefined, now: number): UsageWindow | undefined {
  if (!w || w.reset) return undefined
  if (w.resetsAt !== null && w.resetsAt <= now) return undefined // already reset
  return w
}

const leftOf = (w: UsageWindow | undefined) => (w ? Math.max(0, 100 - w.usedPercent) : undefined)

/** How far ahead "about to run out" looks, in ms; 0 = no forecast. */
export function horizonMs(config: Config): number {
  return Math.max(0, config.horizonMinutes) * MIN
}

/**
 * The state of one account.
 * - Out: cooling down after a limit, or at 100 % (or the configured cap) of a window.
 * - Low: at its current pace it runs out within the horizon (from a reading at most 10 minutes
 *   old); or, with no pace known for a window, that window is nearly full (5h 97 %, week 99 %).
 * - Unknown: no usage numbers at all.
 * - OK: known, with room.
 */
export function assess(
  seat: Pick<Seat, 'usage'>,
  health: SeatHealth | undefined,
  samples: readonly Sample[],
  config: Config,
  now: number
): Assessment {
  const u = seat.usage
  const rate = { s: rateOf(samples, 's', now), w: rateOf(samples, 'w', now), m: rateOf(samples, 'm', now) }
  const left: Assessment['left'] = {}
  const runway = runwayOf(samples, now)
  const base = { left, rate, runwayMs: runway?.ms ?? null }
  const cooling = !!health?.cooldownUntil && health.cooldownUntil > now
  if (!u.known) return { ...base, state: cooling ? 'out' : 'unknown', over: false }
  const session = current(u.session, now)
  const weekly = current(u.weekly, now)
  const s = leftOf(u.session?.reset ? { usedPercent: 0, resetsAt: null } : session)
  const w = leftOf(u.weekly?.reset ? { usedPercent: 0, resetsAt: null } : weekly)
  const m = leftOf(current(u.model, now))
  if (s !== undefined) left.s = s
  if (w !== undefined) left.w = w
  if (m !== undefined) left.m = m
  const over = (!!session && session.usedPercent >= 100) || (!!weekly && weekly.usedPercent >= 100)
  if (cooling || over) return { ...base, state: 'out', over }
  const horizon = horizonMs(config)
  if (horizon > 0 && runway && runway.ms < horizon) return { ...base, state: 'low', over, low: { window: runway.win, by: 'pace' } }
  // "Also hand off below this much left": the 5-hour window's level, whatever the pace.
  if (session && config.floorFiveHour < 100 && session.usedPercent >= config.floorFiveHour) {
    return { ...base, state: 'low', over, low: { window: 's', by: 'level' } }
  }
  // No pace for a window: its level alone decides. So it does when the readings are too old to
  // forecast with (no runway from them), whatever pace the last half hour still shows.
  const latest = samples[samples.length - 1]
  const stale = !latest || now - latest.t > RUNWAY_MAX_AGE_MS
  if ((rate.s === null || stale) && session && config.lowFiveHour < 100 && session.usedPercent >= config.lowFiveHour) {
    return { ...base, state: 'low', over, low: { window: 's', by: 'level' } }
  }
  if ((rate.w === null || stale) && weekly && config.lowSevenDay < 100 && weekly.usedPercent >= config.lowSevenDay) {
    return { ...base, state: 'low', over, low: { window: 'w', by: 'level' } }
  }
  return { ...base, state: 'ok', over }
}

/**
 * Should a session leave this account at the next safe moment (its turn has ended, or it sits
 * idle)? Yes when the account is at a limit by its numbers, or Low. A cooldown alone is not a
 * reason: a session that just finished a turn there shows the account works.
 */
export function shouldLeave(
  seat: Pick<Seat, 'usage'>,
  health: SeatHealth | undefined,
  samples: readonly Sample[],
  config: Config,
  now: number
): { leave: boolean; assessment: Assessment } {
  const assessment = assess(seat, health, samples, config, now)
  if (!config.autoSwitchOnThreshold) return { leave: false, assessment }
  return { leave: assessment.over || assessment.state === 'low', assessment }
}

/** How long an account would last with one more session on it: its pace is scaled by the
 *  sessions already there plus one. `null` when its pace is not known. */
export function projectedRunwayMs(samples: readonly Sample[], panes: number, now: number): number | null {
  return runwayOf(samples, now, Math.max(0, panes) + 1)?.ms ?? null
}

/**
 * Weekly quota that cannot be used up before it resets, at this account's own weekly pace: more
 * than 15 % left, a reset under 48 h away, and the pace of the week so far (the daily levels, or
 * the average since the week began) does not reach 100 %.
 */
export function expiring(seat: Pick<Seat, 'usage'>, samples: SeatSamples | undefined, now: number): boolean {
  const w = seat.usage.known ? current(seat.usage.weekly, now) : undefined
  if (!w || w.resetsAt === null) return false
  const toReset = w.resetsAt - now
  if (toReset <= 0 || toReset >= EXPIRING_WITHIN_MS) return false
  if (100 - w.usedPercent <= EXPIRING_MIN_LEFT) return false
  const elapsed = WEEK_MS - toReset
  const average = elapsed >= HOUR ? w.usedPercent / elapsed : 0
  const pace = weeklyPace(samples?.daily ?? [], w.resetsAt) ?? average
  return w.usedPercent + pace * toReset < 100
}

export type Tier = 'A' | 'B+' | 'B'
const TIER_RANK: Record<Tier, number> = { A: 0, 'B+': 1, B: 2 }

export type Candidate = {
  seat: Seat
  tier: Tier
  /** Strikes that still count (only orders accounts without numbers). */
  strikes: number
  assessment: Assessment
  /** See `projectedRunwayMs`. */
  projectedMs: number | null
  expiring: boolean
  /** Left as Low and not to be used again yet. */
  avoided: boolean
  /** Position in the user's own order; equal for all when no order is set. */
  chainIndex: number
  /** Position after the current account, going round: the last tie-break. */
  turn: number
}

/** Enough projected runway: three horizons, and not Low or set aside. An account with no pace
 *  known has no forecast against it. */
export function lastsLongEnough(c: Pick<Candidate, 'assessment' | 'projectedMs' | 'avoided'>, config: Config): boolean {
  if (c.avoided || c.assessment.state === 'low') return false
  const need = TARGET_HORIZONS * (horizonMs(config) || FALLBACK_HORIZON_MINUTES * MIN)
  return c.projectedMs === null || c.projectedMs >= need
}

function weeklyResetOf(seat: Seat): number {
  return seat.usage.known && !seat.usage.weekly?.reset ? (seat.usage.weekly?.resetsAt ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY
}

/** Least room across the 5-hour and weekly windows; unknown counts as the middle. */
export function headroom(seat: Pick<Seat, 'usage'>): number {
  if (!seat.usage.known) return 50
  return 100 - Math.max(seat.usage.session?.usedPercent ?? 0, seat.usage.weekly?.usedPercent ?? 0)
}

/**
 * Orders accounts as targets, best first:
 * 1. how much is known (A: numbers; B+: presumed reset; B: nothing, fewest strikes first);
 * 2. a projected runway of at least three horizons;
 * 3. the user's own order, if set;
 * 4. weekly quota that would expire unused;
 * 5. the sooner weekly reset;
 * 6. more headroom;
 * then the next account after the current one.
 */
export function rank(candidates: readonly Candidate[], config: Config): Candidate[] {
  const keys = (c: Candidate): number[] => [
    TIER_RANK[c.tier],
    c.tier === 'B' ? c.strikes : 0,
    lastsLongEnough(c, config) ? 0 : 1,
    c.chainIndex,
    c.expiring ? 0 : 1,
    weeklyResetOf(c.seat),
    -headroom(c.seat),
    c.turn
  ]
  return [...candidates].sort((a, b) => {
    const ka = keys(a)
    const kb = keys(b)
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] === kb[i]) continue
      return ka[i]! < kb[i]! ? -1 : 1
    }
    return 0
  })
}

/** Builds the candidate for one account from what the engine knows. */
export function candidateOf(
  seat: Seat,
  tier: Tier,
  strikes: number,
  health: SeatHealth | undefined,
  context: SmartContext,
  config: Config,
  now: number,
  position: { chainIndex: number; turn: number }
): Candidate {
  const history = context.samples[seat.key]
  const recent = history?.recent ?? []
  return {
    seat,
    tier,
    strikes,
    assessment: assess(seat, health, recent, config, now),
    projectedMs: projectedRunwayMs(recent, context.panes[seat.key] ?? 0, now),
    expiring: expiring(seat, history, now),
    avoided: context.avoid.has(seat.key),
    ...position
  }
}

/**
 * "Use it or lose it": the best account whose weekly quota would expire unused and that is a
 * better place than the current one. The current account must be fine (Low and Out have their
 * own rules), the target known, lasting, and not behind the current one in the user's order;
 * and when the current account's quota expires too, the target's must expire sooner.
 */
export function betterExpiring(current: Candidate, others: readonly Candidate[], config: Config): Candidate | null {
  if (current.assessment.state === 'out' || current.assessment.state === 'low') return null
  const pool = others.filter(
    (c) =>
      c.seat.key !== current.seat.key &&
      c.tier === 'A' &&
      c.expiring &&
      lastsLongEnough(c, config) &&
      c.chainIndex <= current.chainIndex &&
      (!current.expiring || weeklyResetOf(c.seat) < weeklyResetOf(current.seat))
  )
  return rank(pool, config)[0] ?? null
}

/**
 * The short-wait rule. A session resumed on another account re-reads its whole context without
 * cache, so when the account being left is back within 5 minutes, waiting is cheaper than moving.
 * The same holds when the best target would not last three horizons at its projected pace and
 * the source is back before the target would be used up: the move would buy a few minutes and
 * cost two full re-reads. Returns when to resume on the source, or `null` to move.
 */
export function shortWait(sourceResetsAt: number | null | undefined, targetProjectedMs: number | null, config: Config, now: number): number | null {
  if (typeof sourceResetsAt !== 'number' || sourceResetsAt <= now) return null
  const wait = sourceResetsAt - now
  if (wait <= SHORT_WAIT_MS) return sourceResetsAt
  const need = TARGET_HORIZONS * (horizonMs(config) || FALLBACK_HORIZON_MINUTES * MIN)
  if (targetProjectedMs !== null && targetProjectedMs < need && wait < targetProjectedMs) return sourceResetsAt
  return null
}

// ---- words ------------------------------------------------------------------------------

const WINDOW_NAME: Record<WindowName, string> = { s: '5h', w: 'week', m: 'model' }

function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MIN))
  if (minutes <= 90) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours <= 48 ? `${hours} h` : `${Math.round(hours / 24)} d`
}

/** `5h 12 %, week 40 %, weekly resets in 9 h`: the levels used, and the weekly reset when near. */
export function levels(seat: Pick<Seat, 'usage'>, now: number): string {
  const u = seat.usage
  if (!u.known) return 'no usage numbers yet'
  const parts: string[] = []
  if (u.session) parts.push(`5h ${Math.round(u.session.usedPercent)} %`)
  if (u.weekly) parts.push(`week ${Math.round(u.weekly.usedPercent)} %`)
  const reset = u.weekly?.resetsAt
  if (typeof reset === 'number' && reset > now && reset - now < EXPIRING_WITHIN_MS) parts.push(`weekly resets in ${duration(reset - now)}`)
  return parts.join(', ')
}

export type Explained = { label: string; usage: Seat['usage']; assessment?: Assessment }

/**
 * Why the plugin moved a session, or changed the account for new launches, in one line:
 * "work had about 8 min left at this pace (5h 94 %); moved to personal (5h 12 %, weekly resets in 9 h)".
 * - `low`: the source was about to run out; `out`: it is at a limit or cooling down;
 * - `expiring`: the target has weekly quota that would otherwise expire unused.
 */
export function explain(
  kind: 'low' | 'out' | 'expiring',
  from: Explained | undefined,
  to: Explained,
  now: number,
  options: { selectionOnly?: boolean; idle?: boolean } = {}
): string {
  const source = from?.label ?? 'the current account'
  const fromLevels = from ? ` (${levels(from, now)})` : ''
  const arrived = `${options.selectionOnly ? 'new sessions start on' : 'handed off to'} ${to.label} (${levels(to, now)})`
  const idle = options.idle ? 'idle session; ' : ''
  if (kind === 'expiring') {
    const tail = options.selectionOnly ? 'new sessions start on it' : `handed off there from ${source}`
    return `${idle}${to.label} has weekly quota that would expire unused (${levels(to, now)}); ${tail}`
  }
  if (kind === 'out') {
    const a = from?.assessment
    const state = a && !a.over ? 'is cooling down after a limit' : 'is used up'
    return `${idle}${source} ${state}${fromLevels}; ${arrived}`
  }
  const a = from?.assessment
  if (a?.low?.by === 'pace' && a.runwayMs !== null) {
    return `${idle}${source} had about ${duration(a.runwayMs)} left at this pace${fromLevels}; ${arrived}`
  }
  const which = a?.low ? ` of its ${WINDOW_NAME[a.low.window]} window` : ''
  return `${idle}${source} is nearly at the end${which}${fromLevels}; ${arrived}`
}
