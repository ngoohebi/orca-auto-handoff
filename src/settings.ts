// Every setting the panel's Settings tab shows, declared once: the worker checks values against
// it and reads them through `settingValues`, the panel draws its Basic and Advanced sections from
// it, and a test keeps orca-plugin.json's settings in step with it.

export type Choice = { value: string; label: string; help: string }
/** Shown only while another setting has this value (otherwise greyed out, with why). */
type When = { key: string; is: string | readonly string[]; why: string }
type Base = { key: string; title: string; help: string; when?: When }
export type SettingSpec =
  | (Base & { kind: 'choice'; default: string; options: Choice[] })
  | (Base & { kind: 'number'; default: number; min: number; max: number; unit: string })
  | (Base & { kind: 'boolean'; default: boolean })
  | (Base & { kind: 'text'; default: string; placeholder?: string })

export type SettingValue = string | number | boolean
export type SettingValues = Record<string, SettingValue>

const EARLY: When = { key: 'timing', is: 'early', why: 'Only used when When to hand off is Early when away.' }
const HELD: When = { key: 'active_terminal', is: ['ask', 'careful', 'wait'], why: 'Not used when Session on screen is Move right away.' }

/** What counts as you being at Orca, said the same way wherever a setting depends on it. */
const HERE = 'sending or answering a prompt, typing in a waiting session, switching tabs, using the Auto Hand-off panel or one of its commands'
const CAREFUL: When = { key: 'active_terminal', is: ['ask', 'careful'], why: 'Only used when Session on screen is Ask me first or Wait, then count down.' }

/** The few choices most people want to make. */
export const BASIC_SETTINGS: SettingSpec[] = [
  {
    key: 'pick',
    title: 'Pick the next account',
    kind: 'choice',
    default: 'smart',
    help: 'Which account a session is handed off to.',
    options: [
      { value: 'smart', label: 'Auto', help: 'Picks the account with the most room, judged by how fast each one is being used.' },
      { value: 'my-order', label: 'Custom order', help: 'Your ranking, set with the arrows in the Accounts tab. Goes back to a higher account once it is free again.' }
    ]
  },
  {
    key: 'timing',
    title: 'When to hand off',
    kind: 'choice',
    default: 'early',
    help: 'When sessions are handed off to another account.',
    options: [
      { value: 'early', label: 'Early when away', help: 'Once you have been away a while, Claude sessions hand off shortly before an account runs out, so work does not stop at a limit. While you are using Orca, sessions hand off only at a limit. Other services always hand off only at a limit.' },
      { value: 'at-limit', label: 'At limit', help: 'A session hands off only when it hits a limit. Each account is used to the end.' }
    ]
  },
  {
    key: 'when_all_used',
    title: 'When everything is used up',
    kind: 'choice',
    default: 'wait',
    help: 'When no account of the service has room.',
    options: [
      { value: 'wait', label: 'Wait and resume', help: 'The session waits for the first account to reset, then continues by itself.' },
      { value: 'stop', label: 'Stop', help: 'The session stops and you are told.' }
    ]
  },
  {
    key: 'active_terminal',
    title: 'Session on screen',
    kind: 'choice',
    default: 'ask',
    help: 'The session in the tab Orca is showing. You may be reading or typing in it, so it gets extra care.',
    options: [
      { value: 'ask', label: 'Ask me first', help: 'Never handed off early. At a limit the Auto Hand-off panel asks whether to hand it off now. If you do not answer, it waits while you are using Orca, then counts down. Not now: it waits until you switch tabs.' },
      { value: 'careful', label: 'Wait, then count down', help: 'Never handed off early. At a limit it waits while you are using Orca, then hands off after a short countdown that you can cancel.' },
      { value: 'wait', label: 'Wait for me', help: 'Stays until you switch to another tab or press Hand off now.' },
      { value: 'now', label: 'Move right away', help: 'No waiting: it hands off as soon as it is between turns, early hand-offs included, like sessions in other tabs.' }
    ]
  }
]

/** Fine-tuning, folded away in the panel. */
export const ADVANCED_SETTINGS: SettingSpec[] = [
  { key: 'away_minutes', title: "Start early hand-offs after you've been away", kind: 'number', default: 10, min: 0, max: 240, unit: 'min', help: `Early hand-offs start only once there has been no sign of you this long (${HERE}). 0 = always, even while you are here.`, when: EARLY },
  { key: 'early_minutes', title: 'Hand off this long before running out', kind: 'number', default: 10, min: 1, max: 120, unit: 'min', help: 'Hand off when an account would run out within this many minutes at its current pace.', when: EARLY },
  { key: 'early_percent_left', title: 'Always hand off below (% left)', kind: 'number', default: 1, min: 0, max: 50, unit: '%', help: 'Also hand off when less than this much of the 5-hour window is left, however slowly it is being used. 1 % by default: an account at 99 % is left whatever its pace, since one big turn could use the rest. 0 = by pace only.', when: EARLY },
  { key: 'idle_minutes', title: 'Hand off idle sessions after', kind: 'number', default: 15, min: 0, max: 1440, unit: 'min', help: 'A session idle this long is handed off from an account that is about to run out, or to an account whose weekly quota would expire unused. 0 = never: idle sessions stay, and expiring quota is spent only by new sessions.', when: EARLY },
  { key: 'switch_cooldown_minutes', title: 'Minimum time between early hand-offs', kind: 'number', default: 5, min: 0, max: 240, unit: 'min', help: 'Early hand-offs never change the account more often than this. A limit always hands off.' },
  { key: 'active_countdown_seconds', title: 'Countdown for the session on screen', kind: 'number', default: 60, min: 10, max: 3600, unit: 's', help: 'How long the countdown lasts before the session on screen hands off anyway.', when: CAREFUL },
  { key: 'active_presence_seconds', title: 'Keep the session on screen waiting after your last activity', kind: 'number', default: 300, min: 10, max: 3600, unit: 's', help: `You count as using Orca for this long after your last activity (${HERE}).`, when: CAREFUL },
  { key: 'active_reminder_minutes', title: 'Remind me when the session on screen has waited', kind: 'number', default: 10, min: 0, max: 1440, unit: 'min', help: 'One reminder when the session on screen has waited this long to hand off. 0 = none.', when: HELD },
  { key: 'restore_unsent_text', title: 'Put unsent text back after a hand-off', kind: 'boolean', default: true, help: 'Claude: text typed and not sent goes back, unsent, into the session after a hand-off. Off, and for other services: the session waits until the text is sent or cleared. Pasted images or blocks, queued messages, and text over 4,000 characters always wait.' },
  { key: 'auto_message', title: 'First message after a limit', kind: 'text', default: 'Continue.', help: 'Typed into a session whose work was interrupted (a limit or an API error) once it continues, and when a waiting session wakes. Empty = none after a hand-off; an API error retry then types “continue”.' },
  { key: 'max_api_retries', title: 'API error retries', kind: 'number', default: 6, min: 0, max: 50, unit: '', help: 'Retry a turn that failed with a passing API error (overloaded, 5xx) at most this many times in a row, with growing pauses. 0 = never retry.' },
  { key: 'model_fallback', title: 'Model fallback', kind: 'text', default: '', placeholder: 'claude=sonnet,haiku', help: 'At a model limit, when no other account is known to have room for that model, try these models on the same account before handing off. Per service, separated by semicolons.' },
  { key: 'default_cooldown_minutes', title: 'Cooldown when a limit gives no reset time', kind: 'number', default: 60, min: 1, max: 1440, unit: 'min', help: 'How long an account is set aside when its limit message gives no reset time.' },
  { key: 'poll_interval_seconds', title: 'Read usage every', kind: 'number', default: 60, min: 15, max: 3600, unit: 's', help: 'How often usage is read from Orca.' },
  { key: 'handoff_max_chars', title: 'Hand-off summary size', kind: 'number', default: 6000, min: 500, max: 50000, unit: 'chars', help: 'Services that cannot resume (Codex, Antigravity, OpenCode, Devin) start the new session with a summary this long at most. Orca takes at most 4,096 characters, so a larger value changes nothing.' },
  { key: 'orca_cli_path', title: 'Orca CLI path', kind: 'text', default: '', placeholder: 'found automatically', help: 'Only if the orca command is not found by itself.' }
]

/** Shown with the Claude Status line switch in the Accounts tab, while the status line is on. */
export const STATUS_LINE_SETTINGS: SettingSpec[] = [
  { key: 'console_statusline_format', title: 'Status line header', kind: 'text', default: '', placeholder: '{model} │ ctx {ctxbar} │ 5h reset {reset}', help: 'An optional first line of the Claude status line. Empty = account rows only.' }
]

/** Settings with a control of their own elsewhere in the panel, not in the Settings tab:
 *  `exclude` is the "Skip" switch on each account card. */
export const HIDDEN_SETTINGS: SettingSpec[] = [
  { key: 'exclude', title: 'Skipped accounts', kind: 'text', default: '', placeholder: 'claude:work@example.com', help: 'Accounts never chosen automatically, separated by commas: an account (work@example.com), or one of a service (claude:work@example.com).' }
]

export const ALL_SETTINGS: SettingSpec[] = [...BASIC_SETTINGS, ...ADVANCED_SETTINGS, ...STATUS_LINE_SETTINGS, ...HIDDEN_SETTINGS]

/** Every 0.2 setting the upgrade reads. They are no longer declared in orca-plugin.json, and Orca's
 *  `settings.get()` returns declared settings only, so the worker asks for each by name
 *  (`storedSettings`). */
export const LEGACY_KEYS = [
  'mode',
  'strategy',
  'switch_early',
  'running_sessions',
  'auto_swap_idle_after_seconds',
  'auto_switch_on_rate_limit',
  'auto_switch_on_threshold',
  'auto_resume',
  'wait_for_reset',
  'retry_on_api_error'
] as const

/** Does a `when` condition hold for these values? */
export function applies(when: When | undefined, values: Record<string, unknown>): boolean {
  if (!when) return true
  const v = values[when.key]
  return Array.isArray(when.is) ? when.is.includes(v as string) : v === when.is
}

/** A value checked against its spec: the value, or `undefined` when it is not one the setting takes. */
export function checked(spec: SettingSpec, value: unknown): SettingValue | undefined {
  switch (spec.kind) {
    case 'choice':
      return typeof value === 'string' && spec.options.some((o) => o.value === value) ? value : undefined
    case 'number': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
      return typeof n === 'number' && Number.isFinite(n) ? Math.min(spec.max, Math.max(spec.min, Math.round(n))) : undefined
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined
    case 'text':
      return typeof value === 'string' ? value : undefined
  }
}

/** Every shown setting's value, from what Orca stores: a stored value the setting takes, else
 *  the default. */
export function settingValues(stored: Record<string, unknown>): SettingValues {
  const out: SettingValues = {}
  for (const spec of ALL_SETTINGS) out[spec.key] = checked(spec, stored[spec.key]) ?? spec.default
  return out
}

/**
 * The upgrade from 0.2, run once (worker.ts): the new settings an older version's settings stand
 * for, only those that differ from what is stored now. A new setting counts as untouched when it
 * is absent or at its default, because Orca's `settings.get()` reads every declared setting as its
 * default until it is changed. The 0.2 settings themselves must be read by name (`storedSettings`).
 * - Auto-switch `my-order`, or an account order with the old drain or priority strategy where 0.2
 *   ran it (`ranAdvanced`) → Pick the next account: Custom order.
 * - Switch early `at-limit`, Running sessions `limit` or `launches`, or "Switch at usage
 *   threshold" off where 0.2 ran it → When to hand off: At limit.
 * - Switch early `earlier` → Early when away, 25 minutes before.
 * - "Wait for reset" off where 0.2 ran it → When everything is used up: Stop.
 * - "Retry on API errors" off → no retries; the idle time in seconds → minutes.
 */
export function upgradedValues(stored: Record<string, unknown>): Partial<SettingValues> {
  const now = settingValues(stored)
  const out: SettingValues = { ...now }
  const spec = (key: string) => ALL_SETTINGS.find((x) => x.key === key)!
  const unset = (key: string) => stored[key] === undefined || stored[key] === spec(key).default
  if (unset('pick')) {
    const ordered = typeof stored.chain === 'string' && stored.chain.trim() !== ''
    const oldStrategy = stored.strategy === undefined || stored.strategy === 'drain' || stored.strategy === 'priority'
    // (`custom` chosen in 0.2 followed the order with those strategies too.)
    const oldOrder = stored.mode === 'my-order' || (ranAdvanced(stored) && ordered && oldStrategy)
    if (oldOrder) out.pick = 'my-order'
  }
  // (Moving before a limit was turned off: nobody gets early hand-offs back by upgrading.)
  const onlyAtLimit =
    stored.switch_early === 'at-limit' || stored.running_sessions === 'limit' || stored.running_sessions === 'launches' || (ranAdvanced(stored) && stored.auto_switch_on_threshold === false)
  if (unset('timing') && onlyAtLimit) out.timing = 'at-limit'
  // "Earlier" was a choice made on purpose: it stays early, as Early when away, unless running
  // sessions were to move only at a limit (that wins: it is the safer of the two).
  else if (unset('timing') && stored.switch_early === 'earlier') out.timing = 'early'
  if (unset('early_minutes') && stored.switch_early === 'earlier') out.early_minutes = 25
  // "Wait for reset" off, where 0.2 ran it: a session with no account left did not go on by itself.
  if (unset('when_all_used') && ranAdvanced(stored) && stored.wait_for_reset === false) out.when_all_used = 'stop'
  // "Retry on API errors" off (0.2) is now no retries.
  if (unset('max_api_retries') && stored.retry_on_api_error === false) out.max_api_retries = 0
  if (unset('idle_minutes') && typeof stored.auto_swap_idle_after_seconds === 'number' && stored.auto_swap_idle_after_seconds !== 900) {
    // Up to whole minutes, so a short idle time does not become 0 (never).
    out.idle_minutes = Math.min(1440, Math.max(0, Math.ceil(stored.auto_swap_idle_after_seconds / 60)))
  }

  const changed: Partial<SettingValues> = {}
  for (const [key, value] of Object.entries(out)) if (value !== now[key]) changed[key] = value
  return changed
}

/**
 * An older version was set not to hand sessions off by itself:
 * - Auto-switch `manual`; or
 * - with Auto-switch left at `auto` or set to `custom` (0.2 then ran the Advanced settings as
 *   stored): Strategy `manual`, "Switch on rate limit" off, or "Resume automatically" off.
 * Auto-switch `smart` or `my-order` chosen in 0.2 overrode those Advanced settings, so a leftover
 * one does not count.
 */
export function wasManual(stored: Record<string, unknown>): boolean {
  if (stored.mode === 'manual') return true
  if (!ranAdvanced(stored)) return false
  return stored.strategy === 'manual' || stored.auto_switch_on_rate_limit === false || stored.auto_resume === false
}

/** Did 0.2 run its Advanced settings as stored? Not with Auto-switch `smart`, `my-order` or
 *  `manual` chosen: those overrode them. */
function ranAdvanced(stored: Record<string, unknown>): boolean {
  return stored.mode !== 'smart' && stored.mode !== 'my-order' && stored.mode !== 'manual'
}
