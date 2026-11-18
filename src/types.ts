// Shared domain types. Plain JSON so everything here can live in orca.storage.

export const PROVIDERS = ['claude', 'codex', 'antigravity', 'opencode', 'devin'] as const
export type Provider = (typeof PROVIDERS)[number]

export function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value)
}

/** One usage window as Orca reports it (`rateLimits.<provider>.session|weekly`). */
export type UsageWindow = { usedPercent: number; resetsAt: number | null }

export type SeatUsage = {
  /** False when Orca has no numbers for this seat (e.g. an inactive Claude account). */
  known: boolean
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

export type SeenSignal = { fingerprint: string; occurrences: number }

export type SeatHealth = {
  cooldownUntil?: number
  reason?: string
}

export type SwapReason = 'rate_limit' | 'threshold' | 'auth' | 'manual' | 'reset' | 'model_cap'
export type SwapResult =
  | 'resumed'
  | 'handoff'
  | 'retried'
  | 'model'
  | 'waiting'
  | 'failed'
  | 'selected'

export type HistoryEntry = {
  at: number
  terminalId?: string
  provider: Provider
  from?: string
  to?: string
  reason: SwapReason | 'api_error'
  result: SwapResult
  detail?: string
}

/** A session parked until a seat frees up (every seat exhausted, wait_for_reset on). */
export type WaitingEntry = {
  terminalId: string
  workspaceId: string
  agent: Provider
  sessionId?: string
  fromSeat?: string
  wakeAt: number
}

export type Config = {
  thresholdFiveHour: number
  thresholdSevenDay: number
  strategy: 'drain' | 'balanced' | 'priority' | 'manual'
  autoSwitchOnThreshold: boolean
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
  handoffMaxChars: number
  orcaCliPath: string
  /** Automatic switching per service; a service that is off is never touched automatically. */
  services: Record<Provider, boolean>
}

export function allServices(on: boolean): Record<Provider, boolean> {
  return { claude: on, codex: on, antigravity: on, opencode: on, devin: on }
}

export const DEFAULT_CONFIG: Config = {
  thresholdFiveHour: 100,
  thresholdSevenDay: 100,
  strategy: 'drain',
  autoSwitchOnThreshold: true,
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
  handoffMaxChars: 6000,
  orcaCliPath: '',
  services: allServices(true)
}

/** Everything the worker persists, under one storage key. */
export type RotatorState = {
  paused: boolean
  health: Record<string, SeatHealth>
  /** Which seat each agent terminal runs on, as far as the plugin knows. */
  paneSeat: Record<string, string>
  /** Last signal fingerprint handled per terminal (dedupe). */
  seen: Record<string, SeenSignal>
  apiRetries: Record<string, number>
  modelStep: Record<string, number>
  waiting: WaitingEntry[]
  history: HistoryEntry[]
}

export const HISTORY_CAP = 1000

export function emptyState(): RotatorState {
  return {
    paused: false,
    health: {},
    paneSeat: {},
    seen: {},
    apiRetries: {},
    modelStep: {},
    waiting: [],
    history: []
  }
}

/** What the panel and status bar show. */
export type Snapshot = {
  paused: boolean
  updatedAt: number
  seats: (Seat & { cooldownUntil?: number; cooldownReason?: string })[]
  waiting: WaitingEntry[]
  history: HistoryEntry[]
  /** Which services switch automatically. */
  services: Record<Provider, boolean>
  error?: string
}
