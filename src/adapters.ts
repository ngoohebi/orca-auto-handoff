// Per-provider readers of an agent terminal's tail: rate limit, model cap, API error or auth.
// Patterns are deliberately specific (cux / codex-auto lesson): only genuine limit banners in the
// last few lines count, never a conversation that merely mentions "rate limit".
import type { Provider, Signal, SignalKind } from './types'

type Rule = { kind: SignalKind; re: RegExp; model?: (m: RegExpMatchArray) => string | undefined }

export type Adapter = {
  provider: Provider
  /** How the plugin continues a session on another seat of the same provider. */
  resume: 'by-session-id' | 'handoff-only'
  rules: Rule[]
  /** Lines that are the agent's own prose (never a CLI banner), e.g. Claude's `⏺` replies. */
  prose?: RegExp
  /** What a status/error line from the CLI itself looks like. Text that matches a rule but not
   *  this shape (indented prose, quoted output) never counts. */
  banner: RegExp
  /** Text typed to switch model in place, when the agent supports it. */
  modelSwitch?: (model: string) => string
}

/** Error/status markers the agent CLIs put in front of their own messages (Codex `■`,
 *  Antigravity `⚠`, …). Agent prose that merely mentions a limit has none of them. */
const ERROR_MARK = /^\s*(■|⚠|✗|✘|×|❌|⎿|\[?error\]?\b|error:)/i

const CLAUDE: Adapter = {
  provider: 'claude',
  resume: 'by-session-id',
  modelSwitch: (model) => `/model ${model}`,
  prose: /^\s*⏺/,
  // Claude Code prints limits and API errors as `⎿` result lines or unindented system lines;
  // indented lines are the continuation of the agent's own reply.
  banner: /^(\s*⎿|\S)/,
  rules: [
    {
      kind: 'auth',
      re: /(OAuth token (has )?expired|Invalid API key|Please run \/login|authentication_error|not logged in)/i
    },
    {
      kind: 'model_cap',
      re: /\b(opus|sonnet|fable|haiku)\b[^\n]{0,40}\blimit (reached|hit)|reached your (opus|sonnet|fable|haiku) (weekly )?limit/i,
      model: (m) => (m[1] ?? m[3])?.toLowerCase()
    },
    {
      kind: 'rate_limit',
      re: /(usage limit reached|(session|weekly|5-hour|five-hour|usage) limit (reached|hit)|hit your (session |weekly |usage )?limit|out of extra usage|rate_limit_error|limit will reset at)/i
    },
    {
      kind: 'api_error',
      re: /(API Error:? ?(5\d\d|529|overloaded|Connection error|Request timed out|terminated)|overloaded_error|Request timed out\.? Retrying)/i
    }
  ]
}

const CODEX: Adapter = {
  provider: 'codex',
  // Each Orca Codex account keeps its own sessions/ folder, so a session id from one seat may not
  // exist on another. Until a live check proves otherwise the engine hands off instead.
  resume: 'handoff-only',
  modelSwitch: (model) => `/model ${model}`,
  banner: ERROR_MARK,
  rules: [
    { kind: 'auth', re: /(401 Unauthorized|token (has )?expired|please (log|sign) ?in again|codex login)/i },
    {
      kind: 'rate_limit',
      re: /(hit your usage limit|usage limit (reached|exceeded)|rate limit (reached|exceeded)|Add usage credits|insufficient_quota|quota exceeded|exceeded your current quota|429 Too Many Requests)/i
    },
    { kind: 'api_error', re: /(stream disconnected before completion|stream error|Internal server error|5\d\d (Bad Gateway|Service Unavailable))/i }
  ]
}

const ANTIGRAVITY: Adapter = {
  provider: 'antigravity',
  resume: 'handoff-only',
  banner: ERROR_MARK,
  rules: [
    { kind: 'auth', re: /(sign in again|not signed in|unauthenticated)/i },
    { kind: 'rate_limit', re: /(quota reached|quota exceeded|RESOURCE_EXHAUSTED|rate limit (reached|exceeded))/i },
    { kind: 'api_error', re: /(\bUNAVAILABLE\b|\bINTERNAL\b|503 Service Unavailable|[Ss]tream (closed|disconnected))/ }
  ]
}

function generic(provider: Provider): Adapter {
  return {
    provider,
    resume: 'handoff-only',
    banner: ERROR_MARK,
    rules: [
      { kind: 'auth', re: /(401 Unauthorized|authentication (failed|required)|please (log|sign) ?in)/i },
      {
        kind: 'rate_limit',
        re: /(rate limit (reached|exceeded)|usage limit (reached|exceeded)|quota (reached|exceeded)|429 Too Many Requests|insufficient_quota)/i
      },
      { kind: 'api_error', re: /(5\d\d (Bad Gateway|Service Unavailable|Internal Server Error)|overloaded)/i }
    ]
  }
}

export const ADAPTERS: Record<Provider, Adapter> = {
  claude: CLAUDE,
  codex: CODEX,
  antigravity: ANTIGRAVITY,
  opencode: generic('opencode'),
  devin: generic('devin')
}

/** A row of the plugin's own console status line (statusline.ts): `▶ work  5h ███████░  78%  7d …`.
 *  Claude prints one per account under the input box, so they are on every screen read. */
const STATUS_ROW = '[▶·]\\s.*\\s5h\\s+[█░·]{2,}'

/** Lines that are the agent's input box or footer, never a status message. */
export const CHROME = new RegExp(`^\\s*(›|❯|>|✻|⏵|◐|←|\\? for shortcuts|─{6,}|╭|╰|│\\s*>|${STATUS_ROW})`)

/** How many non-empty lines from the bottom count as "the latest output". */
export const TAIL_WINDOW = 14
/** A banner must be among the last lines printed: an agent that stopped on a limit stops there. */
export const MAX_LINES_AFTER = 4

export function classify(provider: Provider, lines: readonly string[], now: number): Signal | null {
  const adapter = ADAPTERS[provider]
  const tail = lines
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '' && !CHROME.test(l))
    .slice(-TAIL_WINDOW)
  // Newest line first: the most recent banner decides.
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail.length - 1 - i > MAX_LINES_AFTER) break
    const line = tail[i]!
    if (adapter.prose?.test(line) || !adapter.banner.test(line)) continue
    for (const rule of adapter.rules) {
      const m = line.match(rule.re)
      if (!m) continue
      const context = tail.slice(i, i + 3).join(' ')
      const signal: Signal = {
        kind: rule.kind,
        line: line.trim().slice(0, 300),
        fingerprint: `${provider}|${rule.kind}|${normalise(line)}`,
        linesAfter: tail.length - 1 - i,
        occurrences: countCopies(lines, line)
      }
      const resetsAt = parseReset(context, now)
      if (resetsAt !== undefined) signal.resetsAt = resetsAt
      const model = rule.model?.(m)
      if (model) signal.model = model
      return signal
    }
  }
  return null
}

/** Input-box placeholders the CLIs show when nothing is typed. */
const PLACEHOLDER = /^(ask (codex|claude|antigravity|opencode|devin) (to do )?anything|try ["“]|type (a|your) (message|prompt)|what (can|should) i|send a message)/i
/** What may follow the input box: its frame and the CLI footer, never a reply. */
const FOOTER = new RegExp(`^\\s*(╰|─{3,}|│\\s*$|←|⏵|\\? for shortcuts|\\S[^\\n]*·|${STATUS_ROW})`)

/**
 * Unsent text in the agent's input box (Orca issue #41488: an automatic restart threw away a
 * prompt the user was typing). The input line must be the last content on screen: a submitted
 * prompt looks the same but has a reply under it.
 */
export function hasDraft(lines: readonly string[]): boolean {
  return draftOf(lines) !== null
}

/** The unsent text `hasDraft` sees in the input box, or null when the box is empty. */
export function draftOf(lines: readonly string[]): string | null {
  const content = lines.map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '')
  const at = content.map((l) => /^\s*(│\s*)?(›|❯|>)(\s|$)/.test(l)).lastIndexOf(true)
  if (at < 0 || !content.slice(at + 1).every((l) => FOOTER.test(l))) return null
  const text = content[at]!
    .replace(/^\s*(│\s*)?(›|❯|>)\s?/, '')
    .replace(/│\s*$/, '')
    .trim()
  return text.length > 0 && !PLACEHOLDER.test(text) ? text : null
}

/** Fixed lines Claude Code itself shows in an empty input box, which Orca reports as `draft`
 *  like typed text (Orca 1.4.263). Only wordings seen as a whole draft belong here. */
export const CLAUDE_HINTS: readonly string[] = ['Press up to edit queued messages']

/** Is this draft one of Claude Code's own fixed hints, and so not text the user typed? The whole
 *  text must be the hint (after trimming): typing that only contains or resembles one is a draft. */
export function isClaudeHint(text: string): boolean {
  return CLAUDE_HINTS.includes(text.trim())
}

export function normalise(line: string): string {
  return line.trim().replace(/\s+/g, ' ').slice(0, 200)
}

/** Copies of `line` in a terminal read. */
export function countCopies(lines: readonly string[], line: string): number {
  const want = normalise(line)
  return lines.filter((l) => normalise(l) === want).length
}

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 }

/**
 * Reads when a limit lifts from a banner. Handles:
 * - durations: "Resets in 135h42m31s", "try again in 2 days 3 hours", "resets in 45 min"
 * - epoch suffixes: "Claude AI usage limit reached|1717000000"
 * - clock times: "resets 3pm", "reset at 10:29 AM (Europe/Berlin)", "try again at 3:14 PM"
 *   (local time, the next occurrence).
 */
export function parseReset(text: string, now: number): number | undefined {
  const epoch = text.match(/\|(\d{10})(\d{3})?\b/)
  if (epoch) return Number(epoch[1]) * 1000

  const dur = text.match(/(?:resets?|try again|available again|retry)\s+in\s+([0-9a-z ,]+)/i)
  if (dur) {
    let total = 0
    const re = /(\d+)\s*(d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)(?![a-z])/gi
    for (const part of dur[1]!.matchAll(re)) {
      total += Number(part[1]) * (UNIT_MS[part[2]![0]!.toLowerCase()] ?? 0)
    }
    if (total > 0) return now + total
  }

  // "resets Mon 9am" (weekly and model caps): the next such weekday.
  const day = text.match(
    /(?:resets?(?:\s+on)?|try again on|available again on)\s+(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i
  )
  if (day) {
    const want = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(day[1]!.toLowerCase())
    let hour = Number(day[2])
    const minute = day[3] ? Number(day[3]) : 0
    const ampm = day[4]?.toLowerCase()
    if (ampm === 'pm' && hour < 12) hour += 12
    if (ampm === 'am' && hour === 12) hour = 0
    if (hour > 23 || minute > 59) return undefined
    const at = new Date(now)
    at.setHours(hour, minute, 0, 0)
    let add = (want - at.getDay() + 7) % 7
    if (add === 0 && at.getTime() <= now) add = 7
    at.setDate(at.getDate() + add)
    return at.getTime()
  }

  const clock = text.match(
    /(?:resets?(?:\s+at)?|try again at|available again at|limit will reset at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i
  )
  if (clock) {
    let hour = Number(clock[1])
    const minute = clock[2] ? Number(clock[2]) : 0
    const ampm = clock[3]?.toLowerCase()
    if (ampm === 'pm' && hour < 12) hour += 12
    if (ampm === 'am' && hour === 12) hour = 0
    if (hour > 23 || minute > 59) return undefined
    const at = new Date(now)
    at.setHours(hour, minute, 0, 0)
    if (at.getTime() <= now) at.setDate(at.getDate() + 1)
    return at.getTime()
  }
  return undefined
}

/** `claude=sonnet,haiku; codex=gpt-5-mini` → { claude: ['sonnet','haiku'], codex: [...] } */
export function parseModelFallback(text: string): Partial<Record<Provider, string[]>> {
  const out: Partial<Record<Provider, string[]>> = {}
  for (const part of text.split(';')) {
    const [name, list] = part.split('=')
    const provider = name?.trim() as Provider
    if (!provider || !list || !(provider in ADAPTERS)) continue
    out[provider] = list
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return out
}
