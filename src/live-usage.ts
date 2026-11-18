// Per-pane live usage. Orca polls usage only for the selected account, so an account that runs in
// a pane but is not selected has no numbers there. Claude Code gives every pane's status line its
// own account's limits; the console status line wrapper (statusline.ts) leaves them in
// `~/.orca/account-rotator/live/claude-<key>.tsv`, and the worker reads that file here. `<key>` is
// the profile id in the pane's CLAUDE_CONFIG_DIR, or `system` for Claude's own login.
//
// One line, tab-separated: `1  written (epoch s)  5h used %  5h reset (epoch s)  7d used %  7d reset`,
// `-` for a value the pane did not have. The file holds numbers only: no names, emails or tokens.
import type { UsageWindow } from './types'

/** What a live key may look like; anything else never becomes a file name. */
export const LIVE_KEY = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/
/** A pane reading this recent counts as live, like Orca's own numbers. */
export const LIVE_FRESH_MS = 10 * 60_000
/** A stamp further ahead of the clock than this is not believed. */
const MAX_FUTURE_MS = 5 * 60_000

export type LiveReading = {
  /** When the wrapper wrote it. */
  asOf: number
  session?: UsageWindow
  weekly?: UsageWindow
}

export const liveFileName = (liveKey: string) => `claude-${liveKey}.tsv`

/** The live key of a Claude profile home (`…/claude-profiles/<id>/home`), as the wrapper derives
 *  it from CLAUDE_CONFIG_DIR. Only the id is kept; the path itself is never stored. */
export function liveKeyOfHome(home: unknown): string | undefined {
  if (typeof home !== 'string') return undefined
  const m = home.replace(/\\/g, '/').match(/\/claude-profiles\/([^/]+)\//)
  return m?.[1] && LIVE_KEY.test(m[1]) ? m[1] : undefined
}

const NUMBER = /^\d+(\.\d+)?$/

function field(text: string | undefined): number | null | undefined {
  if (text === undefined || text === '-') return null
  return NUMBER.test(text) ? Number(text) : undefined
}

/**
 * Parses a live file. `null` when it is not a reading to trust: another version, a malformed
 * field, a percentage outside 0–100, no percentage at all, or a stamp more than 5 min ahead.
 * A window whose reset time has passed has reset since the pane last heard from Claude: 0 %.
 */
export function parseLive(text: string | null | undefined, now: number): LiveReading | null {
  if (!text) return null
  const line = text.split('\n')[0]!.replace(/\r$/, '')
  const parts = line.split('\t')
  if (parts.length !== 6 || parts[0] !== '1') return null
  const [stamp, sUsed, sReset, wUsed, wReset] = parts.slice(1).map(field)
  if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp <= 0) return null
  if ([sUsed, sReset, wUsed, wReset].some((v) => v === undefined)) return null
  const asOf = Math.round(stamp * 1000)
  if (asOf > now + MAX_FUTURE_MS) return null
  const window = (used: number | null | undefined, reset: number | null | undefined): UsageWindow | undefined | null => {
    if (typeof used !== 'number') return undefined
    if (used < 0 || used > 100) return null
    const resetsAt = typeof reset === 'number' && reset > 0 ? Math.round(reset * 1000) : null
    if (resetsAt !== null && resetsAt <= now) return { usedPercent: 0, resetsAt: null, reset: true }
    return { usedPercent: used, resetsAt }
  }
  const session = window(sUsed, sReset)
  const weekly = window(wUsed, wReset)
  if (session === null || weekly === null) return null
  if (!session && !weekly) return null
  const reading: LiveReading = { asOf }
  if (session) reading.session = session
  if (weekly) reading.weekly = weekly
  return reading
}
