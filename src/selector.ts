// Which seat comes next: the chain, eligibility, strategies, switch-back, earliest reset.
import { NO_CONTEXT, candidateOf, rank, type SmartContext, type Tier } from './smart'
import { BLIND_COOLDOWN_CAP_MINUTES, STRIKE_TTL_MS, type Config, type Provider, type Seat, type SeatHealth } from './types'

export type { Tier }

function tokens(list: string): string[] {
  return list
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
}

function matches(seat: Seat, token: string): boolean {
  if (token.endsWith(':*')) return seat.provider === token.slice(0, -2)
  return seat.key.toLowerCase() === token || seat.label.toLowerCase() === token
}

/**
 * The ordered seats a pane on `provider` may move through: only that provider's own accounts,
 * never another service. `chain` orders them; tokens are a seat key (`claude:<id>`), an
 * email/label, or `provider:*`. Seats the chain leaves out follow in Orca's order.
 */
export function buildChain(seats: readonly Seat[], provider: Provider, config: Config): Seat[] {
  const ordered: Seat[] = []
  const add = (s: Seat) => {
    if (!ordered.includes(s)) ordered.push(s)
  }
  for (const token of tokens(config.chain)) seats.filter((s) => matches(s, token)).forEach(add)
  // Seats of this provider that the chain does not mention still belong to its pool.
  seats.filter((s) => s.provider === provider).forEach(add)
  return ordered.filter((s) => s.provider === provider)
}

/** Listed in `exclude`: never switched *to* automatically (a manual pick still works). */
export function isExcluded(seat: Seat, config: Config): boolean {
  return tokens(config.exclude).some((t) => matches(seat, t))
}

function over(window: { usedPercent: number; resetsAt: number | null } | undefined, limit: number, now: number) {
  if (!window) return false
  if (window.resetsAt !== null && window.resetsAt <= now) return false // already reset
  return window.usedPercent >= Math.min(limit, 100)
}

/** Over a configured threshold (or exhausted) by the numbers Orca reports. */
export function overThreshold(seat: Seat, config: Config, now: number): boolean {
  if (!seat.usage.known) return false
  return (
    over(seat.usage.session, config.thresholdFiveHour, now) ||
    over(seat.usage.weekly, config.thresholdSevenDay, now)
  )
}

export function isEligible(seat: Seat, health: SeatHealth | undefined, config: Config, now: number): boolean {
  if (health?.cooldownUntil && health.cooldownUntil > now) return false
  return !overThreshold(seat, config, now)
}

/** Strikes that still count: they lapse 24 h after the last one. */
export function strikesOf(health: SeatHealth | undefined, now: number): number {
  if (!health?.strikes || typeof health.strikeAt !== 'number') return 0
  return now - health.strikeAt < STRIKE_TTL_MS ? health.strikes : 0
}

/** The guessed cooldown after the `strikes`-th banner on a seat with no numbers and no reset time:
 *  the default, doubled per strike, capped at 5 h (or at the default, when that is longer). */
export function blindCooldownMs(config: Config, strikes: number): number {
  const base = Math.max(1, config.defaultCooldownMinutes)
  const minutes = Math.min(base * 2 ** Math.max(0, strikes - 1), Math.max(BLIND_COOLDOWN_CAP_MINUTES, base))
  return minutes * 60_000
}

/**
 * How much the plugin knows about a seat it could switch to:
 * - `A`: usage is known (live, or a remembered reading) and under the thresholds;
 * - `B+`: no numbers, but a cooldown that ended at a real reset time has expired and the seat has
 *   no strikes, so it is presumed reset;
 * - `B`: no numbers at all;
 * - null: cooling down or over a threshold, so not a target.
 */
const RANK: Record<Tier, number> = { A: 0, 'B+': 1, B: 2 }

export function tier(seat: Seat, health: SeatHealth | undefined, config: Config, now: number): Tier | null {
  if (!isEligible(seat, health, config, now)) return null
  if (seat.usage.known) return 'A'
  const expired = health?.freedAt !== undefined || health?.cooldownUntil !== undefined
  return health?.resetKnown && expired && strikesOf(health, now) === 0 ? 'B+' : 'B'
}

/** Known to be at 100 % in a window that has not reset yet. */
export function exhausted(seat: Seat, now: number): boolean {
  return seat.usage.known && (over(seat.usage.session, 100, now) || over(seat.usage.weekly, 100, now))
}

/** Lower is better. Unknown usage counts as the middle; since tiers, that only orders a manual pick. */
export function load(seat: Seat): number {
  if (!seat.usage.known) return 50
  return Math.max(seat.usage.weekly?.usedPercent ?? 0, (seat.usage.session?.usedPercent ?? 0) / 2)
}

/**
 * Hysteresis for advisory (threshold) moves: with both usages known, the target must have at
 * least `minHeadroomGap` points more room, so two seats near the line never ping-pong. An
 * exhausted seat (100 %) may always leave. A target without numbers is never "clearly better":
 * only a seat known to be at 100 % may move onto it.
 */
export function enoughGap(from: Seat | undefined, to: Seat, config: Config): boolean {
  if (!from) return true
  const worst = from.usage.known ? Math.max(from.usage.session?.usedPercent ?? 0, from.usage.weekly?.usedPercent ?? 0) : 0
  if (!to.usage.known) return worst >= 100
  // Only Orca's live numbers are compared: a remembered reading ("reset since", a few hours old)
  // is good enough to rule a seat in or out, not to measure a few points of headroom.
  const live = (s: Seat) => s.usage.known && (s.usage.source === undefined || s.usage.source === 'live')
  if (!live(from) || !live(to)) return true
  if (worst >= 100) return true
  return load(from) - load(to) >= config.minHeadroomGap
}

/** When a seat's weekly window resets; Infinity when unknown (sorted last). */
function weeklyReset(seat: Seat): number {
  return seat.usage.weekly?.resetsAt ?? Number.POSITIVE_INFINITY
}

export type PickOptions = {
  /**
   * - `hard` (default): a limit was hit. Known seats first, then presumed-reset ones, then seats
   *   without numbers (fewest strikes first); the strategy orders seats within one tier.
   * - `advisory`: a threshold or idle move. Only a known seat, unless the source is known to be
   *   at 100 % and no known seat exists.
   * - `manual`: the user asked. Tiers are ignored; every eligible seat competes as before.
   */
  mode?: 'hard' | 'advisory' | 'manual'
  /** For `advisory`: the seat being left is known to be at 100 %. */
  sourceExhausted?: boolean
  /** For the `smart` strategy: usage history, pane counts and the accounts set aside. Without
   *  it Smart ranks on the accounts' numbers alone. */
  smart?: SmartContext
  /** Accounts an `advisory` move never goes to: left as Low a moment ago, or Low now. */
  avoid?: ReadonlySet<string>
  /** Only these accounts may be picked (a model cap: the ones with room in that model's bucket). */
  only?: ReadonlySet<string>
}

export function pickNext(
  chain: readonly Seat[],
  currentKey: string | undefined,
  health: Record<string, SeatHealth>,
  config: Config,
  now: number,
  options: PickOptions = {}
): Seat | null {
  if (config.strategy === 'manual') return null
  const mode = options.mode ?? 'hard'
  const tiers = new Map<Seat, Tier>()
  const smart = config.strategy === 'smart' ? (options.smart ?? NO_CONTEXT) : null
  const candidates = new Map<Seat, ReturnType<typeof candidateOf>>()
  for (const s of chain) {
    if (s.key === currentKey || isExcluded(s, config)) continue
    if (options.only && !options.only.has(s.key)) continue
    if (mode === 'advisory' && options.avoid?.has(s.key)) continue
    const t = tier(s, health[s.key], config, now)
    if (!t) continue
    if (smart) {
      const at = chain.findIndex((x) => x.key === currentKey)
      const index = chain.indexOf(s)
      const c = candidateOf(s, t, strikesOf(health[s.key], now), health[s.key], smart, config, now, {
        chainIndex: config.chain.trim() ? index : 0,
        turn: (index - at - 1 + 2 * chain.length) % chain.length
      })
      // A move that is only advice never goes to an account that is itself about to run out, or
      // that was left for that reason a moment ago.
      if (mode === 'advisory' && (c.avoided || c.assessment.state === 'low')) continue
      candidates.set(s, c)
    }
    tiers.set(s, t)
  }
  if (tiers.size === 0) return null
  let pool = [...tiers.keys()]
  if (mode !== 'manual') {
    // The best tier that has a seat; the strategy only chooses within it.
    const best = Math.min(...pool.map((s) => RANK[tiers.get(s)!]))
    if (mode === 'advisory' && best > RANK.A && !options.sourceExhausted) return null
    pool = pool.filter((s) => RANK[tiers.get(s)!] === best)
    if (best === RANK.B) {
      const fewest = Math.min(...pool.map((s) => strikesOf(health[s.key], now)))
      pool = pool.filter((s) => strikesOf(health[s.key], now) === fewest)
    }
  }
  switch (config.strategy) {
    case 'smart':
      return rank(pool.map((s) => candidates.get(s)!), config)[0]!.seat
    case 'balanced':
      return [...pool].sort((a, b) => load(a) - load(b))[0]!
    case 'soonest-reset':
      // Spend the usage that expires first (Orca PR #42856 / cswap `weekly-first`).
      return [...pool].sort((a, b) => weeklyReset(a) - weeklyReset(b) || load(a) - load(b))[0]!
    case 'priority':
      return pool[0]!
    case 'drain':
    default: {
      // The next seat after the current one in chain order, wrapping around.
      const at = chain.findIndex((s) => s.key === currentKey)
      for (let i = 1; i <= chain.length; i++) {
        const s = chain[(at + i + chain.length) % chain.length]!
        if (pool.includes(s)) return s
      }
      return pool[0]!
    }
  }
}

/**
 * Switch-back: the first usable seat *ahead* of `currentKey` in the chain, when the chain is a
 * priority order (drain, priority) and `switch_back` is on. Null when the current seat is already
 * the best one, or nothing ahead of it qualifies.
 *
 * - `pane`: a running session would be closed and resumed there, so the seat must be known (A) or
 *   presumed reset (B+).
 * - `launch` (default): only the selection for new launches moves, so a seat without numbers and
 *   without strikes (B) also qualifies; selecting it is what makes Orca fetch its usage.
 */
export function preferredOver(
  chain: readonly Seat[],
  currentKey: string | undefined,
  health: Record<string, SeatHealth>,
  config: Config,
  now: number,
  scope: 'pane' | 'launch' = 'launch',
  /** Accounts not to go back to yet: left as Low, or Low now (never set in `custom` mode). */
  avoid?: ReadonlySet<string>
): Seat | null {
  if (!config.switchBack) return null
  if (config.strategy !== 'drain' && config.strategy !== 'priority') return null
  const at = chain.findIndex((s) => s.key === currentKey)
  if (at <= 0) return null
  for (const s of chain.slice(0, at)) {
    if (isExcluded(s, config) || avoid?.has(s.key)) continue
    const t = tier(s, health[s.key], config, now)
    if (t === 'A' || t === 'B+') return s
    if (t === 'B' && scope === 'launch' && strikesOf(health[s.key], now) === 0) return s
  }
  return null
}

/** When the first seat in the chain frees up; null when nothing says. */
export function earliestReset(
  chain: readonly Seat[],
  health: Record<string, SeatHealth>,
  now: number
): number | null {
  let best: number | null = null
  for (const s of chain) {
    const times = [
      health[s.key]?.cooldownUntil,
      s.usage.session && s.usage.session.usedPercent >= 100 ? s.usage.session.resetsAt : null,
      s.usage.weekly && s.usage.weekly.usedPercent >= 100 ? s.usage.weekly.resetsAt : null
    ].filter((t): t is number => typeof t === 'number' && t > now)
    const seatFree = times.length ? Math.max(...times) : null
    if (seatFree !== null && (best === null || seatFree < best)) best = seatFree
  }
  return best
}
