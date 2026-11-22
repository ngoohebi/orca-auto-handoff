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
  /** Readings supplied by a pane or an independently verified provider profile. */
  origin?: 'pane' | 'claude-profile' | 'codex-profile' | 'antigravity-profile' | 'opencode-profile' | 'devin-profile'
  reason?: UsageReason
  /** Orca's own message for the reason, shortened. */
  detail?: string
  /** When Orca retries a rate-limited fetch. */
  retryAt?: number
  session?: UsageWindow
  weekly?: UsageWindow
  /** Provider monthly cap, currently exposed by OpenCode Go. */
  monthly?: UsageWindow
  /** A model-specific weekly bucket (Claude `fableWeekly`, ...). */
  model?: UsageWindow & { name: string }
  /** Codex `account/rateLimits/read`: false when ordinary work is blocked even if Spark/other buckets show 0 %. */
  ordinaryUsageAllowed?: boolean
  rateLimitReachedType?: string
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
  /** Direct quota check failure, kept separately from the displayed fallback reading. */
  directQuotaIssue?: { reason: UsageReason | 'native-sign-in-required'; retryAt: number }
  /** Why a direct check cannot serve this account, in a few words (`directQuotaUnavailable`). */
  quotaUnavailable?: string
  /** The direct check was turned off for this account by hand; it stays off. */
  quotaOff?: boolean
  /** Which per-pane live files describe this account (live-usage.ts): its Claude profile id,
   *  `system` for Claude's own login, or both when a managed account is that same login. Local
   *  Claude accounts only; never part of a snapshot. */
  liveKeys?: string[]
  /** Managed CODEX_HOME directory for live `codex app-server` probing; never serialized in snapshots. */
  codexHome?: string
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
  /** Banners handled before this one in the same session (newest last, at most 12). A resumed
   *  session redraws its whole transcript, and while it does, an older banner can briefly be the
   *  newest on screen (live, Orca 1.4.263): it is not a new limit. */
  earlier?: { fingerprint: string; occurrences: number; line?: string }[]
}

export type CircuitState = 'closed' | 'open' | 'half_open'

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
  /** Formal 3-state circuit breaker: closed (healthy), open (cooling), half_open (probing recovery). */
  circuit?: CircuitState
  /** Consecutive failures/limits since the last clean turn or manual clear. */
  consecutiveFailures?: number
}

/** An API-key or third-party relay provider routed by `oah proxy`. */
export type ProxyProvider = {
  id: string
  kind: 'anthropic' | 'openai'
  name: string
  baseUrl: string
  apiKey: string
  priority: number
  enabled: boolean
  modelMap?: Record<string, string>
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
  /** Text the user had typed and not sent, which went with the session and could not be put
   *  back (the hand-off failed, or the new session's input box was not free): kept here in full
   *  so it is never lost. The panel shows it with the entry, to copy. */
  unsent?: string
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
  /** With `draftAt`: held because Orca could not say whether the pane is between turns with an
   *  empty input box, not because text was seen there. */
  unchecked?: boolean
  /** With `draftAt`: what is there is Claude's hint for queued messages (sent, waiting in the
   *  session), not text being typed. */
  queued?: boolean
  /** The limit whose move waits for that text (absent for a wait for a reset). */
  reason?: SwapReason
  /** Held because the pane is in the terminal tab the user is on (`Config.activeTerminal`): since
   *  when. Every tick looks again; the pane moves once that tab is no longer the one shown, or
   *  once the countdown below runs out with no sign of the user. */
  activeSince?: number
  /** The countdown before an active pane is moved anyway: started at `countdownFrom`, moves at
   *  `countdownUntil`. Absent while the user shows signs of being there. */
  countdownFrom?: number
  countdownUntil?: number
  /** The user pressed *Hand off now*: the hold is over. */
  forceAt?: number
  /** Hand-offs of this session that failed before its pane was closed (the account could not be
   *  selected, the new session not started): another account is tried, a few times at most. */
  failures?: number
  /** The one reminder for a long hold was given. */
  reminded?: boolean
  /** "Ask me first": the panel asks whether to move it now. */
  asked?: boolean
  /** The user answered *Not now*: it waits for another tab to be shown, with no countdown. */
  declined?: boolean
  /** This hold already said that a countdown runs, and that the session was not handed off:
   *  each is said at most once per hold, however often the user comes and goes. */
  toldCountdown?: boolean
  toldHeld?: boolean
}

/** How the plugin picks the next account (the `pick` setting). */
export type Mode = 'smart' | 'my-order'

export type Config = {
  /** `smart` (Auto): forecast and rank (smart.ts). `my-order` (Custom order): the account order,
   *  with the same early leave. */
  mode: Mode
  /** A seat counts as Low when it would run out within this many minutes at its current pace.
   *  0 = no forecast. */
  horizonMinutes: number
  /** Without a pace, a seat is Low from this much use of its 5-hour window (100 = never)… */
  lowFiveHour: number
  /** …or of its weekly window. */
  lowSevenDay: number
  /** A seat is Low from this much use of its 5-hour window whatever its pace (100 = never). */
  floorFiveHour: number
  /** `move`: sessions move when idle or between turns. `limit`: only at a limit. */
  runningSessions: 'move' | 'limit'
  /** `smart` for Auto, `drain` (the account order) for Custom order. */
  strategy: 'drain' | 'smart'
  autoSwitchOnThreshold: boolean
  /** Go back to an earlier seat in the chain once it is healthy again (Custom order). */
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
  /** The session on screen (the pane in the terminal tab the user is on). `ask`: as `careful`,
   *  and the panel asks first. `careful`: only a limit moves it, after a countdown with no sign
   *  of the user. `wait`: it waits until the tab is left or the user says so. `now`: moved like
   *  any other pane. */
  activeTerminal: 'ask' | 'careful' | 'wait' | 'now'
  /** `careful`: how long the countdown before an active pane moves anyway lasts. */
  countdownSeconds: number
  /** Typing, a tab switch or using the panel counts as the user being there for this long. */
  presenceSeconds: number
  /** One reminder when an active pane has been held this long; 0 = none. */
  reminderMinutes: number
  /** Put plain unsent text from the input box back into the moved session's input box. */
  restoreUnsent: boolean
  /** "Early when away": early moves start only this long after the last sign of the user; 0 = always. */
  awayMinutes: number
  /** How per-model weekly caps (e.g. Claude Fable) are handled: fallback-model, rotate, or ignore. */
  modelWindowPolicy: 'fallback-model' | 'rotate' | 'ignore'
  /** Per-workspace or per-terminal explicit account pins (`workspaceId|terminalId` -> `seatKey`). */
  pins: Record<string, string>
  quotaLinks: string[]
  /** Live quota: ask each saved account's provider for its usage directly (the `direct_quota`
   *  setting). Off: usage comes from Orca only, and no direct check is made. */
  directQuota: boolean
  /** Set while the settings cannot be trusted, so every service counts as off whatever was chosen
   *  (worker.ts `configReader`): `settings` = Orca could not be asked for them yet, `upgrade` = the
   *  settings of an older version are not carried over yet. The panel says so. */
  held?: Held
}

/** Why every service counts as off although none was turned off (`Config.held`). */
export type Held = 'settings' | 'upgrade'

export function allServices(on: boolean): Record<Provider, boolean> {
  return { claude: on, codex: on, antigravity: on, opencode: on, devin: on }
}

/** The base every config is built on (worker.ts `configFrom` sets every field the settings
 *  cover; a fresh install runs Auto with Early when away). Tests start from it, or from
 *  `SMART_CONFIG` for Auto with the early-move thresholds. */
export const DEFAULT_CONFIG: Config = {
  mode: 'my-order',
  horizonMinutes: 0,
  lowFiveHour: 100,
  lowSevenDay: 100,
  floorFiveHour: 100,
  runningSessions: 'move',
  strategy: 'drain',
  autoSwitchOnThreshold: true,
  switchBack: true,
  switchCooldownMinutes: 5,
  minHeadroomGap: 10,
  autoSwapIdleAfterSeconds: 900,
  autoMessage: 'Continue.',
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
  services: allServices(true),
  activeTerminal: 'ask',
  countdownSeconds: 60,
  presenceSeconds: 300,
  reminderMinutes: 10,
  restoreUnsent: true,
  awayMinutes: 10,
  modelWindowPolicy: 'fallback-model',
  pins: {},
  quotaLinks: [],
  directQuota: true
}

/** Auto (`pick: smart`) with the thresholds of Early when away, for tests. */
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
   *  user made with the next-account command, the move command or the panel's switch. */
  lastAutoSwitchAt?: Record<string, number>
  probation?: Record<string, Probation>
  /** Seats left as Low (smart.ts anti-flap), by seat key. */
  leftLow?: Record<string, LeftLow>
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

/** What the panel and the Claude console status line show. */
export type Snapshot = {
  paused: boolean
  updatedAt: number
  seats: (Seat & {
    quotaLinked?: boolean
    cooldownUntil?: number
    cooldownReason?: string
    /** How long until the first window is used up at the current pace (usage-history.ts); absent
     *  when the pace is unknown. Observed only: nothing switches on it yet. */
    runwayMs?: number
    /** Circuit breaker state for this seat (`closed` | `open` | `half_open`). */
    circuit?: CircuitState
  })[]
  waiting: WaitingEntry[]
  history: HistoryEntry[]
  /** Which services hand off automatically. */
  services: Record<Provider, boolean>
  /** Every service counts as off for now, and why (`Config.held`): nobody turned them off. */
  held?: Held
  /** How the plugin picks the next account. */
  mode?: Mode
  /** When to hand off is "At limit" (only at a limit). */
  atLimitOnly?: boolean
  /** "Early when away" is chosen, and the user is at Orca: sessions move only at a limit for now. */
  userHere?: boolean
  /** Session on screen, as set (the panel words its waiting lines by it). */
  activeTerminal?: Config['activeTerminal']
  /** Custom order: each service's accounts in that order, by seat key. */
  order?: Partial<Record<Provider, string[]>>
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
