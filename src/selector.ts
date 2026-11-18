// Which seat comes next: the chain, eligibility, strategies, switch-back, earliest reset.
import type { Config, Provider, Seat, SeatHealth } from './types'

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

/** Lower is better; unknown usage sits in the middle so known-empty seats win. */
export function load(seat: Seat): number {
  if (!seat.usage.known) return 50
  return Math.max(seat.usage.weekly?.usedPercent ?? 0, (seat.usage.session?.usedPercent ?? 0) / 2)
}

/**
 * Hysteresis for advisory (threshold) moves: with both usages known, the target must have at
 * least `minHeadroomGap` points more room, so two seats near the line never ping-pong. An
 * exhausted seat (100 %) may always leave.
 */
export function enoughGap(from: Seat | undefined, to: Seat, config: Config): boolean {
  if (!from || !from.usage.known || !to.usage.known) return true
  const worst = Math.max(from.usage.session?.usedPercent ?? 0, from.usage.weekly?.usedPercent ?? 0)
  if (worst >= 100) return true
  return load(from) - load(to) >= config.minHeadroomGap
}

/** When a seat's weekly window resets; Infinity when unknown (sorted last). */
function weeklyReset(seat: Seat): number {
  return seat.usage.weekly?.resetsAt ?? Number.POSITIVE_INFINITY
}

export function pickNext(
  chain: readonly Seat[],
  currentKey: string | undefined,
  health: Record<string, SeatHealth>,
  config: Config,
  now: number
): Seat | null {
  if (config.strategy === 'manual') return null
  const candidates = chain.filter(
    (s) => s.key !== currentKey && !isExcluded(s, config) && isEligible(s, health[s.key], config, now)
  )
  if (candidates.length === 0) return null
  const pool = candidates
  switch (config.strategy) {
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
 * Switch-back: the first healthy seat *ahead* of `currentKey` in the chain, when the chain is a
 * priority order (drain, priority) and `switch_back` is on. Null when the current seat is already
 * the best one, or nothing ahead of it is healthy. A seat whose usage Orca has not measured yet
 * (an inactive Claude account) counts as healthy once its cooldown is over, as everywhere else.
 */
export function preferredOver(
  chain: readonly Seat[],
  currentKey: string | undefined,
  health: Record<string, SeatHealth>,
  config: Config,
  now: number
): Seat | null {
  if (!config.switchBack) return null
  if (config.strategy !== 'drain' && config.strategy !== 'priority') return null
  const at = chain.findIndex((s) => s.key === currentKey)
  if (at <= 0) return null
  for (const s of chain.slice(0, at)) {
    if (!isExcluded(s, config) && isEligible(s, health[s.key], config, now)) return s
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
