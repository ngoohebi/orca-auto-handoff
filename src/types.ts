// Shared domain types. Plain JSON so everything here can live in orca.storage.

export const PROVIDERS = ['claude', 'codex', 'antigravity', 'opencode', 'devin'] as const
export type Provider = (typeof PROVIDERS)[number]

export function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value)
}

/** One usage window as Orca reports it (`rateLimits.<provider>.session|weekly`). */
export type UsageWindow = {
  usedPercent: number
  resetsAt: number | null
  /** A remembered window whose reset time has passed: shown as 0 %, "reset since". */
  reset?: true
}

/** Why Orca has no live numbers for an account right now. */
export type UsageReason = 'stale-token' | 'rate-limited' | 'sign-in' | 'fetching' | 'not-reported' | 'no-usage-api' | 'error'

export type SeatUsage = {
  /** True when the plugin has numbers to go by: Orca's live ones, or a recent remembered reading. */
  known: boolean
  /** live: Orca reports it now; cached: the last reading Orca gave; projected: a cached reading with
   *  a window reset since; unknown: nothing usable. */
  source?: 'live' | 'cached' | 'projected' | 'unknown'
  /** When the numbers were taken. */
  asOf?: number
  /** Set when the numbers come from a pane's status line (live-usage.ts), not from Orca. */
  origin?: 'pane'
  reason?: UsageReason
  /** Orca's own message for the reason, shortened. */
  detail?: string
  /** When Orca retries a rate-limited fetch. */
  retryAt?: number
  session?: UsageWindow
  weekly?: UsageWindow
  /** A model-specific weekly bucket (Claude `fableWeekly`, ...). */
  model?: UsageWindow & { name: string }
  updatedAt?: number
}

/** One account Orca manages, or the provider's own `system` login. */
export type Seat = {
  /** `${provider}:${accountId}`; accountId is `system` for the provider's own login. */
  key: string
  provider: Provider
  accountId: string
  label: string
  active: boolean
  usage: SeatUsage
  /** Which per-pane live files describe this account (live-usage.ts): its Claude profile id,
   *  `system` for Claude's own login, or both when a managed account is that same login. Local
   *  Claude accounts only; never part of a snapshot. */
  liveKeys?: string[]
}

export type SignalKind = 'rate_limit' | 'model_cap' | 'api_error' | 'auth'

/** What an adapter read in a terminal tail. */
export type Signal = {
  kind: SignalKind
  /** The line that matched, trimmed. */
  line: string
  /** Epoch ms when the limit lifts, if the message said. */
  resetsAt?: number
  /** For model_cap: which model family hit its cap. */
  model?: string
  /** Stable id of the banner text. */
  fingerprint: string
  /** Non-empty lines printed after the banner. */
  linesAfter: number
  /** Copies of this exact banner anywhere in the read output. A new limit adds a copy; a resumed
   *  session redrawing its old transcript, or a repeated status event, does not. */
  occurrences: number
}

export type SeenSignal = {
  fingerprint: string
  occurrences: number
  /** The banner text, to recount copies as it scrolls away. */
  line?: string
}

/** Per-seat state. Every field is optional: entries stored by older versions hold only
 *  `cooldownUntil` and `reason`. */
export type SeatHealth = {
  cooldownUntil?: number
  reason?: string
  /** Limit banners this seat showed while the plugin had no usage numbers for it (or right after
   *  an automatic move onto it without numbers). Counted for 24 h after `strikeAt`. */
  strikes?: number
  /** When the last strike happened. */
  strikeAt?: number
  /** The current or last cooldown ends at a real reset time (from the banner or Orca's numbers),
   *  not at a guessed one. */
  resetKnown?: boolean
  /** When the last cooldown expired. */
  freedAt?: number
}

/** How long a strike counts, and how long an expired cooldown is remembered. */
export const STRIKE_TTL_MS = 24 * 3_600_000
/** The longest guessed cooldown for a seat without usage numbers. */
export const BLIND_COOLDOWN_CAP_MINUTES = 300

/** After an automatic move onto a seat without usage numbers: until `until`, no advisory move or
 *  switch-back for that provider, and a limit banner on `key` counts as a strike. */
export type Probation = { key: string; until: number }

export type SwapReason = 'rate_limit' | 'threshold' | 'auth' | 'manual' | 'reset' | 'model_cap' | 'switch_back' | 'idle' | 'expiring'
export type SwapResult =
  | 'resumed'
  | 'handoff'
  | 'retried'
  | 'model'
  | 'waiting'
  | 'failed'
  | 'selected'
  /** A waiting session whose pane the user closed: dropped, not resumed. */
  | 'closed'

export type HistoryEntry = {
  at: number
  terminalId?: string
  provider: Provider
  from?: string
  to?: string
  reason: SwapReason | 'api_error'
  result: SwapResult
  detail?: string
  /** Why it happened, in one line a person can read ("work is over its usage threshold (used
   *  97 % of 5h); moved to personal (used 12 % of 5h)"). Entries from older versions have none. */
  why?: string
}

/** A session parked until a seat frees up (every seat exhausted, wait_for_reset on). */
export type WaitingEntry = {
  terminalId: string
  workspaceId: string
  agent: Provider
  /** Orca's own agent id when it differs from the provider (e.g. `opencode2`). */
  agentId?: string
  sessionId?: string
  fromSeat?: string
  wakeAt: number
  /** Remote Orca server (`environmentId` from `runtime:<environmentId>`) when the workspace is not on `local`. */
  server?: string
  /** `short`: the session waits for its own account to reset (a few minutes) and is only woken
   *  at `wakeAt`, not as soon as another account has room. */
  hold?: 'short'
  /** Waiting for this model's bucket: woken at `wakeAt`, or once an account is known to have room
   *  in that bucket. */
  model?: string
  /** The move found unsent text in the pane's input box: the pane is not closed, the user was
   *  told (at this time), and every tick looks again until the text is gone. */
  draftAt?: number
  /** The limit whose move waits for that text (absent for a wait for a reset). */
  reason?: SwapReason
}

/** How the plugin decides (the `mode` setting, with `auto` resolved; see `resolveSettings`). */
export type Mode = 'smart' | 'my-order' | 'manual' | 'custom'

export type Config = {
  /** `smart`: forecast and rank (smart.ts). `my-order`: the account order, with the same early
   *  leave. `manual`: never automatically. `custom`: the legacy settings exactly as stored. */
  mode: Mode
  /** A seat counts as Low when it would run out within this many minutes at its current pace.
   *  0 = no forecast. */
  horizonMinutes: number
  /** Without a pace, a seat is Low from this much use of its 5-hour window (100 = never)… */
  lowFiveHour: number
  /** …or of its weekly window. */
  lowSevenDay: number
  /** `move`: sessions move when idle or between turns. `limit`: only at a limit. `launches`:
   *  running sessions are never moved; only new launches change account. */
  runningSessions: 'move' | 'limit' | 'launches'
  /** Set when `auto` kept the earlier settings as `custom`: the panel says so once. */
  notice?: string
  thresholdFiveHour: number
  thresholdSevenDay: number
  /** `smart` is never stored: it is what `mode: smart` resolves to. */
  strategy: 'drain' | 'balanced' | 'priority' | 'soonest-reset' | 'manual' | 'smart'
  autoSwitchOnThreshold: boolean
  /** Go back to an earlier seat in the chain once it is healthy again (drain, priority). */
  switchBack: boolean
  /** Minimum time between automatic selection changes of one provider (threshold, switch-back,
   *  idle moves); hard limits ignore it. */
  switchCooldownMinutes: number
  /** A threshold move needs a target with at least this many points more room (when known). */
  minHeadroomGap: number
  /** Move a session that has been idle this long off an over-threshold seat, or back to the
   *  preferred seat. 0 = off. */
  autoSwapIdleAfterSeconds: number
  /** Comma-separated seats never switched *to* automatically (same tokens as `chain`). */
  exclude: string
  autoSwitchOnRateLimit: boolean
  autoResume: boolean
  autoMessage: string
  waitForReset: boolean
  retryOnApiError: boolean
  maxApiRetries: number
  /** Comma-separated chain: seat keys, emails, or `provider:*`. Empty = every seat of the provider. */
  chain: string
  /** Comma-separated per provider, e.g. `claude=sonnet,haiku; codex=gpt-5-mini`. */
  modelFallback: string
  defaultCooldownMinutes: number
  pollIntervalSeconds: number
  /** How long a remembered reading stays usable; 0 turns the cache off. */
  usageCacheMaxAgeHours: number
  handoffMaxChars: number
  orcaCliPath: string
  /** Automatic hand-off per service; a service that is off is never touched automatically. */
  services: Record<Provider, boolean>
}

export function allServices(on: boolean): Record<Provider, boolean> {
  return { claude: on, codex: on, antigravity: on, opencode: on, devin: on }
}

/** The legacy settings at their defaults, as `custom` mode reads them. What a fresh install runs
 *  is `SMART_CONFIG`. */
export const DEFAULT_CONFIG: Config = {
  mode: 'custom',
  horizonMinutes: 0,
  lowFiveHour: 100,
  lowSevenDay: 100,
  runningSessions: 'move',
  thresholdFiveHour: 100,
  thresholdSevenDay: 100,
  strategy: 'drain',
  autoSwitchOnThreshold: true,
  switchBack: true,
  switchCooldownMinutes: 5,
  minHeadroomGap: 10,
  autoSwapIdleAfterSeconds: 900,
  exclude: '',
  autoSwitchOnRateLimit: true,
  autoResume: true,
  autoMessage: 'Go continue.',
  waitForReset: true,
  retryOnApiError: true,
  maxApiRetries: 6,
  chain: '',
  modelFallback: '',
  defaultCooldownMinutes: 60,
  pollIntervalSeconds: 60,
  usageCacheMaxAgeHours: 168,
  handoffMaxChars: 6000,
  orcaCliPath: '',
  services: allServices(true)
}

/** What a fresh install runs: Smart, "just before the limit". */
export const SMART_CONFIG: Config = {
  ...DEFAULT_CONFIG,
  mode: 'smart',
  strategy: 'smart',
  switchBack: false,
  horizonMinutes: 10,
  lowFiveHour: 97,
  lowSevenDay: 99
}

/** A seat left because it was running Low: not a target again until `until` (the end of its
 *  5-hour window), unless a reading newer than `at` shows the window has started over. */
export type LeftLow = { at: number; until: number; used?: number }

/** Everything the worker persists, under one storage key. */
export type RotatorState = {
  paused: boolean
  /** By seat key for this computer's accounts, and by `<server>|<seat key>` for a paired server's
   *  (engine.ts `scopedKey`); `leftLow` likewise, `lastAutoSwitchAt` and `probation` by provider. */
  health: Record<string, SeatHealth>
  /** Which seat each agent terminal runs on, as far as the plugin knows. */
  paneSeat: Record<string, string>
  /** Last signal fingerprint handled per terminal (dedupe). */
  seen: Record<string, SeenSignal>
  apiRetries: Record<string, number>
  modelStep: Record<string, number>
  waiting: WaitingEntry[]
  history: HistoryEntry[]
  /** Last selection change per provider (for the switch cooldown): the plugin's own, or one the
   *  user made with the next-account command or the panel's switch. */
  lastAutoSwitchAt?: Record<string, number>
  probation?: Record<string, Probation>
  /** Seats left as Low (smart.ts anti-flap), by seat key. */
  leftLow?: Record<string, LeftLow>
  /** The one-time note about `custom` mode has been dismissed. */
  customNoticeSeen?: boolean
}

export const HISTORY_CAP = 1000
/** Swap history older than this is dropped automatically. */
export const HISTORY_MAX_AGE_MS = 7 * 86_400_000

export function emptyState(): RotatorState {
  return {
    paused: false,
    health: {},
    paneSeat: {},
    seen: {},
    apiRetries: {},
    modelStep: {},
    waiting: [],
    history: [],
    lastAutoSwitchAt: {},
    probation: {},
    leftLow: {}
  }
}

/** What the panel and status bar show. */
export type Snapshot = {
  paused: boolean
  updatedAt: number
  seats: (Seat & {
    cooldownUntil?: number
    cooldownReason?: string
    /** How long until the first window is used up at the current pace (usage-history.ts); absent
     *  when the pace is unknown. Observed only: nothing switches on it yet. */
    runwayMs?: number
  })[]
  waiting: WaitingEntry[]
  history: HistoryEntry[]
  /** Which services switch automatically. */
  services: Record<Provider, boolean>
  /** How the plugin decides right now (`auto` resolved). */
  mode?: Mode
  /** A one-time note for the panel (settings carried over as `custom`), until dismissed. */
  notice?: string
  /** The service of the agent the user is working with: the most recently active agent in the
   *  focused workspace. The panel lists that service first. */
  focused?: Provider
  /** Remote Orca server (`environmentId`) when the focused project runs on another server. */
  server?: string
  /** SSH target when the focused project runs on a direct SSH host. Orca manages no accounts
   *  there, so the seats shown do not apply to it and its panes are never switched. */
  sshHost?: string
  error?: string
}
