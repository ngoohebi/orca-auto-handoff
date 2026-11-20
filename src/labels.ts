// Account labels as the panel and the console status line show them: when every account of a
// service shares one email domain the domain is dropped (`me`, `system (third)`); otherwise the
// labels stay whole.
import type { Held, Provider, Seat, Snapshot, SwapReason, SwapResult } from './types'

type SeatRow = Snapshot['seats'][number]

/** How each service is named wherever people read it: the panel, the status bar, notifications. */
export const PROVIDER_NAME: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  devin: 'Devin'
}

/** Why nothing is handed off automatically although no service was turned off (`Config.held`), as
 *  the panel's callout says it. Both end by themselves: the worker asks Orca again at every tick
 *  and settings change. */
export const HELD_WORDS: Record<Held, { title: string; body: string }> = {
  settings: {
    title: "Auto Hand-off is waiting for Orca's settings",
    body: 'Orca could not be asked for your settings yet, so nothing is handed off or resumed automatically. It tries again by itself. Hand off to this account still works.'
  },
  upgrade: {
    title: 'Auto Hand-off is finishing the upgrade',
    body: 'Your settings from the earlier version are not carried over yet, so nothing is handed off or resumed automatically. It tries again by itself. Hand off to this account still works.'
  }
}

/** Why a History entry happened, in the words the panel shows (not the stored code). */
export const REASON_WORDS: Record<SwapReason | 'api_error', string> = {
  rate_limit: 'Limit reached',
  threshold: 'Running low',
  switch_back: 'Back to preferred',
  model_cap: 'Model limit',
  expiring: 'Expiring quota',
  idle: 'Idle',
  manual: 'By hand',
  reset: 'Account free again',
  api_error: 'API error',
  auth: 'Sign-in needed'
}

/** What came of it, as the panel's History badge says it. */
export const RESULT_WORDS: Record<SwapResult, string> = {
  resumed: 'resumed',
  handoff: 'new session',
  selected: 'new sessions only',
  waiting: 'waiting',
  failed: 'failed',
  model: 'model changed',
  retried: 'retried',
  closed: 'closed'
}

/** The History badge of one entry. A waiting session that went on in the pane it was in, once its
 *  own account had room again, was not "retried" (that is an API error's word): it stayed. */
export function resultWords(entry: { reason: string; result: SwapResult }): string {
  if (entry.reason === 'reset' && entry.result === 'retried') return 'same account'
  return RESULT_WORDS[entry.result] ?? entry.result
}

/** A time in the words of a clock, local time: `3:00 pm` today, `Thu 3:00 pm` within the week
 *  ahead or behind, else `Nov 27, 3:00 pm`. */
export function clockWords(at: number, now: number): string {
  const d = new Date(at)
  const h = d.getHours()
  const time = `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
  const n = new Date(now)
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return time
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  if (Math.abs(at - now) < 6 * 86_400_000) return `${days[d.getDay()]} ${time}`
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[d.getMonth()]} ${d.getDate()}, ${time}`
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
  const arrived = `${options.selectionOnly ? 'new sessions start on' : 'handed off to'} ${to.label}${level(to)}`
  const source = from?.label ?? 'another account'
  switch (reason) {
    case 'rate_limit':
      return `${source} hit a usage limit; ${arrived}`
    case 'model_cap':
      return `${source} hit its ${options.model ?? 'model'} limit; ${arrived}`
    case 'auth':
      return `${source} needs sign-in; ${arrived}`
    case 'threshold':
      return `${source} is running low${level(from)}; ${arrived}`
    case 'idle':
      return `idle session on ${source}, which is running low${level(from)}; ${arrived}`
    case 'switch_back':
      return `${to.label} is available again${level(to)}; ${options.selectionOnly ? 'new sessions start on it' : `handed off from ${source}`}`
    case 'reset':
      return `a limit has reset; ${options.selectionOnly ? `new sessions start on ${to.label}` : `resumed on ${to.label}`}${level(to)}`
    case 'expiring':
      return `${to.label} has weekly quota that would expire unused${level(to)}; ${options.selectionOnly ? 'new sessions start on it' : `handed off there from ${source}`}`
    case 'manual':
      return `chosen by hand; ${arrived}`
  }
}
