// Account labels as the panel and the console status line show them: when every account of a
// service shares one email domain the domain is dropped (`me`, `system (third)`); otherwise the
// labels stay whole.
import type { Provider, Seat, Snapshot } from './types'

type SeatRow = Snapshot['seats'][number]

/** How each service is named wherever people read it: the panel, the status bar, notifications. */
export const PROVIDER_NAME: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  devin: 'Devin'
}

/** The email in a label: `me@x.y` or `system (me@x.y)`. */
const emailOf = (label: string) => label.match(/([^\s()]+)@([^\s()]+)/)

export function displayLabels(seats: Pick<Seat, 'key' | 'provider' | 'label'>[], provider: Provider): Map<string, string> {
  const rows = seats.filter((s) => s.provider === provider)
  const domains = new Set(rows.map((s) => emailOf(s.label)?.[2]?.toLowerCase()).filter((d): d is string => !!d))
  const strip = domains.size === 1
  return new Map(rows.map((s) => [s.key, strip ? s.label.replace(/@[^\s()]+/, '') : s.label]))
}

/** Percent left of a usage window, whole and clamped to 0..100; `undefined` when unknown. */
export function percentLeft(usedPercent: number | undefined): number | undefined {
  if (typeof usedPercent !== 'number') return undefined
  return Math.min(100, Math.max(0, Math.floor(100 - usedPercent)))
}

/** The least headroom across an account's windows. */
export function minLeft(seat: Pick<SeatRow, 'usage'>): number | undefined {
  const lefts = [seat.usage.session, seat.usage.weekly, seat.usage.model]
    .map((w) => percentLeft(w?.usedPercent))
    .filter((n): n is number => n !== undefined)
  return lefts.length ? Math.min(...lefts) : undefined
}

/** Accounts of a service as the panel and the console status line list them: the one in use
 *  first, then the usable ones with the most headroom first (unknown usage last among them),
 *  then the limited (cooling down) and drained (10 % or less left) ones, also by headroom. */
export function seatOrder(now: number) {
  const rank = (seat: Pick<SeatRow, 'active' | 'usage' | 'cooldownUntil'>) => {
    if (seat.active) return 0
    if (seat.cooldownUntil && seat.cooldownUntil > now) return 2
    const left = minLeft(seat)
    return left !== undefined && left <= 10 ? 2 : 1
  }
  return (a: Pick<SeatRow, 'active' | 'usage' | 'cooldownUntil'>, b: Pick<SeatRow, 'active' | 'usage' | 'cooldownUntil'>) => {
    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank
    const la = minLeft(a)
    const lb = minLeft(b)
    if (la === lb) return 0
    if (la === undefined) return 1
    if (lb === undefined) return -1
    return lb - la
  }
}
