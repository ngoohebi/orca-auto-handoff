// Account labels as the panel and the console status line show them: when every account of a
// service shares one email domain the domain is dropped (`me`, `system (third)`); otherwise the
// labels stay whole.
import type { Provider, Seat, Snapshot, SwapReason } from './types'

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

/** An account's level in a few words: `used 94 % of 5h, 30 % of the week`; '' when unknown. */
export function levelWords(seat: Pick<Seat, 'usage'> | undefined): string {
  if (!seat?.usage.known) return ''
  const parts: string[] = []
  const s = seat.usage.session?.usedPercent
  const w = seat.usage.weekly?.usedPercent
  if (typeof s === 'number') parts.push(`${Math.round(s)} % of 5h`)
  if (typeof w === 'number') parts.push(`${Math.round(w)} % of the week`)
  return parts.length ? `used ${parts.join(', ')}` : ''
}

/** "About N min left" / "about N h left" for a runway; minutes up to an hour and a half. */
export function runwayWords(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'under a minute left at this pace'
  if (minutes <= 90) return `about ${minutes} min left at this pace`
  return `about ${Math.round(minutes / 60)} h left at this pace`
}

type Named = { label: string; usage: Seat['usage'] }

/**
 * Why a session or the selection moved, in one line for the history. `from` is absent when the
 * pane's account was not known. `selectionOnly`: only new launches changed account.
 */
export function whyMove(
  reason: SwapReason,
  from: Named | undefined,
  to: Named,
  options: { selectionOnly?: boolean; model?: string } = {}
): string {
  const level = (seat: Named | undefined) => (levelWords(seat) ? ` (${levelWords(seat)})` : '')
  const arrived = `${options.selectionOnly ? 'new launches use' : 'moved to'} ${to.label}${level(to)}`
  const source = from?.label ?? 'another account'
  switch (reason) {
    case 'rate_limit':
      return `${source} hit a usage limit; ${arrived}`
    case 'model_cap':
      return `${source} hit its ${options.model ?? 'model'} limit; ${arrived}`
    case 'auth':
      return `${source} needs sign-in; ${arrived}`
    case 'threshold':
      return `${source} is over its usage threshold${level(from)}; ${arrived}`
    case 'idle':
      return `idle session on ${source}, which is over its usage threshold${level(from)}; ${arrived}`
    case 'switch_back':
      return `${to.label} is available again${level(to)}; ${options.selectionOnly ? 'new launches use it' : `moved back from ${source}`}`
    case 'reset':
      return `a limit has reset; ${options.selectionOnly ? `new launches use ${to.label}` : `resumed on ${to.label}`}${level(to)}`
    case 'expiring':
      return `${to.label} has weekly quota that would expire unused${level(to)}; ${options.selectionOnly ? 'new launches use it' : `moved there from ${source}`}`
    case 'manual':
      return `chosen by hand; ${arrived}`
  }
}
