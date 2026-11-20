// The rotator: reacts to agent status, classifies the terminal tail, and swaps seats.
// Every side effect goes through Deps so tests run it with a fake host, CLI and clock.
import { ADAPTERS, CHROME, classify, countCopies, draftOf, isClaudeHint, parseModelFallback } from './adapters'
import { parseAccounts, type AccountView } from './accounts'
import { HELD_WORDS, PROVIDER_NAME, clockWords, displayLabels, whyMove } from './labels'
import { parseLive } from './live-usage'
import { emptyUsageCache, loadedUsageCache, observe, observeLive, resolve, type UsageCache } from './usage-cache'
import { addSample, emptyUsageSamples, loadedUsageSamples, pruneSamples, runwayMs, type SeatSamples, type UsageSamples } from './usage-history'
import {
  assess,
  betterExpiring,
  candidateOf,
  expiring,
  explain,
  projectedRunwayMs,
  shortWait,
  shouldLeave,
  type Assessment,
  type SmartContext
} from './smart'
import {
  blindCooldownMs,
  buildChain,
  earliestReset,
  enoughGap,
  exhausted,
  isEligible,
  isExcluded,
  namesAny,
  pickNext,
  preferredOver,
  strikesOf,
  tier
} from './selector'
import {
  HISTORY_CAP,
  HISTORY_MAX_AGE_MS,
  PROVIDERS,
  STRIKE_TTL_MS,
  allServices,
  emptyState,
  isProvider,
  type Config,
  type Held,
  type HistoryEntry,
  type Mode,
  type Provider,
  type RotatorState,
  type Seat,
  type SeatHealth,
  type SeenSignal,
  type Signal,
  type Snapshot,
  type SwapReason,
  type WaitingEntry
} from './types'

export type HostLike = { call(method: string, params?: unknown): Promise<any> }

export type Cli = {
  /** `orca account list --json` → its `result` (on `server` when the project runs on a remote Orca server). */
  listAccounts(server?: string): Promise<Record<string, any>>
  select(provider: Provider, accountId: string, server?: string): Promise<void>
  /** `orca terminal close`, which also closes terminals outside the focused workspace. */
  closeTerminal(terminalId: string, server?: string): Promise<void>
  /** `orca terminal send --enter`, which also reaches terminals outside the focused workspace. */
  sendText(terminalId: string, text: string, server?: string): Promise<void>
  /** `orca terminal send` without `--enter`: the text is written to the pane as it is. */
  typeText?(terminalId: string, text: string, server?: string): Promise<void>
  git(cwd: string, args: string[]): Promise<string>
  /** The terminals in the active tab of every workspace (`orca terminal list
   *  --include-visual-layouts`); the host API does not say which pane is focused. */
  activeTerminals?(server?: string): Promise<string[]>
  /** Every terminal on screen in the active tab of every workspace: as `activeTerminals`, with
   *  the other panes of a split tab too. They are in front of the user as much as the pane with
   *  the cursor, so they get the care of the session on screen. */
  visibleTerminals?(server?: string): Promise<string[]>
  /** Resolves a workspace's host (`runtime:<env>` or `local`) from the desktop's paired-server
   *  catalog when local `workspace.list` / `project.list` does not carry the paired server's rows. */
  workspaceServer?(workspaceId?: string): Promise<string | undefined>
  /** The text typed in a pane's input box and not sent, as Orca reports it (`draft` of `orca
   *  terminal read --json`); `''` when Orca answered and reports none. It throws when the read
   *  fails or times out, and gives `undefined` when the answer is not usable: either way nobody
   *  knows what the box holds, and the pane is treated as possibly holding unsent text. */
  draft(terminalId: string, server?: string): Promise<string | undefined>
}

export type Deps = {
  host: HostLike
  cli: Cli
  now(): number
  sleep(ms: number): Promise<void>
  loadState(): Promise<RotatorState | null>
  saveState(state: RotatorState): Promise<void>
  config(): Promise<Config>
  log(message: string): void
  notify(title: string, body: string): Promise<void>
  publish(snapshot: Snapshot): void
  /** The persisted last-known usage cache (storage key `usage`). */
  loadUsage(): Promise<unknown>
  saveUsage(cache: UsageCache): Promise<void>
  /** The text of a pane's live usage file for this key (`live/claude-<key>.tsv`, written by the
   *  console status line wrapper), or `null` when there is none. Read-only. */
  readLive(liveKey: string): Promise<string | null>
  /** The persisted usage history (storage key `usage-samples`; see usage-history.ts). */
  loadSamples(): Promise<unknown>
  saveSamples(samples: UsageSamples): Promise<void>
}

/** What the plugin knows about one agent pane. */
export type PaneInfo = {
  terminalId: string
  workspaceId: string
  agent: Provider
  /** Orca's own agent id when it differs from the provider (e.g. `opencode2`). */
  agentId?: string
  sessionId?: string
  title?: string
  /** Remote Orca server (`environmentId` from `runtime:<environmentId>`) when the workspace is not on `local`. */
  server?: string
  /** Direct SSH target (`ssh:<target>`) the workspace runs on. Agents there use that machine's
   *  own login: Orca manages no accounts for it, so the plugin never switches such a pane. */
  sshHost?: string
}

export type StatusEvent = {
  workspaceId: string | null
  workspaceListId?: string
  terminalId?: string
  title?: string
  state: 'working' | 'blocked' | 'waiting' | 'done'
  receivedAt: number
  mainAgent?: { state: string; outcome?: string; stateStartedAt: number }
  sessionId?: string
}

/** Orca agent ids that share a provider's accounts. */
export function providerOf(agent: string | null | undefined): Provider | null {
  if (!agent) return null
  if (agent === 'opencode2') return 'opencode'
  return isProvider(agent) ? agent : null
}

/** A pane's row in `agents.list`: by its terminal id, else (Orca 1.4.263 lists a pane that was
 *  started in the background and never shown with `terminalId: null`) by its session id. */
export function rowOf(agents: readonly any[], pane: { terminalId: string; sessionId?: string }): any {
  return agents.find((a) => a.terminalId === pane.terminalId) ?? (pane.sessionId ? agents.find((a) => !a.terminalId && a.sessionId === pane.sessionId) : undefined)
}

/** How long a seat that failed to switch is skipped. */
const FAILED_SWITCH_SKIP_MS = 10 * 60_000
/** How many hand-offs of one session at a limit may fail before its wait ends (see `moveTo`). */
const MAX_HANDOFF_FAILURES = 3
/** The shortest probation after an automatic move onto a seat without usage numbers. */
const MIN_PROBATION_MS = 10 * 60_000
/** A turn that ends this soon after a strike was probably answered before the limit hit. */
const STRIKE_SETTLE_MS = 60_000
/** The length of the 5-hour window, when a reading does not say when it ends. */
const FIVE_HOURS_MS = 5 * 3_600_000
/** A model's bucket counts as having room with at least this many points left. */
const MODEL_ROOM_LEFT = 10
/** What is remembered per pane is looked over at most this often… */
const PANE_PRUNE_EVERY_MS = 10 * 60_000
/** …and a pane's entries go once Orca has not listed the pane for this long. */
const PANE_GONE_MS = 30 * 60_000
/** The most entries each per-pane map keeps. */
const PANE_MAP_CAP = 500

/** Said with every automatic change of the selected account: Orca then shows its own prompt
 *  offering to restart the running sessions, which the user can ignore. */
export function restartNote(config: Config, provider: Provider): string {
  // Only a session that resumes as itself is handed off early; the other services wait for a limit.
  const early = config.runningSessions === 'move' && ADAPTERS[provider].resume === 'by-session-id'
  return `Orca may now offer to restart your running sessions: you do not need to. They keep working on the account they are on${early ? ', and Auto Hand-off hands each one off by itself between turns or when it is idle' : ''}.`
}

/** "45 s", "2 min" */
function secondsWords(seconds: number): string {
  return seconds < 120 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`
}

/** A turn that starts this soon after the plugin typed into the pane is the plugin's doing. */
const TYPED_TURN_MS = 60_000

/** "At limit": the settings with every early move off; only a limit moves a session. */
function atTheLimit(config: Config): Config {
  return {
    ...config,
    horizonMinutes: 0,
    lowFiveHour: 100,
    lowSevenDay: 100,
    floorFiveHour: 100,
    runningSessions: 'limit',
    autoSwitchOnThreshold: false,
    autoSwapIdleAfterSeconds: 0
  }
}

/** How long apart the input box is read twice before a pane is closed: a change is typing. */
const SETTLE_MS = 1000
/** After the first message, how long before unsent text is put back, so it is not part of it. */
const PASTE_AFTER_MESSAGE_MS = 1500

function minutesWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  return `${minutes} min`
}

/** A new cooldown for a seat: strikes that still count are kept, everything else starts over. */
function cooled(prev: SeatHealth | undefined, now: number, until: number, reason: string): SeatHealth {
  const next: SeatHealth = { cooldownUntil: until, reason: reason.slice(0, 200) }
  const strikes = strikesOf(prev, now)
  if (strikes > 0) {
    next.strikes = strikes
    next.strikeAt = prev!.strikeAt!
  }
  return next
}

export function backoffMs(attempt: number): number {
  let a = 1
  let b = 1
  for (let i = 0; i < attempt; i++) [a, b] = [b, a + b]
  return Math.min(a * 5000, 120_000)
}

/** Turns an Orca `hostId` (`local`, `ssh:…`, `runtime:<encodedEnv>`) into the remote Orca server's
 *  `environmentId`, or `undefined` when accounts belong to this computer's local Orca runtime. */
export function parseServer(hostId: string | null | undefined): string | undefined {
  const raw = hostId?.trim()
  if (!raw || raw === 'local' || raw === 'all' || raw === 'runtime:unresolved-owner' || raw.startsWith('ssh:')) {
    return undefined
  }
  if (raw.startsWith('runtime:')) {
    const encoded = raw.slice('runtime:'.length)
    if (!encoded || encoded.includes('|')) return undefined
    try {
      const decoded = decodeURIComponent(encoded).trim()
      return decoded && decoded !== 'unresolved-owner' ? decoded : undefined
    } catch {
      return undefined
    }
  }
  return raw
}

/** The SSH target id of an `ssh:<encodedTarget>` host; undefined for any other host. */
export function parseSshTarget(hostId: string | null | undefined): string | undefined {
  const raw = hostId?.trim()
  if (!raw || !raw.startsWith('ssh:')) return undefined
  const encoded = raw.slice('ssh:'.length)
  if (!encoded) return undefined
  try {
    return decodeURIComponent(encoded).trim() || undefined
  } catch {
    return undefined
  }
}

function hostFromWorkspaceIdentity(id: string | null | undefined): string | undefined {
  if (!id) return undefined
  const m = id.match(/^(?:identity:)?wt2:([^:]+):/)
  if (!m?.[1]) return undefined
  try {
    return decodeURIComponent(m[1])
  } catch {
    return undefined
  }
}

type ServerView = { view: AccountView; at: number; error?: string }

/** Orca could not say what a pane's input box holds. Never taken for an empty box: whatever
 *  would close the pane or type into it treats it as unsent text. */
const UNCHECKED: unique symbol = Symbol('unchecked')
type Unsent = string | null | typeof UNCHECKED

/** Said wherever a move did not happen because Orca could not be asked about the pane. */
const NOT_CHECKED = 'Orca could not be asked whether the session is between turns with an empty input box'
/** Why a hand-off did not happen, as the panel's *Hand off now* says it. */
const BUSY = 'The session is working, so it was not handed off.'
const CHANGING = 'You are typing in this session, so it was not handed off.'
const GONE = 'The session was closed.'
const cannotGo = (service: string) => `${service}: the session has unsent text that cannot go along, so it was not handed off. Send or clear it first.`

/** Claude's hint for queued messages, which Orca reports as the input box's text: messages
 *  already sent, waiting in the session for its turn to end. */
const QUEUED = /press up to edit queued messages/i

/** What Orca's host API takes (1.4.263, its own schemas): a notification's body, and a text sent to
 *  a terminal or given to a new agent as its first message. Anything longer is refused whole. */
export const ORCA_NOTE_MAX = 1000
export const ORCA_TEXT_MAX = 4096
/** The longest unsent text that goes with a session (`carriable`): one put back with a single
 *  send Orca takes (the paste marks around it included), and small enough to keep in History. */
export const MAX_CARRY_CHARS = 4000

/** What Orca keeps and carries (1.4.263): one stored value is at most 256 KB, one message to the
 *  panel 64 KB. Past the first every save would fail, and with it everything that saves before
 *  it acts; past the second the panel would no longer be told anything. Both are stayed well under. */
const STATE_MAX_BYTES = 200_000
const SNAPSHOT_HISTORY_BYTES = 36_000
/** The size of a value as JSON in UTF-8, near enough (a character outside ASCII counted as three bytes). */
function jsonBytes(value: unknown): number {
  const json = JSON.stringify(value) ?? ''
  return json.length + 2 * (json.match(/[^\u0000-\u007f]/g)?.length ?? 0)
}

/** `text` cut to `max` characters, never in the middle of one (an emoji is two code units). */
function cut(text: string, max: number): string {
  if (text.length <= max) return text
  let kept = text.slice(0, max - 1)
  if (/[\ud800-\udbff]$/.test(kept)) kept = kept.slice(0, -1)
  return `${kept}…`
}

/** Unsent text quoted in a notification: its first 300 characters when it could not be put back
 *  (the whole of it is kept in History, to copy from the panel; Orca shows no notification over
 *  1000 characters, and the rest of the notice has to fit too), shortened to 80 when it was. */
function fullQuote(text: string): string {
  return cut(text, 300)
}
function shortQuote(text: string): string {
  return cut(text, 80)
}

/** The stored key of what is remembered per account or per service (`health`, `leftLow`,
 *  `lastAutoSwitchAt`, `probation`): the bare key on this computer, as it always was, and
 *  `<server>|<key>` on a paired server, whose accounts are other accounts under the same keys. */
export function scopedKey(server: string | undefined, key: string): string {
  return server ? `${server}|${key}` : key
}

export class Rotator {
  state: RotatorState = emptyState()
  private view: AccountView | null = null
  private viewAt = 0
  private viewError: string | undefined
  private views = new Map<string, ServerView>()
  private locks = new Map<Provider, Promise<unknown>>()
  private inflight = new Set<string>()
  /** Services with automatic hand-off on (from settings). */
  services: Record<Provider, boolean> = allServices(true)
  /** How the plugin picks the next account (from settings). */
  mode: Mode | undefined
  /** Why every service counts as off for now, when nobody turned them off (`Config.held`). */
  held: Held | undefined
  /** The last few status events, for `rotator.debug`. */
  recentEvents: StatusEvent[] = []
  /** See `Snapshot.focused`. */
  focused: Provider | undefined
  /** Remote Orca server (`environmentId`) of the currently focused project/workspace, or `undefined` for `local`. */
  server: string | undefined
  /** SSH target of the focused project when it runs on a direct SSH host (see `PaneInfo.sshHost`). */
  sshHost: string | undefined

  /** Last-known usage per account; see usage-cache.ts. */
  private usage: UsageCache = emptyUsageCache()
  /** Recent readings per account, for the pace of use; see usage-history.ts. Local accounts only. */
  private samples: UsageSamples = emptyUsageSamples()
  /** When each provider's active account last changed, so a stale reading is not misattributed. */
  private activeSince: Partial<Record<Provider, number>> = {}
  /** One `orca account list` at a time per server: the timer, the panel and commands share the
   *  one in flight (~3 s). */
  private listings = new Map<string, Promise<AccountView>>()
  private followUp = 0
  private disposed = false
  /** Moves (and anything else under a provider's lock) running or queued right now. */
  private locked = 0
  /** Panes the plugin itself is closing or moving right now. */
  private moving = new Set<string>()
  /** When the user last showed signs of being at Orca: a tab or workspace switch, typing seen in a
   *  held pane's input box, or using the panel (`notePresence`). Orca says nothing else about it. */
  private presenceAt = 0
  /** The focused workspace and the pane shown in it, as last read: a change is a sign of the user. */
  private lastScene: string | undefined
  /** The panes shown on screen (the focused workspace's active tab), as the last focus read
   *  found them; undefined until one has, or when it could not say. */
  private shownNow: Set<string> | undefined
  /** The input box of each held active pane, as last read: a change is typing. */
  private boxes = new Map<string, string>()
  /** Each agent pane's last state, and when the plugin last typed into a pane: a turn that starts
   *  after the pane was between turns, and not after the plugin typed, is the user sending a prompt. */
  private paneStates = new Map<string, string>()
  private typedAt = new Map<string, number>()
  /** Panes on a remote Orca server: this computer's listing may not carry them. */
  private remotePanes = new Set<string>()
  /** Since when a remembered pane has been missing from `agents.list` (see `prunePanes`). */
  private absentSince = new Map<string, number>()
  private panesPrunedAt = 0
  /** The last status event of each pane whose turn ended while Orca could not say where its
   *  workspace runs (`describe`): the pane was left alone then, and no further event comes from a
   *  session that sits at a limit, so the tick looks at it again (`look`). A newer event of the
   *  pane takes its place. */
  private unplaced = new Map<string, StatusEvent>()

  constructor(private deps: Deps) {
    // Every account switch the plugin makes goes through here: note it, and read usage again
    // shortly after, because a switch is what makes Orca fetch its inactive accounts.
    const select = deps.cli.select.bind(deps.cli)
    this.deps = {
      ...deps,
      // Orca refuses a notification over its size whole, and nothing would be said at all.
      notify: (title: string, body: string) => deps.notify(title, cut(body, ORCA_NOTE_MAX)),
      cli: {
        ...deps.cli,
        select: async (provider: Provider, accountId: string, server?: string) => {
          if (server) return select(provider, accountId, server)
          await select(provider, accountId)
          this.activeSince[provider] = this.deps.now()
          this.readAfterSwitch()
        }
      }
    }
  }

  async init(): Promise<void> {
    // Starting up: the user is taken to be here, so "Early when away" begins by waiting.
    this.presenceAt = this.deps.now()
    const saved = await this.deps.loadState()
    this.state = { ...emptyState(), ...(saved && typeof saved === 'object' ? saved : {}) }
    // What an older version stored loads as it is (every newer field is optional). A part that is
    // not what it should be starts empty rather than stop the worker, and a waiting entry that
    // cannot be looked at (no pane, no service the plugin knows) is dropped.
    const fresh = emptyState()
    const st = this.state as unknown as Record<string, unknown>
    for (const k of ['health', 'paneSeat', 'seen', 'apiRetries', 'modelStep', 'lastAutoSwitchAt', 'probation', 'leftLow'] as const) {
      if (!st[k] || typeof st[k] !== 'object' || Array.isArray(st[k])) st[k] = fresh[k]
    }
    // Likewise one entry that is not a record where the others are (the tick reads each of them).
    for (const k of ['health', 'seen', 'probation', 'leftLow'] as const) {
      const map = st[k] as Record<string, unknown>
      for (const [key, value] of Object.entries(map)) if (!value || typeof value !== 'object' || Array.isArray(value)) delete map[key]
    }
    this.state.paused = this.state.paused === true
    this.state.history = Array.isArray(this.state.history) ? this.state.history.filter((h) => h && typeof h.at === 'number' && isProvider(h.provider)) : []
    this.state.waiting = Array.isArray(this.state.waiting)
      ? this.state.waiting.filter((w) => w && typeof w.terminalId === 'string' && typeof w.workspaceId === 'string' && isProvider(w.agent) && typeof w.wakeAt === 'number')
      : []
    if (this.pruneHistory()) await this.deps.saveState(this.state)
    this.usage = loadedUsageCache(await this.deps.loadUsage().catch(() => null))
    this.samples = loadedUsageSamples(await this.deps.loadSamples().catch(() => null))
    await this.refreshServices(false)
  }

  /** Stops background follow-up reads (worker deactivation). */
  dispose(): void {
    this.disposed = true
  }

  /** Orca fetches inactive accounts right after a switch, at most once a minute: read at +8 s and
   *  again after its throttle (+70 s). A newer switch supersedes the pending reads. */
  private readAfterSwitch(): void {
    const generation = ++this.followUp
    void (async () => {
      for (const wait of [8_000, 62_000]) {
        await this.deps.sleep(wait)
        if (this.disposed || generation !== this.followUp) return
        await this.accounts(true)
        this.publishNow()
      }
    })().catch((error) => this.deps.log(`usage read after switch failed: ${String((error as Error)?.message ?? error)}`))
  }

  async refreshServices(publish = true): Promise<void> {
    this.noteConfig(await this.config())
    if (publish) this.publishNow()
  }

  /** Keeps what the panel shows of the settings: the services and the mode. */
  private noteConfig(config: Config): void {
    this.services = { ...config.services }
    this.mode = config.mode
    this.held = config.held
    // The style chosen, not the one in effect: "Early when away" stays that while the user is here.
    const chosen = this.chosenConfig ?? config
    this.atLimitOnly = chosen.runningSessions === 'limit'
    this.lastConfig = config
  }

  /** The settings as chosen, last read (`config`). */
  private chosenConfig: Config | undefined

  /** The settings in effect. "Early when away" (early moves) holds back while the user shows signs
   *  of being at Orca and for `awayMinutes` after the last one: then only a limit moves a session,
   *  as with "At limit". */
  private async config(): Promise<Config> {
    const chosen = await this.deps.config()
    this.chosenConfig = chosen
    return this.userHere(chosen) ? atTheLimit(chosen) : chosen
  }

  /** "Early when away" is chosen and the user is (or was within `awayMinutes`) at Orca. */
  private userHere(config: Config): boolean {
    return config.runningSessions === 'move' && config.awayMinutes > 0 && this.deps.now() - this.presenceAt < config.awayMinutes * 60_000
  }

  /** "When to hand off: At limit", for the panel. */
  private atLimitOnly = false
  /** The settings last read (the order the panel's arrows show follows them). */
  private lastConfig: Config | undefined

  /** Keeps the last 7 days of history (and at most HISTORY_CAP entries). True when it dropped any. */
  private pruneHistory(): boolean {
    const cutoff = this.deps.now() - HISTORY_MAX_AGE_MS
    const before = this.state.history.length
    this.state.history = this.state.history.filter((h) => h.at >= cutoff).slice(-HISTORY_CAP)
    return this.state.history.length !== before
  }

  private async save(): Promise<void> {
    this.pruneHistory()
    const seenKeys = Object.keys(this.state.seen)
    if (seenKeys.length > 500) {
      for (const k of seenKeys.slice(0, seenKeys.length - 500)) delete this.state.seen[k]
    }
    for (const map of [this.state.paneSeat, this.state.apiRetries, this.state.modelStep] as Record<string, unknown>[]) {
      const keys = Object.keys(map)
      for (const k of keys.slice(0, Math.max(0, keys.length - PANE_MAP_CAP))) delete map[k]
    }
    this.fitState()
    await this.deps.saveState(this.state)
  }

  /** Keeps the state within what Orca stores as one value (`STATE_MAX_BYTES`): the older half of
   *  the History goes first, as often as it takes (the last 20 entries stay), then the older half
   *  of the banners remembered per session. An entry that keeps unsent text (`unsent`: the only
   *  copy there is) stays through both, and goes only when nothing else is left to give way.
   *  Only a state that has grown for months gets here. */
  private fitState(): void {
    const over = () => jsonBytes(this.state) > STATE_MAX_BYTES
    if (!over()) return
    while (over()) {
      const plain = this.state.history.filter((h) => !h.unsent).length
      let drop = plain - Math.max(20, Math.floor(plain / 2))
      if (drop <= 0) break
      // (Oldest first: the History is in the order it was written.)
      this.state.history = this.state.history.filter((h) => !!h.unsent || drop-- <= 0)
    }
    let keys = Object.keys(this.state.seen)
    while (keys.length > 20 && over()) {
      for (const k of keys.slice(0, Math.ceil(keys.length / 2))) delete this.state.seen[k]
      keys = Object.keys(this.state.seen)
    }
    while (this.state.history.length > 20 && over()) {
      this.state.history = this.state.history.slice(-Math.max(20, Math.floor(this.state.history.length / 2)))
    }
    this.deps.log(`the stored state was trimmed to ${jsonBytes(this.state)} bytes (older History and remembered banners)`)
  }

  private record(entry: Omit<HistoryEntry, 'at'>): HistoryEntry {
    const stored: HistoryEntry = { at: this.deps.now(), ...entry }
    this.state.history.push(stored)
    return stored
  }

  /** The one-line reason for a move, with accounts named as the panel names them. */
  private why(reason: SwapReason, from: Seat | undefined, to: Seat, view: AccountView, options: { selectionOnly?: boolean; model?: string } = {}): string {
    const labels = displayLabels(view.seats, to.provider)
    const named = (seat: Seat) => ({ label: labels.get(seat.key) ?? seat.label, usage: seat.usage })
    return whyMove(reason, from ? named(from) : undefined, named(to), options).slice(0, 240)
  }

  /** The one-line reason for a Smart move (smart.ts `explain`), with the same names. */
  private explained(
    kind: 'low' | 'out' | 'expiring',
    from: Seat | undefined,
    to: Seat,
    view: AccountView,
    options: { selectionOnly?: boolean; idle?: boolean; assessment?: Assessment } = {}
  ): string {
    const labels = displayLabels(view.seats, to.provider)
    const named = (seat: Seat) => ({ label: labels.get(seat.key) ?? seat.label, usage: seat.usage })
    const source = from ? { ...named(from), ...(options.assessment ? { assessment: options.assessment } : {}) } : undefined
    return explain(kind, source, named(to), this.deps.now(), options).slice(0, 240)
  }

  // ---- smart: what the engine knows beyond the accounts -----------------------------------

  /** Usage history covers this computer's accounts only. */
  private samplesOn(server: string | undefined): Readonly<Record<string, SeatSamples>> {
    return server ? {} : this.samples.seats
  }

  private recentOf(seat: Seat, server: string | undefined) {
    return this.samplesOn(server)[seat.key]?.recent ?? []
  }

  /** What is remembered about one account of `server`. */
  private healthOf(seatKey: string, server: string | undefined): SeatHealth | undefined {
    return this.state.health[scopedKey(server, seatKey)]
  }

  /** The health of `server`'s accounts by seat key, as selector.ts reads it. This computer's is
   *  the stored map itself (a paired server's entries carry a prefix no seat key has). */
  private healthOn(server: string | undefined): Record<string, SeatHealth> {
    if (!server) return this.state.health
    const prefix = scopedKey(server, '')
    const own: Record<string, SeatHealth> = {}
    for (const [key, h] of Object.entries(this.state.health)) if (key.startsWith(prefix)) own[key.slice(prefix.length)] = h
    return own
  }

  private leaving(seat: Seat, server: string | undefined, config: Config, now: number) {
    return shouldLeave(seat, this.healthOf(seat.key, server), this.recentOf(seat, server), config, now)
  }

  /** Accounts a move that is only advice must not go to: left as Low within their 5-hour window,
   *  or Low right now. */
  private avoided(provider: Provider, view: AccountView, server: string | undefined, config: Config, now: number): Set<string> {
    const avoid = new Set<string>()
    for (const seat of view.seats) {
      if (seat.provider !== provider) continue
      const left = this.state.leftLow?.[scopedKey(server, seat.key)]
      if (left && left.until > now) avoid.add(seat.key)
      else if (assess(seat, this.healthOf(seat.key, server), this.recentOf(seat, server), config, now).state === 'low') avoid.add(seat.key)
    }
    return avoid
  }

  /** How many sessions run on each account of this service on `server` now (`agents.list` per
   *  workspace, placed by `paneSeat`). Empty when Orca cannot say. `busyOnly` counts only sessions
   *  in the middle of a turn. */
  private async paneCounts(provider: Provider, view: AccountView, server: string | undefined, busyOnly = false): Promise<Record<string, number>> {
    const counts: Record<string, number> = {}
    try {
      const { workspaces } = await this.deps.host.call('workspace.list')
      const seen = new Set<string>()
      for (const ws of workspaces as { id: string; hostId?: string | null }[]) {
        // A session on another server, or on an SSH target, runs on other accounts.
        if ((parseServer(ws.hostId) ?? (await this.serverOfWorkspace(ws.id))) !== server) continue
        if (await this.sshTargetOfWorkspace(ws.id)) continue
        const { agents } = await this.deps.host.call('agents.list', { workspaceId: ws.id }).catch(() => ({ agents: [] as any[] }))
        for (const row of agents) {
          if (!row.terminalId || seen.has(row.terminalId) || providerOf(row.agent) !== provider) continue
          seen.add(row.terminalId)
          // Anything but between turns: `blocked` (a permission question) is mid-turn too.
          if (busyOnly && (row.state === 'waiting' || row.state === 'done')) continue
          const seat = this.seatOf(row.terminalId, provider, view)
          if (seat) counts[seat.key] = (counts[seat.key] ?? 0) + 1
        }
      }
    } catch {
      return {}
    }
    return counts
  }

  /** What Smart ranks with: the history, the pane counts and the accounts left as Low. */
  private async smartContext(provider: Provider, view: AccountView, server: string | undefined, now: number): Promise<SmartContext> {
    const avoid = new Set<string>()
    for (const seat of view.seats) {
      const left = this.state.leftLow?.[scopedKey(server, seat.key)]
      if (left && left.until > now) avoid.add(seat.key)
    }
    return { samples: this.samplesOn(server), panes: await this.paneCounts(provider, view, server), avoid }
  }

  /** A seat left because it was running Low is not a target again within its 5-hour window. */
  private markLeftLow(seat: Seat, now: number, server: string | undefined): void {
    const session = seat.usage.session
    const until = session && session.resetsAt !== null && session.resetsAt > now ? session.resetsAt : now + FIVE_HOURS_MS
    const entry: { at: number; until: number; used?: number } = { at: now, until }
    if (session) entry.used = session.usedPercent
    this.state.leftLow = { ...(this.state.leftLow ?? {}), [scopedKey(server, seat.key)]: entry }
  }

  /** Ends "left as Low" when the window is over, or a live reading taken since shows that the
   *  window has started again (a later reset time, or usage that fell). */
  private clearLeftLow(seats: readonly Seat[], now: number, server: string | undefined): boolean {
    const marks = this.state.leftLow
    if (!marks) return false
    let changed = false
    for (const [key, left] of Object.entries(marks)) {
      // `seats` are the accounts of `server`: a mark of another server is not theirs to judge.
      // It only ends with its window.
      const mine = server ? key.startsWith(scopedKey(server, '')) : !key.includes('|')
      if (!mine) {
        if (left.until <= now) {
          delete marks[key]
          changed = true
        }
        continue
      }
      const seat = seats.find((s) => scopedKey(server, s.key) === key)
      const u = seat?.usage
      const live = !!u && u.known && (u.source === undefined || u.source === 'live') && (u.asOf === undefined || u.asOf > left.at)
      const session = live ? u!.session : undefined
      const restarted =
        !!session &&
        ((session.resetsAt !== null && session.resetsAt > left.until + 60_000) ||
          (left.used !== undefined && session.usedPercent < left.used - 2))
      if (left.until <= now || !seat || restarted) {
        delete marks[key]
        changed = true
      }
    }
    return changed
  }

  /** The accounts known to have room in a model's own bucket (where a model cap moves first).
   *  `unknownToo`: also the accounts whose bucket for that model is not known, i.e. every account
   *  not known to be full in it. */
  private modelRoom(chain: readonly Seat[], model: string | undefined, now: number, unknownToo = false): Set<string> {
    const keys = new Set<string>()
    for (const seat of chain) {
      const bucket = seat.usage.known ? seat.usage.model : undefined
      if (!bucket || (model && !bucket.name.toLowerCase().includes(model.toLowerCase()))) {
        if (unknownToo) keys.add(seat.key)
        continue
      }
      const over = !bucket.reset && !(bucket.resetsAt !== null && bucket.resetsAt <= now) && bucket.usedPercent > 100 - MODEL_ROOM_LEFT
      if (!over) keys.add(seat.key)
    }
    return keys
  }

  // ---- server & accounts ------------------------------------------------------------------

  /** Resolves which Orca server (`environmentId`, or `undefined` for `local`) owns `workspaceId`. */
  async serverOfWorkspace(workspaceId?: string | null, workspaceListId?: string | null): Promise<string | undefined> {
    for (const id of [workspaceListId, workspaceId]) {
      const host = hostFromWorkspaceIdentity(id)
      if (host === 'local') return undefined
      const srv = parseServer(host)
      if (srv) return srv
    }
    if (!workspaceId && !workspaceListId) return undefined
    const sep = workspaceId ? workspaceId.indexOf('::') : -1
    const repoId = sep > 0 && workspaceId ? workspaceId.slice(0, sep) : undefined
    const worktreePath = sep > 0 && workspaceId ? workspaceId.slice(sep + 2) : undefined
    let matchedWorkspace: any
    let projectId: string | undefined = repoId
    try {
      const { workspaces } = await this.deps.host.call('workspace.list')
      if (Array.isArray(workspaces)) {
        matchedWorkspace =
          workspaces.find((w: any) => (workspaceId && w.id === workspaceId) || (workspaceListId && w.id === workspaceListId)) ??
          (repoId
            ? workspaces.find((w: any) => w.projectId === repoId && worktreePath && w.path === worktreePath) ??
              workspaces.find((w: any) => w.projectId === repoId)
            : undefined)
        if (matchedWorkspace) {
          if (matchedWorkspace.hostId === 'local') return undefined
          const srv = parseServer(matchedWorkspace.hostId)
          if (srv) return srv
          if (typeof matchedWorkspace.projectId === 'string') projectId = matchedWorkspace.projectId
        }
      }
    } catch {
      // Fall through to project.list / CLI catalog.
    }
    if (projectId) {
      try {
        const { projects } = await this.deps.host.call('project.list')
        if (Array.isArray(projects)) {
          const project =
            projects.find((p: any) => p.id === projectId && worktreePath && typeof p.path === 'string' && worktreePath.startsWith(p.path)) ??
            projects.find((p: any) => p.id === projectId)
          if (project) {
            if (project.hostId === 'local') return undefined
            const srv = parseServer(project.hostId)
            if (srv) return srv
            return undefined
          }
        }
      } catch {
        // `project.list` may not be mocked in tests or available.
      }
    }
    if (matchedWorkspace) return undefined
    try {
      return parseServer(await this.deps.cli.workspaceServer?.(workspaceId ?? undefined))
    } catch {
      return undefined
    }
  }

  /** The SSH target a workspace runs on (`ssh:<target>` on its `workspace.list` row, else on its
   *  project), or undefined when it runs on this Orca or a paired server. */
  async sshTargetOfWorkspace(workspaceId?: string | null): Promise<string | undefined> {
    if (!workspaceId) return undefined
    try {
      const { workspaces } = await this.deps.host.call('workspace.list')
      const ws = Array.isArray(workspaces) ? workspaces.find((w: any) => w.id === workspaceId) : undefined
      const fromWorkspace = parseSshTarget(ws?.hostId)
      if (fromWorkspace) return fromWorkspace
      if (typeof ws?.hostId === 'string' && ws.hostId) return undefined
      const sep = workspaceId.indexOf('::')
      const projectId: string | undefined = ws?.projectId ?? (sep > 0 ? workspaceId.slice(0, sep) : undefined)
      if (!projectId) return undefined
      const { projects } = await this.deps.host.call('project.list')
      const project = Array.isArray(projects) ? projects.find((p: any) => p.id === projectId) : undefined
      return parseSshTarget(project?.hostId)
    } catch {
      return undefined
    }
  }

  /** Where each workspace runs, as last learned while Orca could list the workspaces. */
  private places = new Map<string, { server?: string; sshHost?: string }>()

  /** Where a workspace runs: on a paired Orca server (`server`), on a direct SSH target
   *  (`sshHost`), or, with neither, on this computer. Null when Orca cannot list the workspaces
   *  right now and this workspace was not placed before: "could not ask" is never taken for
   *  "this computer", whose accounts would then be switched for a session that runs elsewhere. */
  private async placeOf(workspaceId: string, workspaceListId?: string | null): Promise<{ server?: string; sshHost?: string } | null> {
    let listed = false
    try {
      listed = Array.isArray((await this.deps.host.call('workspace.list'))?.workspaces)
    } catch {
      listed = false
    }
    if (!listed) return this.places.get(workspaceId) ?? null
    const server = await this.serverOfWorkspace(workspaceId, workspaceListId)
    const sshHost = await this.sshTargetOfWorkspace(workspaceId)
    const place = { ...(server ? { server } : {}), ...(sshHost ? { sshHost } : {}) }
    if (this.places.size >= 500 && !this.places.has(workspaceId)) this.places.clear()
    this.places.set(workspaceId, place)
    return place
  }

  /** Resolves the Orca server of the currently focused project/workspace (`undefined` for `local`). */
  async currentServer(): Promise<string | undefined> {
    try {
      const context = await this.deps.host.call('workspace.readContext')
      if (context?.workspaceId) {
        return await this.serverOfWorkspace(context.workspaceId)
      }
      if (context?.displayName) {
        const { workspaces } = await this.deps.host.call('workspace.list').catch(() => ({ workspaces: [] }))
        const ws = Array.isArray(workspaces)
          ? workspaces.find((w: any) => w.name === context.displayName && (!context.branch || w.branch === context.branch)) ??
            workspaces.find((w: any) => w.name === context.displayName)
          : undefined
        if (ws) return await this.serverOfWorkspace(ws.id)
      }
    } catch {
      // Ignore context lookup failures.
    }
    try {
      return parseServer(await this.deps.cli.workspaceServer?.())
    } catch {
      return undefined
    }
  }

  async accounts(force = false): Promise<AccountView> {
    const server = await this.currentServer()
    this.server = server
    return this.accountsFor(server, force)
  }

  private async accountsFor(server: string | undefined, force = false): Promise<AccountView> {
    const config = await this.config()
    const key = server ?? 'local'
    const current = this.views.get(key)
    const fresh = current && this.deps.now() - current.at < config.pollIntervalSeconds * 1000
    if (current && fresh && !force) {
      if (server === this.server) {
        this.view = current.view
        this.viewAt = current.at
        this.viewError = current.error
      }
      return current.view
    }
    // One `orca account list` per server at a time (~3 s): the timer, the panel and commands share it.
    const pending = this.listings.get(key)
    if (pending) return pending
    const reading = this.readAccountsFor(server, key, current, config).finally(() => this.listings.delete(key))
    this.listings.set(key, reading)
    return reading
  }

  private async readAccountsFor(
    server: string | undefined,
    key: string,
    current: ServerView | undefined,
    config: Config
  ): Promise<AccountView> {
    let nextView = current?.view ?? null
    let nextAt = current?.at ?? 0
    let nextError: string | undefined
    try {
      const raw = server ? await this.deps.cli.listAccounts(server) : await this.deps.cli.listAccounts()
      const parsed = parseAccounts(raw)
      const now = this.deps.now()
      if (!server) {
        // The last-known usage cache covers this machine's accounts (see usage-cache.ts).
        // A switch made outside the plugin (Orca's own switcher) also starts a new active period.
        if (current?.view) {
          for (const [provider, seatKey] of Object.entries(parsed.active) as [Provider, string][]) {
            if (current.view.active[provider] && current.view.active[provider] !== seatKey) this.activeSince[provider] = now
          }
        }
        let changed = observe(this.usage, parsed.seats, now, this.activeSince)
        if (await this.observePanes(parsed.seats, now)) changed = true
        const maxAgeMs = config.usageCacheMaxAgeHours * 3_600_000
        for (const seat of parsed.seats) seat.usage = resolve(seat, this.usage, now, maxAgeMs, this.activeSince)
        if (changed) await this.deps.saveUsage(this.usage).catch(() => undefined)
        // Observe only: the pace of use, for the runway the panel shows.
        let sampled = pruneSamples(this.samples, parsed.seats.map((s) => s.key))
        for (const seat of parsed.seats) if (addSample(this.samples, seat, now)) sampled = true
        if (sampled) await this.deps.saveSamples(this.samples).catch(() => undefined)
        const freed = this.clearLeftLow(parsed.seats, now, server)
        if (this.clearStrikesByReading(parsed.seats, now) || freed) await this.save()
      } else if (this.clearLeftLow(parsed.seats, now, server)) await this.save()
      nextView = parsed
      nextAt = now
      nextError = undefined
    } catch (error) {
      nextError = `orca account list failed: ${String((error as Error)?.message ?? error)}`
      this.deps.log(nextError)
      if (!nextView) nextView = { seats: [], active: {} }
    }
    const entry: ServerView = { view: nextView, at: nextAt }
    if (nextError) entry.error = nextError
    this.views.set(key, entry)
    if (server === this.server) {
      this.view = nextView
      this.viewAt = nextAt
      this.viewError = nextError
    }
    return nextView
  }

  /** Takes in what Claude panes reported about their own accounts (live-usage.ts). Passive: it
   *  only reads files, so it also runs while paused or with the service off. */
  private async observePanes(seats: readonly Seat[], now: number): Promise<boolean> {
    let changed = false
    for (const seat of seats) {
      if (!seat.liveKeys?.length) continue
      const readings = []
      for (const liveKey of seat.liveKeys) {
        const reading = parseLive(await this.deps.readLive(liveKey).catch(() => null), now)
        if (reading) readings.push(reading)
      }
      // Oldest first, so the newest stands and one window never goes down between them.
      readings.sort((a, b) => a.asOf - b.asOf)
      for (const reading of readings) if (observeLive(this.usage, seat.key, reading, now)) changed = true
    }
    return changed
  }

  /** A current reading (Orca's or a pane's: anything resolved as `live`) that is newer than
   *  the last strike and shows room clears the seat's strikes. Remembered numbers never do. */
  private clearStrikesByReading(seats: readonly Seat[], now: number): boolean {
    let changed = false
    for (const seat of seats) {
      const h = this.state.health[seat.key]
      if (!h || strikesOf(h, now) === 0) continue
      const u = seat.usage
      if (!u.known || (u.source !== undefined && u.source !== 'live')) continue
      if (u.asOf !== undefined && u.asOf <= (h.strikeAt ?? 0)) continue
      if (exhausted(seat, now)) continue
      this.dropStrikes(seat.key)
      changed = true
    }
    return changed
  }

  private dropStrikes(key: string): void {
    const h = this.state.health[key]
    if (!h) return
    delete h.strikes
    delete h.strikeAt
    if (Object.keys(h).length === 0) delete this.state.health[key]
  }

  /** The provider's probation, while it lasts. */
  private probation(provider: Provider, now: number, server: string | undefined): { key: string; until: number } | undefined {
    const p = this.state.probation?.[scopedKey(server, provider)]
    return p && p.until > now ? p : undefined
  }

  /** An automatic move landed on a seat the plugin has no numbers for: hold further advisory moves
   *  of this provider for a while, and count a limit banner on that seat as a strike. */
  private startProbation(target: Seat, config: Config, now: number, server: string | undefined): void {
    if (target.usage.known) return
    const until = now + Math.max(MIN_PROBATION_MS, 2 * config.switchCooldownMinutes * 60_000)
    this.state.probation = { ...(this.state.probation ?? {}), [scopedKey(server, target.provider)]: { key: target.key, until } }
  }

  private selectOn(provider: Provider, accountId: string, server?: string): Promise<void> {
    return server ? this.deps.cli.select(provider, accountId, server) : this.deps.cli.select(provider, accountId)
  }

  private closeOn(terminalId: string, server?: string): Promise<void> {
    return server ? this.deps.cli.closeTerminal(terminalId, server) : this.deps.cli.closeTerminal(terminalId)
  }

  private sendOn(terminalId: string, text: string, server?: string): Promise<void> {
    return server ? this.deps.cli.sendText(terminalId, text, server) : this.deps.cli.sendText(terminalId, text)
  }

  private activeTerminalsOn(server?: string): Promise<string[]> {
    return this.activeTerminalsRead(server).then((a) => a ?? [])
  }

  /** As `activeTerminalsOn`, but null when the CLI could not say (not "no terminal is shown"). */
  private activeTerminalsRead(server?: string): Promise<string[] | null> {
    const fn = this.deps.cli.activeTerminals
    if (!fn) return Promise.resolve([])
    return (server ? fn.call(this.deps.cli, server) : fn.call(this.deps.cli)).catch(() => null)
  }

  /** The cached view without a CLI call; for hooks, which must answer within 2 s. */
  cachedView(): AccountView | null {
    return this.views.get(this.server ?? 'local')?.view ?? this.view
  }

  private seatOf(terminalId: string, provider: Provider, view: AccountView): Seat | undefined {
    return this.locate(terminalId, provider, view).seat
  }

  /** Which seat a pane runs on, and whether the plugin actually knows (launch hook, own swap,
   *  recent swap) or only assumes it is the provider's active seat. */
  private locate(terminalId: string, provider: Provider, view: AccountView): { seat: Seat | undefined; known: boolean } {
    let key: string | undefined = this.state.paneSeat[terminalId]
    let known = !!key
    if (!key) {
      // Unknown pane (started before the plugin). If the plugin just moved this provider off a
      // seat, a pane still hitting a limit is almost certainly on that old seat, not the new one.
      const recent = [...this.state.history]
        .reverse()
        .find((h) => h.provider === provider && h.to && (h.result === 'resumed' || h.result === 'handoff' || h.result === 'selected'))
      const fresh = recent && this.deps.now() - recent.at < 10 * 60_000
      if (fresh && recent.to === view.active[provider] && recent.from) {
        key = recent.from
        known = true
      } else key = view.active[provider]
    }
    return { seat: view.seats.find((s) => s.key === key), known }
  }

  /** Automatic action allowed for this provider right now (re-read after every wait). */
  private async allowed(provider: Provider): Promise<boolean> {
    const config = await this.config()
    this.noteConfig(config)
    return !this.state.paused && config.services[provider] !== false
  }

  // ---- events -----------------------------------------------------------------------------

  /** `agent.launch.before`: remember which seat a new pane starts on. */
  noteLaunch(agent: string, terminalId: string | undefined, workspaceId?: string | null): void {
    const provider = providerOf(agent)
    if (!provider || !terminalId) return
    const hostServer = parseServer(hostFromWorkspaceIdentity(workspaceId))
    if (hostServer) this.remotePanes.add(terminalId)
    this.absentSince.delete(terminalId)
    const view = (hostServer ? this.views.get(hostServer)?.view : undefined) ?? this.cachedView()
    if (!view) return
    const key = view.active[provider]
    if (key) {
      this.state.paneSeat[terminalId] = key
      // The hook does not wait for the save; a storage failure must not go unhandled.
      void this.save().catch((error) => this.deps.log(`could not save the account of ${terminalId}: ${String((error as Error)?.message ?? error)}`))
    }
  }

  /** Re-reads which project server and which agent the user is working with: the agent in the
   *  focused workspace's active terminal tab (from the CLI's layout listing); failing that, the
   *  agent whose state changed last, since the host API names the focused workspace but not the
   *  focused pane. Returns whether the focused server or agent moved. */
  refreshFocus(): Promise<boolean> {
    // One read at a time. Each costs a CLI process, and the panel's poll, the tick and Orca's
    // events all ask: reads that overlapped piled up, and one that finished late could put back
    // an older answer. Whoever asks during a read shares one further read made after it, so the
    // answer is never older than the question.
    if (!this.focusRead) {
      const read: Promise<boolean> = this.readFocus().finally(() => {
        if (this.focusRead === read) this.focusRead = undefined
      })
      this.focusRead = read
      return read
    }
    this.focusNext ??= this.focusRead
      .then(() => undefined, () => undefined)
      .then(() => {
        this.focusNext = undefined
        return this.refreshFocus()
      })
    return this.focusNext
  }

  private focusRead: Promise<boolean> | undefined
  private focusNext: Promise<boolean> | undefined

  private async readFocus(): Promise<boolean> {
    const nextServer = await this.currentServer()
    const serverMoved = nextServer !== this.server
    if (serverMoved) {
      this.server = nextServer
      await this.accountsFor(nextServer)
    }
    const context = await this.deps.host.call('workspace.readContext').catch(() => null)
    const nextSsh = await this.sshTargetOfWorkspace(context?.workspaceId)
    const sshMoved = nextSsh !== this.sshHost
    this.sshHost = nextSsh
    let next: Provider | undefined
    try {
      const [{ agents }, read] = await Promise.all([
        this.deps.host.call('agents.list'),
        this.activeTerminalsRead(nextServer)
      ])
      const active = read ?? []
      // Switching workspace or tab is the user at Orca. A move of the plugin's own replaces the
      // pane, so the next read after one starts afresh instead of counting; a read that failed
      // says nothing about the user.
      const shownIds: string[] | undefined = context && read ? context.terminals.map((t: { id: string }) => t.id).filter((id: string) => active.includes(id)) : undefined
      this.shownNow = shownIds ? new Set(shownIds) : undefined
      if (shownIds && this.moving.size === 0) {
        const scene = `${context.workspaceId ?? ''}|${[...shownIds].sort().join(',')}`
        if (this.lastScene !== undefined && scene !== this.lastScene) this.notePresence()
        this.lastScene = scene
      }
      const candidates = agents.filter((a: any) => providerOf(a.agent))
      const inActiveTab = candidates.find((a: any) => a.terminalId && active.includes(a.terminalId))
      const latest = [...candidates].sort((a: any, b: any) => (b.stateStartedAt ?? 0) - (a.stateStartedAt ?? 0))[0]
      const pick = inActiveTab ?? latest
      next = pick ? providerOf(pick.agent) ?? undefined : undefined
    } catch {
      next = undefined
    }
    if (next === this.focused) return serverMoved || sshMoved
    this.focused = next
    return true
  }

  async onAgentStatus(event: StatusEvent): Promise<void> {
    this.recentEvents = [...this.recentEvents.slice(-9), event]
    if (event.terminalId) {
      // Whatever was set aside for this pane is older than this event.
      this.unplaced.delete(event.terminalId)
      const before = this.paneStates.get(event.terminalId)
      this.paneStates.set(event.terminalId, event.state)
      const typed = this.typedAt.get(event.terminalId)
      const byPlugin = typed !== undefined && this.deps.now() - typed < TYPED_TURN_MS
      // Between turns, or asking for permission, then working: the user sent a prompt or answered.
      // Only in the session on screen (as the last focus read found it; when that could not say,
      // it counts): a turn that starts in another tab is an agent going on by itself, or another
      // tool, not a sign of the user. No CLI call per event.
      const onScreen = this.shownNow === undefined || this.shownNow.has(event.terminalId)
      if (event.state === 'working' && (before === 'waiting' || before === 'done' || before === 'blocked') && !byPlugin && onScreen) this.notePresence()
    }
    if (await this.refreshFocus()) this.publishNow()
    await this.look(event)
  }

  /** Looks at the pane of a status event that says a turn ended (or the pane waits): a limit in
   *  its latest output is handled, or the account it runs on is left when that is due. */
  private async look(event: StatusEvent): Promise<void> {
    if (!event.terminalId) return
    const state = event.state
    if (state !== 'done' && state !== 'waiting') return
    const terminalId = event.terminalId
    if (this.inflight.has(terminalId)) return
    this.inflight.add(terminalId)
    try {
      const pane = await this.describe(event)
      if (!pane) return
      // Paused: still note which banners exist, so un-pausing never acts on stale ones.
      await this.inspect(pane, this.state.paused, state === 'done')
    } catch (error) {
      this.deps.log(`status handling failed for ${terminalId}: ${String((error as Error)?.message ?? error)}`)
    } finally {
      this.inflight.delete(terminalId)
    }
  }

  private async describe(event: StatusEvent): Promise<PaneInfo | null> {
    // Live Orca 1.4.261: agents.list and agent.resume take the event's `workspaceId`
    // (`<repo>::<path>`); `workspaceListId` (`identity:wt2:…`) is refused with selector_not_found.
    const ids = [event.workspaceId, event.workspaceListId].filter((id): id is string => !!id)
    for (const workspaceId of ids) {
      let agents: any[]
      try {
        agents = (await this.deps.host.call('agents.list', { workspaceId })).agents
      } catch {
        continue
      }
      // Orca 1.4.263 lists a pane that was started in the background and never shown with
      // `terminalId: null`; its session id still ties it to the event.
      const row =
        agents.find((a) => a.terminalId === event.terminalId) ??
        (event.sessionId ? agents.find((a) => !a.terminalId && a.sessionId === event.sessionId) : undefined)
      if (!row) continue
      const agent = providerOf(row.agent)
      if (!agent) return null
      const pane: PaneInfo = { terminalId: event.terminalId!, workspaceId, agent }
      if (row.agent !== agent) pane.agentId = row.agent
      const sessionId = row.sessionId ?? event.sessionId
      if (sessionId) pane.sessionId = sessionId
      const title = row.title ?? event.title
      if (title) pane.title = title
      // Where it runs decides whose accounts apply. When Orca cannot say (and never said), the
      // session is left alone: taken for one on this computer, a session on an SSH target or a
      // paired server would have this computer's account switched for it, and be closed.
      const place = await this.placeOf(workspaceId, event.workspaceListId)
      if (!place) {
        this.deps.log(`${agent} ${pane.terminalId}: Orca could not be asked where its workspace runs, leaving it alone for now`)
        // Looked at again at the next tick (a few of them at most are kept: the newest).
        this.unplaced.delete(pane.terminalId)
        this.unplaced.set(pane.terminalId, event)
        for (const id of [...this.unplaced.keys()].slice(0, Math.max(0, this.unplaced.size - 50))) this.unplaced.delete(id)
        return null
      }
      if (place.server) {
        pane.server = place.server
        this.remotePanes.add(pane.terminalId)
      }
      if (place.sshHost) pane.sshHost = place.sshHost
      return pane
    }
    return null
  }

  /** New when this banner was not seen in this pane, or another copy of it has been printed. */
  private isNew(key: string, signal: Signal): boolean {
    const seen = this.state.seen[key]
    if (!seen) return true
    const known = seen.fingerprint === signal.fingerprint ? seen : seen.earlier?.find((e) => e.fingerprint === signal.fingerprint)
    if (!known) return true
    if (signal.occurrences > known.occurrences) return true
    // Copies scrolled out of the read window: remember the lower count so the next copy counts.
    if (signal.occurrences < known.occurrences) known.occurrences = signal.occurrences
    return false
  }

  /** Record a handled banner for a session, keeping the ones handled before it. */
  private remember(key: string, fingerprint: string, occurrences: number, line?: string): void {
    const prev = this.state.seen[key]
    const earlier = (prev?.earlier ?? []).filter((e) => e.fingerprint !== fingerprint)
    if (prev && prev.fingerprint !== fingerprint) {
      earlier.push({ fingerprint: prev.fingerprint, occurrences: prev.occurrences, ...(prev.line ? { line: prev.line } : {}) })
    }
    const next: SeenSignal = { fingerprint, occurrences, ...(line ? { line } : {}) }
    if (earlier.length) next.earlier = earlier.slice(-12)
    this.state.seen[key] = next
  }

  /** Copies of a handled banner that have scrolled out of the read window no longer count, so
   *  the next identical banner (same limit text hours later) is seen as new. */
  private recount(key: string, lines: readonly string[]): void {
    const seen = this.state.seen[key]
    if (!seen) return
    for (const entry of [seen, ...(seen.earlier ?? [])]) {
      if (!entry.line) continue
      const copies = countCopies(lines, entry.line)
      if (copies < entry.occurrences) entry.occurrences = copies
    }
  }

  /** Handled banners are remembered per session: Orca can restore or restart a session in a new
   *  pane (live: after an account switch), and its redrawn transcript shows the old banner. */
  private seenKey(pane: { terminalId: string; sessionId?: string }): string {
    return pane.sessionId ? `session:${pane.sessionId}` : pane.terminalId
  }

  async inspect(pane: PaneInfo, observeOnly = false, turnEnded = false): Promise<void> {
    const config = await this.config()
    this.noteConfig(config)
    const { lines, truncated } = await this.deps.host.call('terminal.read', {
      terminalId: pane.terminalId,
      maxLines: 80
    })
    const signal = classify(pane.agent, lines, this.deps.now())
    const key = this.seenKey(pane)
    // A banner can only have scrolled away when the read window is full. A shorter read without
    // it is a resumed pane that has not redrawn its transcript yet (live: the redraw can come
    // after the pane reports ready); forgetting the banner then would make the redraw look new.
    if (truncated || lines.length >= 80) this.recount(key, lines)
    if (observeOnly || !config.services[pane.agent]) {
      // Paused or service off: record what is on screen without acting on it. This comes before
      // everything that notifies or writes History, the SSH-target note below included.
      if (signal && this.isNew(key, signal)) {
        this.remember(key, signal.fingerprint, signal.occurrences, signal.line)
        await this.save()
      } else if (!signal && this.state.waiting.some((w) => w.terminalId === pane.terminalId)) {
        // A turn ended in a waiting session with no limit in its latest output: the user went on
        // there. The wait is over, as when nothing is paused; otherwise un-pausing would close
        // the session and resume it unasked.
        this.state.waiting = this.state.waiting.filter((w) => w.terminalId !== pane.terminalId)
        await this.save()
        this.publishNow()
      }
      return
    }
    if (pane.sshHost && signal?.kind !== 'api_error') {
      // The agent runs on a direct SSH target with that machine's own login. This Orca's managed
      // accounts neither apply there nor can be selected there, so the pane is left alone; a
      // limit is noted once in the history so the user knows why nothing moved. (An API error
      // falls through: retrying in place only types into the pane.)
      if (signal && this.isNew(key, signal)) {
        this.remember(key, signal.fingerprint, signal.occurrences, signal.line)
        const detail = `runs on SSH target ${pane.sshHost}: Orca manages no accounts there`
        this.record({ provider: pane.agent, terminalId: pane.terminalId, reason: signal.kind, result: 'failed', detail })
        await this.save()
        this.deps.log(`${pane.agent} ${pane.terminalId}: ${signal.kind} — ${detail}`)
        await this.deps.notify('Auto Hand-off', `${PROVIDER_NAME[pane.agent]} hit a limit on SSH target ${pane.sshHost}; Orca manages no accounts there, so the session was left alone.`)
        this.publishNow()
      }
      return
    }
    if (!signal) {
      delete this.state.apiRetries[pane.terminalId]
      if (this.state.waiting.some((w) => w.terminalId === pane.terminalId)) {
        // A turn ended in a parked pane with no limit in its latest output: the user went on
        // there. Stop waiting, or the wake would close the pane and resume it unasked.
        this.state.waiting = this.state.waiting.filter((w) => w.terminalId !== pane.terminalId)
        await this.save()
        this.publishNow()
      }
      const view = await this.accountsFor(pane.server)
      const at = this.locate(pane.terminalId, pane.agent, view)
      const seat = at.seat
      // A turn that finished without a limit on a seat the pane is known to run on: the seat
      // works, so its strikes are over.
      if (turnEnded && seat && at.known) {
        const h = this.healthOf(seat.key, pane.server)
        if (h && strikesOf(h, this.deps.now()) > 0 && this.deps.now() - (h.strikeAt ?? 0) >= STRIKE_SETTLE_MS) {
          this.dropStrikes(scopedKey(pane.server, seat.key))
          await this.save()
        }
      }
      // The turn is over: leave an account that is at a limit, or (Smart) about to run out.
      if (seat && this.leaving(seat, pane.server, config, this.deps.now()).leave) {
        await this.swap(pane, 'threshold', lines)
        return
      }
      // A turn just ended on a lower seat while a higher-priority one is healthy again.
      await this.switchBack(pane, lines)
      return
    }
    if (!this.isNew(key, signal)) {
      // A move that waits for unsent text to go: look again (the tick does the same).
      const held = this.state.waiting.find((w) => w.terminalId === pane.terminalId && w.draftAt)
      if (held) await this.wake(held)
      return
    }
    this.remember(key, signal.fingerprint, signal.occurrences, signal.line)
    await this.save()
    this.deps.log(`${pane.agent} ${pane.terminalId}: ${signal.kind} — ${signal.line}`)

    switch (signal.kind) {
      case 'api_error':
        return this.retryApiError(pane, config, signal)
      case 'model_cap':
        // Smart order: an account known to have room in that model's bucket, then the fallback
        // model on this account, then an account not known to be full in that bucket, then wait
        // (`swap` parks when every other account is full in it or unavailable).
        if (await this.modelRoomElsewhere(pane, signal, config)) {
          return this.swap(pane, 'model_cap', lines, signal)
        }
        if (await this.fallbackModel(pane, config, signal, lines)) return
        return this.swap(pane, 'model_cap', lines, signal)
      case 'auth':
        return this.swap(pane, 'auth', lines, signal)
      case 'rate_limit':
        return this.swap(pane, 'rate_limit', lines, signal)
    }
  }

  private async retryApiError(pane: PaneInfo, config: Config, signal: Signal): Promise<void> {
    if (!config.retryOnApiError || config.maxApiRetries <= 0) return
    const attempt = this.state.apiRetries[pane.terminalId] ?? 0
    if (attempt >= config.maxApiRetries) {
      this.record({ provider: pane.agent, terminalId: pane.terminalId, reason: 'api_error', result: 'failed', detail: `gave up after ${attempt} retries` })
      await this.save()
      await this.deps.notify('Auto Hand-off', `${PROVIDER_NAME[pane.agent]}: still failing after ${attempt} retries; left for you.`)
      this.publishNow()
      return
    }
    this.state.apiRetries[pane.terminalId] = attempt + 1
    await this.save()
    await this.deps.sleep(backoffMs(attempt))
    if (!(await this.allowed(pane.agent))) return
    // The backoff can be minutes: only type when the pane is still between turns and its input
    // box is empty. Typing would send the user's unsent text, or land in a turn they started.
    const { agents } = await this.deps.host.call('agents.list', { workspaceId: pane.workspaceId }).catch(() => ({ agents: [] as any[] }))
    const row = rowOf(agents, pane)
    if (!row || (row.state !== 'waiting' && row.state !== 'done')) {
      this.deps.log(`${pane.agent} ${pane.terminalId}: no longer between turns, not retrying`)
      return
    }
    const screen = await this.deps.host.call('terminal.read', { terminalId: pane.terminalId, maxLines: 80 }).catch(() => null)
    if (!screen) {
      this.deps.log(`${pane.agent} ${pane.terminalId}: unreadable, not retrying`)
      return
    }
    // The backoff can outlast a turn the user started: only an error that is still the latest
    // output is retried. Status events of this pane were set aside meanwhile (`inflight`), so
    // whatever it shows now (a limit, or nothing) is looked at here instead.
    if (classify(pane.agent, screen.lines, this.deps.now())?.fingerprint !== signal.fingerprint) {
      this.deps.log(`${pane.agent} ${pane.terminalId}: the API error is no longer its latest output, not retrying`)
      return this.inspect(pane)
    }
    const box = await this.unsentText(pane.terminalId, pane.server, screen.lines)
    if (box !== null) return this.leftForDraft(pane, 'api_error', 'the API error was not retried', box === UNCHECKED)
    // Asking Orca for the input box took a moment more (live: a CLI process): pausing, or the
    // service's switch, meanwhile stops the retry too.
    if (!(await this.allowed(pane.agent))) return
    await this.type(pane.terminalId, config.autoMessage || 'continue', pane.server)
    this.record({ provider: pane.agent, terminalId: pane.terminalId, reason: 'api_error', result: 'retried', detail: `attempt ${attempt + 1}` })
    await this.save()
    this.publishNow()
  }

  /** Typing into a pane sends whatever is in its input box: with unsent text there, nothing is
   *  typed. Noted in the history and said once, so the user knows why the pane stays as it is. */
  private async leftForDraft(pane: PaneInfo, reason: 'api_error' | 'model_cap', what: string, unchecked = false): Promise<void> {
    this.deps.log(`${pane.agent} ${pane.terminalId}: ${unchecked ? 'could not check the input box' : 'unsent text in the input box'}, not typing into it`)
    this.record({ provider: pane.agent, terminalId: pane.terminalId, reason, result: 'failed', detail: unchecked ? 'could not check the input box' : 'unsent text in the input box' })
    await this.save()
    await this.deps.notify(
      'Auto Hand-off',
      unchecked
        ? `${PROVIDER_NAME[pane.agent]}: Orca could not be asked whether the session has unsent text in its input box, so ${what}. It is left for you to continue.`
        : `${PROVIDER_NAME[pane.agent]}: the session has unsent text in its input box, so ${what}. It is left for you to continue.`
    )
    this.publishNow()
  }

  /** Is another account of this service known to have room in the capped model's bucket? */
  private async modelRoomElsewhere(pane: PaneInfo, signal: Signal, config: Config): Promise<boolean> {
    const view = await this.accountsFor(pane.server)
    const now = this.deps.now()
    const from = this.seatOf(pane.terminalId, pane.agent, view)
    const chain = buildChain(view.seats, pane.agent, config)
    const only = this.modelRoom(chain, signal.model, now)
    return !!pickNext(chain, from?.key, this.healthOn(pane.server), config, now, { only })
  }

  private async fallbackModel(pane: PaneInfo, config: Config, signal: Signal, lines: readonly string[]): Promise<boolean> {
    const adapter = ADAPTERS[pane.agent]
    const models = (parseModelFallback(config.modelFallback)[pane.agent] ?? []).filter(
      (m) => !signal.model || !m.toLowerCase().includes(signal.model)
    )
    const step = this.state.modelStep[pane.terminalId] ?? 0
    if (!adapter.modelSwitch || step >= models.length) return false
    const model = models[step]!
    const box = await this.unsentText(pane.terminalId, pane.server, lines)
    if (box !== null) {
      // `/model …` and the first message would both send the user's unsent text.
      await this.leftForDraft(pane, 'model_cap', `the model was not switched to ${model}`, box === UNCHECKED)
      return true
    }
    // Looking for unsent text asks Orca (live: a CLI process), and Smart read the accounts before
    // that: a turn the user started meanwhile is not typed into. Its end is a new event, and the
    // fallback model is still there for it.
    if (await this.midTurn(pane)) {
      this.deps.log(`${pane.agent} ${pane.terminalId}: in the middle of a turn again, not switching the model`)
      return true
    }
    // Those reads took seconds too: pausing, or the service's switch, meanwhile stops this as it
    // stops a hand-off. Nothing is typed.
    if (!(await this.allowed(pane.agent))) {
      this.deps.log(`${pane.agent} ${pane.terminalId}: automatic hand-off was paused or turned off meanwhile, not switching the model`)
      return true
    }
    this.state.modelStep[pane.terminalId] = step + 1
    await this.type(pane.terminalId, adapter.modelSwitch(model), pane.server)
    await this.deps.sleep(1500)
    if (config.autoMessage) await this.type(pane.terminalId, config.autoMessage, pane.server)
    this.record({ provider: pane.agent, terminalId: pane.terminalId, reason: 'model_cap', result: 'model', detail: `${signal.model ?? 'model'} capped → ${model}` })
    await this.save()
    this.publishNow()
    return true
  }

  /** A limit banner always cools the seat: until the banner's reset time, else Orca's, else a
   *  guessed time. A banner on a seat without numbers and without a reset time (or on the seat
   *  under probation) is a strike, and each strike doubles the guess. */
  private async coolDown(seat: Seat, signal: Signal, config: Config, reason: SwapReason, server: string | undefined): Promise<void> {
    const now = this.deps.now()
    const stored = scopedKey(server, seat.key)
    const prev = this.state.health[stored]
    const usageReset = [seat.usage.session, seat.usage.weekly]
      .filter((w) => w && w.usedPercent >= 100 && w.resetsAt && w.resetsAt > now)
      .map((w) => w!.resetsAt!)
    const realReset = signal.resetsAt ?? (usageReset.length ? Math.max(...usageReset) : undefined)
    const text = `${reason}: ${signal.line}`
    const strike = this.probation(seat.provider, now, server)?.key === seat.key || (!seat.usage.known && realReset === undefined)
    const stillCooling = !!prev?.cooldownUntil && prev.cooldownUntil > now
    if (strike && stillCooling && strikesOf(prev, now) > 0) {
      // Another pane on the seat showing the same limit: one strike, not two.
      const again = cooled(prev, now, Math.max(prev!.cooldownUntil!, realReset ?? 0), text)
      if (prev!.resetKnown || realReset !== undefined) again.resetKnown = true
      this.state.health[stored] = again
      await this.save()
      return
    }
    const strikes = strikesOf(prev, now) + (strike ? 1 : 0)
    const guess = reason === 'auth' ? 12 * 3_600_000 : strike ? blindCooldownMs(config, strikes) : config.defaultCooldownMinutes * 60_000
    const next = cooled(prev, now, realReset ?? now + guess, text)
    if (strike) {
      next.strikes = strikes
      next.strikeAt = now
    }
    if (realReset !== undefined) next.resetKnown = true
    this.state.health[stored] = next
    await this.save()
  }

  /** A seat left because it is used up stays out of rotation until the window that is full
   *  resets. Once it is inactive Orca may report no usage for it, and it would look free again:
   *  with every seat used up the session would rotate (and be typed into) forever. */
  private async coolOverThreshold(seat: Seat, config: Config, now: number, server: string | undefined): Promise<void> {
    if (!exhausted(seat, now)) return
    const stored = scopedKey(server, seat.key)
    const resets = [seat.usage.session, seat.usage.weekly]
      .filter((w) => w && w.usedPercent >= 100 && w.resetsAt !== null && w.resetsAt > now)
      .map((w) => w!.resetsAt!)
    const until = Math.max(
      resets.length ? Math.max(...resets) : now + config.defaultCooldownMinutes * 60_000,
      this.state.health[stored]?.cooldownUntil ?? 0
    )
    const next = cooled(this.state.health[stored], now, until, 'threshold: over the usage threshold')
    if (resets.length) next.resetKnown = true
    this.state.health[stored] = next
    await this.save()
  }

  /** Could this seat be the one that just hit a limit? False when Orca's own numbers say it has
   *  plenty of room, i.e. the limited pane must be on some other (older) account. */
  private plausiblyLimited(seat: Seat): boolean {
    const u = seat.usage
    // Only Orca's live numbers can clear an account; remembered ones may be out of date, and a
    // pane's reading can come from a quieter pane of the same account.
    if (!u.known || (u.source !== undefined && u.source !== 'live') || u.origin === 'pane') return true
    return Math.max(u.session?.usedPercent ?? 0, u.weekly?.usedPercent ?? 0, u.model?.usedPercent ?? 0) >= 90
  }

  // ---- swapping ---------------------------------------------------------------------------

  private async withLock<T>(provider: Provider, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(provider) ?? Promise.resolve()
    this.locked++
    const run = prev.then(fn, fn).finally(() => {
      this.locked--
    })
    this.locks.set(provider, run.catch(() => undefined))
    return run
  }

  async swap(pane: PaneInfo, reason: SwapReason, lines: string[], signal?: Signal): Promise<void> {
    await this.withLock(pane.agent, async () => {
      // Anything could have changed while this waited for the lock.
      if (reason !== 'manual' && !(await this.allowed(pane.agent))) return
      const config = await this.config()
      const advisory = reason === 'threshold' || reason === 'idle'
      // Advice never starts a session over: see `resumes`.
      if (advisory && !this.resumes(pane)) return
      // The user may have gone on in the pane while this waited behind another move: a turn that
      // runs is never closed. Its end is a new event. (Advice checks this in `advisoryOk`.) When
      // Orca cannot say, the move goes on to `moveTo`, which holds it until Orca can.
      const turn = await this.turnState(pane)
      // Or the pane is gone: closed by the user, or handed off by another look at the session
      // (the tick's, for one that was waiting) while this one waited for the lock. Nothing is
      // cooled, selected or started for a session that is no longer there.
      if (turn === 'gone') {
        this.deps.log(`${pane.agent} ${pane.terminalId}: the pane is gone, nothing to hand off`)
        return
      }
      if (reason !== 'manual' && !advisory && turn === 'busy') {
        this.deps.log(`${pane.agent} ${pane.terminalId}: in the middle of a turn again, not moving it`)
        return
      }
      // Right after a move onto a seat without numbers, advice waits; only a real limit moves on.
      if (advisory && this.probation(pane.agent, this.deps.now(), pane.server)) return
      const view = await this.accountsFor(pane.server, true)
      const now = this.deps.now()
      const at = this.locate(pane.terminalId, pane.agent, view)
      let from = at.seat
      const active = view.seats.find((s) => s.key === view.active[pane.agent])
      let preferActive = false
      if (signal && from) {
        if (at.known || this.plausiblyLimited(from)) {
          await this.coolDown(from, signal, config, reason, pane.server)
        } else {
          // Unknown pane (started before the plugin, or restored) while the active account has
          // plenty of room: the pane is on some other account. Cool nothing; move it to the
          // healthy active account.
          from = undefined
          preferActive = true
        }
      }
      const ahead = reason !== 'manual'
      // Leaving because the account is about to run out (Low), not because it is at a limit.
      const leave = advisory && from && ahead ? this.leaving(from, pane.server, config, now) : null
      const low = !!leave && leave.leave && !leave.assessment.over
      if (reason === 'threshold' && from) await this.coolOverThreshold(from, config, now, pane.server)
      const chain = buildChain(view.seats, pane.agent, config)
      // (Not when that account is one to Skip: then the ordinary pick finds another.)
      const healthyActive =
        preferActive && active && !isExcluded(active, config) && isEligible(active, this.healthOf(active.key, pane.server), now) ? active : null
      const context = ahead && config.strategy === 'smart' ? await this.smartContext(pane.agent, view, pane.server, now) : undefined
      // The fresh reading may show the account is fine after all (its window reset since the
      // cached one): then there is nothing to leave.
      if (leave && !leave.leave) return
      // A model cap (Smart): an account known to have room in that model's bucket.
      const only = ahead && reason === 'model_cap' ? this.modelRoom(chain, signal?.model, now) : undefined
      const pick = (restrict: ReadonlySet<string> | undefined) =>
        pickNext(chain, from?.key, this.healthOn(pane.server), config, now, {
          mode: reason === 'manual' ? 'manual' : advisory ? 'advisory' : 'hard',
          sourceExhausted: !!from && exhausted(from, now),
          ...(context ? { smart: context } : {}),
          ...(ahead && advisory ? { avoid: this.avoided(pane.agent, view, pane.server, config, now) } : {}),
          ...(restrict ? { only: restrict } : {})
        })
      // Failing that (this point is reached only after the fallback models), an account not known
      // to be full in that bucket: Orca seldom has the bucket of an account not in use, and the
      // bucket's own reset can be days away. An account that then shows the same cap is cooled
      // like this one, so the session never goes round.
      const picked = healthyActive ?? pick(only) ?? (only ? pick(this.modelRoom(chain, signal?.model, now, true)) : null)
      // Only ever another account of the same service.
      const target = picked && picked.provider === pane.agent ? picked : null
      if (!target) {
        // A threshold is advice: with nowhere to go, the session keeps working where it is.
        if (advisory) return
        if (only) {
          const model = signal?.model ?? 'model'
          await this.park(pane, from, chain, config, reason, {
            model,
            ...(signal?.resetsAt ? { wakeAt: signal.resetsAt } : {}),
            why: `no other ${PROVIDER_NAME[pane.agent]} account has room for ${model}; waiting for its limit to reset`,
            notify: `${PROVIDER_NAME[pane.agent]}: the ${model} limit was hit and no other account has room for it.`
          })
          return
        }
        await this.park(pane, from, chain, config, reason)
        return
      }
      if (ahead && from && config.waitForReset) {
        // The short-wait rule: a move re-reads the whole conversation without cache, so when the
        // account being left is back in a few minutes, waiting is cheaper.
        const resumeAt = shortWait(
          this.sourceReset(from, leave?.assessment, advisory, now, pane.server),
          projectedRunwayMs(this.recentOf(target, pane.server), context?.panes[target.key] ?? 0, now),
          config,
          now
        )
        if (resumeAt !== null) {
          const label = displayLabels(view.seats, pane.agent).get(from.key) ?? from.label
          if (advisory) {
            this.deps.log(`${pane.agent} ${pane.terminalId}: ${label} resets in ${minutesWords(resumeAt - now)}, not moving it`)
            return
          }
          await this.park(pane, from, chain, config, reason, {
            hold: 'short',
            wakeAt: resumeAt,
            why: `${label} resets in ${minutesWords(resumeAt - now)}; waiting is cheaper than handing off, which re-reads the whole conversation`,
            notify: `${PROVIDER_NAME[pane.agent]}: ${label} resets in ${minutesWords(resumeAt - now)}. The session waits and continues there, because handing it off would re-read the whole conversation.`
          })
          return
        }
      }
      if (advisory && !(await this.advisoryOk(pane, from, target, lines, view, config, now, low ? 'low' : 'gap'))) return
      // A move the user asked for skips the headroom gap and the selection cooldown, not the
      // guards that protect the session: it waited for the lock and a fresh account read too.
      if (reason === 'manual' && (await this.unsafeToMove(pane, lines))) return
      const why = low && from ? this.explained('low', from, target, view, { idle: reason === 'idle', assessment: leave!.assessment }) : undefined
      if (low && from) this.markLeftLow(from, now, pane.server)
      await this.moveTo(pane, from, target, reason, lines, signal, view, config, why)
    })
  }

  /** When the account being left is usable again, if that is known: the end of the window that
   *  is Low (a move that is advice), or the real end of its cooldown (a limit). */
  private sourceReset(from: Seat, assessment: Assessment | undefined, advisory: boolean, now: number, server: string | undefined): number | null {
    if (advisory) {
      const win = assessment?.low?.window
      const window = win === 's' ? from.usage.session : win === 'w' ? from.usage.weekly : win === 'm' ? from.usage.model : undefined
      if (window?.resetsAt && window.resetsAt > now) return window.resetsAt
    }
    const h = this.healthOf(from.key, server)
    return h?.resetKnown && h.cooldownUntil && h.cooldownUntil > now ? h.cooldownUntil : null
  }

  /** Smart, "use it or lose it": an idle session moves to an account whose weekly quota would
   *  otherwise expire unused. Advice, so every guard of an advisory move applies. */
  private async moveToExpiring(pane: PaneInfo, lines: readonly string[]): Promise<void> {
    await this.withLock(pane.agent, async () => {
      if (!(await this.allowed(pane.agent))) return
      const config = await this.config()
      if (!this.resumes(pane)) return
      const view = await this.accountsFor(pane.server)
      const now = this.deps.now()
      if (this.probation(pane.agent, now, pane.server)) return
      const at = this.locate(pane.terminalId, pane.agent, view)
      if (!at.seat) return
      const target = await this.expiringTarget(at.seat, pane.agent, view, pane.server, config, now)
      if (!target) return
      if (!(await this.advisoryOk(pane, at.seat, target, lines, view, config, now, 'expiring'))) return
      const why = this.explained('expiring', at.seat, target, view, { idle: true })
      await this.moveTo(pane, at.seat, target, 'expiring', [...lines], undefined, view, config, why)
    })
  }

  /** The account with expiring weekly quota that is a better place than `from` (smart.ts). */
  private async expiringTarget(
    from: Seat,
    provider: Provider,
    view: AccountView,
    server: string | undefined,
    config: Config,
    now: number
  ): Promise<Seat | null> {
    if (config.mode !== 'smart') return null
    const chain = buildChain(view.seats, provider, config)
    const samples = this.samplesOn(server)
    // Cheap test first: pane counts cost host calls.
    const any = chain.some((s) => s.key !== from.key && expiring(s, samples[s.key], now))
    if (!any) return null
    const context = await this.smartContext(provider, view, server, now)
    const ordered = Boolean(config.chain.trim())
    const candidate = (seat: Seat, index: number) => {
      const h = this.healthOf(seat.key, server)
      const t = seat.key === from.key ? 'A' : tier(seat, h, now)
      if (!t) return null
      return candidateOf(seat, t, strikesOf(h, now), h, context, config, now, {
        chainIndex: ordered ? index : 0,
        turn: index
      })
    }
    const current = candidate(from, chain.indexOf(from))
    const others = chain
      .map((s, i) => (s.key === from.key || isExcluded(s, config) ? null : candidate(s, i)))
      .filter((c): c is NonNullable<typeof c> => c !== null)
    return current ? (betterExpiring(current, others, config)?.seat ?? null) : null
  }

  /** Guards shared by moves that are advice, not necessity (threshold, idle, switch-back): the
   *  user's unsent text, the headroom gap, and the per-provider selection cooldown. */
  private async advisoryOk(
    pane: PaneInfo,
    from: Seat | undefined,
    target: Seat,
    lines: readonly string[],
    view: AccountView,
    config: Config,
    now: number,
    /** `gap`: the target must have clearly more room. `low`: the account being left is about to
     *  run out, so the target needs that much room itself. `switch-back`: a target without numbers
     *  is judged by `preferredOver` instead. `expiring`: the target is known and already ranked
     *  (smart.ts); headroom is not the point of that move. */
    rule: 'gap' | 'low' | 'switch-back' | 'expiring' = 'gap'
  ): Promise<boolean> {
    // What costs nothing comes first: the looks at the pane below each start an `orca` process
    // (live), and a turn ends often.
    const gapWaived = rule === 'expiring' || (rule === 'switch-back' && !target.usage.known)
    if (!gapWaived && !enoughGap(from, target, config, rule === 'low')) return false
    // Moving onto the seat Orca already selected changes nothing for other panes; a selection
    // change is what must not flap.
    if (view.active[target.provider] !== target.key && !this.canChangeSelection(target.provider, config, now, pane.server)) return false
    // `lines` were read before this move waited for its turn (the lock, a fresh account read):
    // look at the pane as it is now.
    if (await this.midTurn(pane)) {
      this.deps.log(`${pane.agent} ${pane.terminalId}: in the middle of a turn again, not moving it`)
      return false
    }
    // Advice is never urgent: the pane shown in the tab the user is on is left alone.
    if (config.activeTerminal !== 'now' && (await this.shownPane(pane)) !== false) {
      this.deps.log(`${pane.agent} ${pane.terminalId}: in the terminal tab the user is on, not moving it early`)
      return false
    }
    const box = await this.boxNow(pane, lines)
    if (box === UNCHECKED || (box !== null && !this.carriable(box, config))) {
      this.deps.log(`${pane.agent} ${pane.terminalId}: unsent text in the input box, not moving it`)
      return false
    }
    return true
  }

  /** What keeps a pane from being closed and resumed right now, whoever asked for the move: it is
   *  in the middle of a turn (`busy`), or its input box holds unsent text (`draft`). Null when
   *  neither. `lines` stand in when the pane cannot be read. */
  private async unsafeToMove(pane: PaneInfo, lines: readonly string[]): Promise<'busy' | 'draft' | null> {
    if (await this.midTurn(pane)) {
      this.deps.log(`${pane.agent} ${pane.terminalId}: in the middle of a turn, not moving it`)
      return 'busy'
    }
    if (await this.draftIn(pane, lines)) {
      this.deps.log(`${pane.agent} ${pane.terminalId}: unsent text in the input box, not moving it`)
      return 'draft'
    }
    return null
  }

  /** Is the pane in the middle of a turn right now? `unknown` when Orca cannot list the agents:
   *  that is never taken for "between turns". `gone` when Orca lists the workspace's agents and
   *  this pane is not among them: it was closed, so there is nothing to close, type into or hand
   *  off (it counts as not idle wherever only `idle` lets something happen). */
  private async turnState(pane: Pick<PaneInfo, 'terminalId' | 'workspaceId' | 'sessionId'>): Promise<'busy' | 'idle' | 'unknown' | 'gone'> {
    let agents: any[]
    try {
      agents = (await this.deps.host.call('agents.list', { workspaceId: pane.workspaceId }))?.agents
    } catch (error) {
      this.deps.log(`could not ask Orca whether ${pane.terminalId} is in the middle of a turn: ${String((error as Error)?.message ?? error)}`)
      return 'unknown'
    }
    if (!Array.isArray(agents)) return 'unknown'
    const row = rowOf(agents, pane)
    if (!row) return 'gone'
    return row.state !== 'waiting' && row.state !== 'done' ? 'busy' : 'idle'
  }

  /** Does another pane of the workspace run this pane's session? (False when Orca cannot say:
   *  the resume that follows a close then fails, and is said.) */
  private async runsElsewhere(pane: Pick<PaneInfo, 'terminalId' | 'workspaceId' | 'sessionId'>): Promise<boolean> {
    if (!pane.sessionId) return false
    const listing = await this.deps.host.call('agents.list', { workspaceId: pane.workspaceId }).catch(() => null)
    const agents: any[] = Array.isArray(listing?.agents) ? listing.agents : []
    return agents.some((a) => a && a.sessionId === pane.sessionId && a.terminalId && a.terminalId !== pane.terminalId)
  }

  /** In the middle of a turn, or possibly so (Orca cannot say): nothing closes the pane or types
   *  into it. */
  private async midTurn(pane: Pick<PaneInfo, 'terminalId' | 'workspaceId' | 'sessionId'>): Promise<boolean> {
    return (await this.turnState(pane)) !== 'idle'
  }

  /** Can this pane go on as the same session, with its context, on another account? Only then is
   *  it moved as advice (early, idle, expiring quota, switch-back). A service that hands off
   *  (Codex, Antigravity, OpenCode, Devin), or a pane Orca gives no session id for, would start a
   *  new session from a summary: that is done only at a real limit, or when the user asks. */
  private resumes(pane: Pick<PaneInfo, 'agent' | 'sessionId'>): boolean {
    return !!pane.sessionId && ADAPTERS[pane.agent].resume === 'by-session-id'
  }

  private canChangeSelection(provider: Provider, config: Config, now: number, server: string | undefined): boolean {
    const last = this.state.lastAutoSwitchAt?.[scopedKey(server, provider)] ?? 0
    return now - last >= config.switchCooldownMinutes * 60_000
  }

  /** Every change of the selection starts the switch cooldown: the plugin's own, and one the user
   *  made by moving a session with the command. Advice (switch-back, a Low account, expiring
   *  quota) that changed it again half a minute later would be a flap, with Orca's restart
   *  prompt shown twice. */
  private noteSelectionChange(provider: Provider, now: number, server: string | undefined): void {
    this.state.lastAutoSwitchAt = { ...(this.state.lastAutoSwitchAt ?? {}), [scopedKey(server, provider)]: now }
  }

  /** Switch-back (Orca issue #33193, tokenmaxx "return to primary"): a pane on a lower seat
   *  moves to the first healthy seat ahead of it in the chain. */
  async switchBack(pane: PaneInfo, lines: readonly string[]): Promise<void> {
    await this.withLock(pane.agent, async () => {
      if (!(await this.allowed(pane.agent))) return
      const config = await this.config()
      if (!config.switchBack) return
      // "At limit" never moves a running session back.
      if (config.runningSessions !== 'move') return
      if (!this.resumes(pane)) return
      const view = await this.accountsFor(pane.server)
      const now = this.deps.now()
      if (this.probation(pane.agent, now, pane.server)) return
      const at = this.locate(pane.terminalId, pane.agent, view)
      if (!at.seat) return
      const chain = buildChain(view.seats, pane.agent, config)
      // A running session only goes back to a seat that is known, or presumed reset.
      const preferred = preferredOver(chain, at.seat.key, this.healthOn(pane.server), config, now, 'pane', this.avoided(pane.agent, view, pane.server, config, now))
      if (!preferred) return
      if (!(await this.advisoryOk(pane, at.seat, preferred, lines, view, config, now, 'switch-back'))) return
      await this.moveTo(pane, at.seat, preferred, 'switch_back', [...lines], undefined, view, config)
    })
  }

  private async park(
    pane: PaneInfo,
    from: Seat | undefined,
    chain: Seat[],
    config: Config,
    reason: SwapReason,
    /** A wait that is not "every account is used up": for the source to reset (`hold`), or for a
     *  model's bucket (`model`). */
    special: { wakeAt?: number; hold?: 'short'; model?: string; why: string; notify: string } | undefined = undefined
  ) {
    const now = this.deps.now()
    if (!config.waitForReset) {
      // No other account has room, and waiting for one is off.
      const service = PROVIDER_NAME[pane.agent]
      this.record({ provider: pane.agent, terminalId: pane.terminalId, reason, result: 'failed', ...(from ? { from: from.key } : {}), detail: 'no account with room', why: `no other ${service} account has room, and When everything is used up is set to Stop` })
      await this.save()
      await this.deps.notify('Auto Hand-off', `${service}: no other account has room, and When everything is used up is set to Stop. The session stays where it is.`)
      this.publishNow()
      return
    }
    const wakeAt = special?.wakeAt ?? earliestReset(chain, this.healthOn(pane.server), now) ?? now + config.defaultCooldownMinutes * 60_000
    const entry: WaitingEntry = { terminalId: pane.terminalId, workspaceId: pane.workspaceId, agent: pane.agent, wakeAt }
    if (special?.hold) entry.hold = special.hold
    if (special?.model) entry.model = special.model
    if (pane.sessionId) entry.sessionId = pane.sessionId
    if (pane.agentId) entry.agentId = pane.agentId
    if (from) entry.fromSeat = from.key
    if (pane.server) entry.server = pane.server
    this.state.waiting = [...this.state.waiting.filter((w) => w.terminalId !== pane.terminalId), entry]
    this.record({ provider: pane.agent, terminalId: pane.terminalId, reason, result: 'waiting', ...(from ? { from: from.key } : {}), detail: `until ${clockWords(wakeAt, now)}`, why: special?.why ?? `every ${PROVIDER_NAME[pane.agent]} account is used up or cooling down; waiting for the earliest reset` })
    await this.save()
    const at = clockWords(wakeAt, now)
    await this.deps.notify('Auto Hand-off', special ? `${special.notify} The session continues at ${at}.` : `${PROVIDER_NAME[pane.agent]}: every account is used up. The session continues at ${at}.`)
    this.publishNow()
  }

  /** A sign that the user is at Orca (see `presenceAt`). */
  notePresence(): void {
    this.presenceAt = this.deps.now()
    this.signs++
  }

  /** How many signs of the user there have been: a move under way compares it with what it was
   *  when the move was let through (the clock may not have moved in between). */
  private signs = 0

  private present(config: Config): boolean {
    return this.deps.now() - this.presenceAt < config.presenceSeconds * 1000
  }

  /** Is the pane shown in the focused workspace's active tab (in a split tab: any of its panes)?
   *  Null when Orca cannot say, which is taken for yes. Being shown is not being watched: Orca
   *  cannot say whether anyone is in front of it, so a shown pane is handled with care
   *  (`activeGate`). */
  private async shownPane(pane: { terminalId: string; server?: string }): Promise<boolean | null> {
    const fn = this.deps.cli.visibleTerminals ?? this.deps.cli.activeTerminals
    if (!fn) return false
    let active: string[]
    try {
      active = await (pane.server ? fn.call(this.deps.cli, pane.server) : fn.call(this.deps.cli))
    } catch {
      return null
    }
    if (!Array.isArray(active)) return null
    if (!active.includes(pane.terminalId)) return false
    const context = await this.deps.host.call('workspace.readContext').catch(() => null)
    if (!context) return null
    return context.terminals.some((t: { id: string }) => t.id === pane.terminalId)
  }

  /** The pane's input box as it is now (its screen read afresh; `fallback` when that fails). */
  private async boxNow(pane: { terminalId: string; server?: string }, fallback: readonly string[]): Promise<Unsent> {
    const screen = await this.deps.host.call('terminal.read', { terminalId: pane.terminalId, maxLines: 80 }).catch(() => null)
    return this.unsentText(pane.terminalId, pane.server, screen?.lines ?? fallback)
  }

  /** Can this unsent text go with the session and be put back in the new pane? Plain text only:
   *  `[Image #1]` or `[Pasted text #1 +40 lines]` stand for content that stays in the old pane. */
  private carriable(text: string, config: Config): boolean {
    // Claude's "Press up to edit queued messages": messages already sent, waiting in the old
    // session for its turn to end. They cannot be carried over, and closing would lose them.
    if (QUEUED.test(text)) return false
    // Nor text too long to put back with one send, or that holds an escape sequence (the mark
    // that ends a paste, inside it, would end the paste early, and a line break after it would
    // send what follows).
    if (text.length > MAX_CARRY_CHARS || text.includes('\u001b')) return false
    return config.restoreUnsent && !/\[(Image|Pasted text)[^\]]*#\d+/.test(text)
  }

  /** A move that closes the pane at a limit, when the pane is the one shown in the focused tab
   *  (`Config.activeTerminal`). True: go ahead. False: it is held as a waiting entry that every
   *  tick looks at again (`activeMayGo`), the panel shows, and *Hand off now* or *Cancel* end. */
  private async activeGate(
    pane: PaneInfo,
    from: Seat | undefined,
    target: Seat,
    reason: SwapReason,
    model: string | undefined,
    view: AccountView,
    config: Config,
    /** The session is not handed off but goes on in the pane it is in, on `target`, its own
     *  account (`goOnThere`): said as that. */
    inPlace = false
  ): Promise<boolean> {
    if (config.activeTerminal === 'now') return true
    const parked = this.state.waiting.find((w) => w.terminalId === pane.terminalId)
    if (parked?.forceAt) return true
    if ((await this.shownPane(pane)) === false) return true
    const now = this.deps.now()
    const present = this.present(config)
    // "Ask me first" waits and counts down like "Wait, then count down" until it is answered; "Not
    // now" turns that entry into "Wait for me".
    const careful = (config.activeTerminal === 'careful' || config.activeTerminal === 'ask') && !parked?.declined
    const asking = config.activeTerminal === 'ask'
    if (careful && !present && parked?.countdownUntil !== undefined && parked.countdownUntil <= now && this.presenceAt <= (parked.countdownFrom ?? 0)) {
      return true
    }
    let entry = parked
    if (!entry) {
      entry = { terminalId: pane.terminalId, workspaceId: pane.workspaceId, agent: pane.agent, wakeAt: now, reason }
      if (model) entry.model = model
      if (pane.sessionId) entry.sessionId = pane.sessionId
      if (pane.agentId) entry.agentId = pane.agentId
      if (from) entry.fromSeat = from.key
      if (pane.server) entry.server = pane.server
      this.state.waiting = [...this.state.waiting, entry]
    }
    const first = entry.activeSince === undefined
    entry.activeSince ??= now
    if (first && asking) entry.asked = true
    // The input box as the hold starts: a change at the next look is the user typing.
    if (first) {
      const box = await this.boxNow(pane, [])
      if (box !== UNCHECKED) this.boxes.set(pane.terminalId, box ?? '')
    }
    entry.wakeAt = now
    entry.reason ??= reason
    const labels = displayLabels(view.seats, pane.agent)
    const to = labels.get(target.key) ?? target.label
    const service = PROVIDER_NAME[pane.agent]
    const freed = reason === 'reset'
    const what = freed ? `${service}: ${to} is free again.` : `${service} hit its limit.`
    // Each kind of notice is said at most once per hold, however often the user comes and goes:
    // the countdown, and that the session was not handed off. The panel shows the rest.
    let say: string | undefined
    let kind: 'countdown' | 'held' | undefined
    if (careful && !present) {
      if (entry.countdownUntil === undefined || this.presenceAt > (entry.countdownFrom ?? 0)) {
        entry.countdownFrom = now
        entry.countdownUntil = now + config.countdownSeconds * 1000
        say = inPlace
          ? `${what} The session on screen continues there in ${secondsWords(config.countdownSeconds)} unless you are using it.`
          : `${what} The session on screen hands off ${freed ? 'there' : `to ${to}`} in ${secondsWords(config.countdownSeconds)} unless you are using it.`
        kind = 'countdown'
      }
      if (first && asking) {
        say = `${what} Hand off the session on screen to ${to} now? Open Auto Hand-off and press Hand off now or Not now. If you do not answer, it hands off in ${secondsWords(config.countdownSeconds)}.`
        kind = 'countdown'
      }
    } else if (first && asking) {
      delete entry.countdownFrom
      delete entry.countdownUntil
      say = `${what} Hand off the session on screen to ${to} now? Open Auto Hand-off and press Hand off now or Not now. If you do not answer, it waits while you are using Orca, then counts down.`
      kind = 'held'
    } else {
      const counting = entry.countdownUntil !== undefined
      delete entry.countdownFrom
      delete entry.countdownUntil
      if (first || counting) {
        const when = `when you switch to another tab${careful ? ' or step away' : ''}, or press Hand off now in Auto Hand-off`
        say = inPlace ? `${what} The session on screen was left as it is. It continues there ${when}.` : `${what} The session on screen was not handed off. It hands off to ${to} ${when}.`
        kind = 'held'
      }
    }
    if (kind === 'countdown' && entry.toldCountdown) say = undefined
    else if (kind === 'held' && entry.toldHeld) say = undefined
    if (say && kind === 'countdown') entry.toldCountdown = true
    if (say && kind === 'held') entry.toldHeld = true
    if (first) {
      this.deps.log(`${pane.agent} ${pane.terminalId}: in the terminal tab the user is on, holding the move`)
      this.record({
        provider: pane.agent,
        terminalId: pane.terminalId,
        reason,
        result: 'waiting',
        ...(from ? { from: from.key } : {}),
        detail: 'the session on screen',
        why: `${freed ? `${to} is free again` : `${from ? (labels.get(from.key) ?? from.label) : service} hit its limit`}; it is the session on screen, so it hands off to ${to} once you leave it${careful ? ' or a countdown runs out with no sign of you' : ''}`
      })
    }
    await this.save()
    this.publishNow()
    if (say) await this.deps.notify('Auto Hand-off', say)
    return false
  }

  /** How long until the next countdown for a session on screen runs out, when one is running:
   *  the worker ticks then, so that hand-off is not up to a tick period late. Undefined when none
   *  is running (one that has run out is the ordinary tick's to look at). */
  countdownDueIn(): number | undefined {
    if (this.state.paused) return undefined
    const now = this.deps.now()
    const ends = this.state.waiting
      .filter((w) => w.countdownUntil !== undefined && w.countdownUntil > now && !w.draftAt && this.services[w.agent] !== false)
      .map((w) => w.countdownUntil!)
    return ends.length ? Math.min(...ends) - now : undefined
  }

  /** The tick's cheap look at a held active pane: whether `activeGate` may have something new to
   *  decide (so the move is tried again), without reading the accounts. Also notes typing in its
   *  input box as a sign of the user, and gives the one reminder of a long hold. */
  private async activeMayGo(w: WaitingEntry, config: Config): Promise<boolean> {
    const now = this.deps.now()
    const box = await this.boxNow(w, [])
    if (box !== UNCHECKED) {
      const text = box ?? ''
      const before = this.boxes.get(w.terminalId)
      if (before !== undefined && before !== text) this.notePresence()
      this.boxes.set(w.terminalId, text)
    }
    if (config.activeTerminal === 'now') return true
    if ((await this.shownPane(w)) === false) return true
    const careful = (config.activeTerminal === 'careful' || config.activeTerminal === 'ask') && !w.declined
    if (config.reminderMinutes > 0 && !w.reminded && w.activeSince !== undefined && now - w.activeSince >= config.reminderMinutes * 60_000) {
      w.reminded = true
      await this.save()
      await this.deps.notify(
        'Auto Hand-off',
        `${PROVIDER_NAME[w.agent]}: the session on screen has waited ${minutesWords(now - w.activeSince)} to hand off. Switch to another tab, or press Hand off now in Auto Hand-off.`
      )
    }
    if (!careful) {
      // "Wait for me" chosen (or *Not now* pressed) while a countdown ran: there is none any more.
      if (w.countdownUntil !== undefined) {
        delete w.countdownFrom
        delete w.countdownUntil
        await this.save()
        this.publishNow()
      }
      return false
    }
    if (this.present(config)) return w.countdownUntil !== undefined
    return w.countdownUntil === undefined || w.countdownUntil <= now || this.presenceAt > (w.countdownFrom ?? 0)
  }

  /** The order and the Skip list are changed from what the settings hold: while Orca could not be
   *  asked for them, a change would start from an empty list and write that over the stored one. */
  private listsKnown(config: Config): Config {
    if (config.held === 'settings') throw new Error("Orca's settings could not be read yet, so nothing was changed")
    return config
  }

  /** Custom order: the account order (`chain`) with `seatKey` moved `by` places in its service, as
   *  seat keys of every service in the project in focus. Accounts the order did not name keep
   *  their place after the named ones, as they do when the order is read. */
  async orderMoved(seatKey: string, by: -1 | 1): Promise<string> {
    const config = this.listsKnown(await this.config())
    const view = await this.accounts()
    const keys: string[] = []
    for (const provider of PROVIDERS) {
      const order = buildChain(view.seats, provider, config).map((s) => s.key)
      const i = order.indexOf(seatKey)
      const j = i + by
      if (i >= 0 && j >= 0 && j < order.length) [order[i], order[j]] = [order[j]!, order[i]!]
      keys.push(...order)
    }
    // Entries for accounts this project does not list (another Orca server's) are kept, after.
    const others = config.chain.split(',').map((t) => t.trim()).filter((t) => t && !namesAny(view.seats, t))
    return [...keys, ...others].join(', ')
  }

  /** The account card's "Skip" switch: the `exclude` list with this account added (as
   *  its seat key) or every entry that names it removed. */
  async excludedChanged(seatKey: string, excluded: boolean): Promise<string> {
    const config = this.listsKnown(await this.deps.config())
    const view = await this.accounts()
    const seat = view.seats.find((s) => s.key === seatKey)
    const entries = config.exclude.split(',').map((t) => t.trim()).filter(Boolean)
    if (!seat) return entries.join(', ')
    const rest = entries.filter((t) => !namesAny([seat], t))
    return (excluded ? [...rest, seat.key] : rest).join(', ')
  }

  /** Each service's account order as Auto or Custom order would try it (for the panel's arrows). */
  orderOf(view: AccountView, config: Config): Partial<Record<Provider, string[]>> {
    const out: Partial<Record<Provider, string[]>> = {}
    for (const provider of PROVIDERS) {
      const keys = buildChain(view.seats, provider, config).map((s) => s.key)
      if (keys.length) out[provider] = keys
    }
    return out
  }

  /** The panel's *Not now* to "Ask me first": the session on screen then waits until another tab is
   *  shown (or *Hand off now*), with no countdown. */
  async declineHandoff(terminalId: string): Promise<void> {
    const w = this.state.waiting.find((x) => x.terminalId === terminalId)
    if (!w) return
    // Answered already (a second press, or the panel's two buttons): nothing more to write.
    if (w.declined && w.countdownUntil === undefined && w.countdownFrom === undefined) return
    w.declined = true
    delete w.countdownFrom
    delete w.countdownUntil
    await this.save()
    this.publishNow()
  }

  /** The panel's *Hand off now* for a held session. Returns why it was not handed off, in a short
   *  sentence the panel shows, or undefined when it was. */
  async handoffNow(terminalId: string): Promise<string | undefined> {
    const w = this.state.waiting.find((x) => x.terminalId === terminalId)
    if (!w) return 'This session is no longer waiting to hand off.'
    if (this.state.paused) return 'Automatic hand-off is paused. Turn it on to hand off.'
    const config = await this.config()
    // (Not "turn it on": while the settings are held nobody turned it off.)
    if (config.held) return `${HELD_WORDS[config.held].title}. Nothing is handed off until then.`
    if (config.services[w.agent] === false) return `${PROVIDER_NAME[w.agent]}: automatic hand-off is off. Turn it on to hand off.`
    w.forceAt = this.deps.now()
    w.wakeAt = w.forceAt
    await this.save()
    const why = await this.wake(w)
    // Not moved (typing right then, unsent text that cannot go along, nowhere to go): the press
    // is not kept for later, when it would move the session without asking.
    const still = this.state.waiting.find((x) => x.terminalId === terminalId)
    if (still?.forceAt) {
      delete still.forceAt
      await this.save()
      this.publishNow()
    }
    return why
  }

  /** Puts text into a pane's input box without sending it, as one bracketed paste so a line break
   *  does not submit it. */
  private async paste(terminalId: string, text: string, server?: string): Promise<void> {
    const wrapped = `\u001b[200~${text}\u001b[201~`
    try {
      const { accepted } = await this.deps.host.call('terminal.sendText', { terminalId, text: wrapped, enter: false })
      if (accepted) return
    } catch {
      // Refused outside the focused workspace; the CLI has no such limit.
    }
    if (!this.deps.cli.typeText) throw new Error('cannot type without Enter')
    await (server ? this.deps.cli.typeText(terminalId, wrapped, server) : this.deps.cli.typeText(terminalId, wrapped))
  }

  /** Moves the session to `target`. Returns why it was not moved, in a short sentence (for the
   *  panel's *Hand off now*), or undefined once it was handed off. A failed hand-off is said and
   *  noted here, and its reason returned too. */
  private async moveTo(
    pane: PaneInfo,
    from: Seat | undefined,
    target: Seat,
    reason: SwapReason,
    lines: string[],
    signal: Signal | undefined,
    view: AccountView,
    config: Config,
    /** The reason line when Smart has a better one than the reason code alone. */
    explained?: string
  ): Promise<string | undefined> {
    let reselected = false
    const canResume = this.resumes(pane)
    const agentId = pane.agentId ?? pane.agent
    const service = PROVIDER_NAME[pane.agent]
    const toLabel = displayLabels(view.seats, pane.agent).get(target.key) ?? target.label
    // A limit, or the wake of a parked session, closes the pane too: never while its input box
    // holds unsent text. (Moves that are advice check this in `advisoryOk`.) These are also the
    // moves that interrupted work, after which the first message is typed.
    const closesUnasked = reason === 'rate_limit' || reason === 'auth' || reason === 'model_cap' || reason === 'reset'
    // A pane that is gone (the user closed it, or another look handed its session off while this
    // one waited its turn) is not handed off: resuming would start the session a second time.
    if ((await this.turnState(pane)) === 'gone') {
      this.deps.log(`${pane.agent} ${pane.terminalId}: the pane is gone, nothing to hand off`)
      return GONE
    }
    // The same session open in a second pane: Orca refuses to resume a session that still runs,
    // so this pane would be closed and nothing started in its place. It is left as it is.
    if (canResume && (await this.runsElsewhere(pane))) {
      this.deps.log(`${pane.agent} ${pane.terminalId}: its session also runs in another pane, not handing it off`)
      return 'The session also runs in another pane, so it was not handed off.'
    }
    const box = await this.boxNow(pane, lines)
    if (box === UNCHECKED) {
      if (closesUnasked) await this.holdForDraft(pane, from, target, reason, signal?.model, view, true)
      return `${NOT_CHECKED}.`
    }
    // Unsent text goes along only with a session that resumes as itself: a service that starts a
    // new session from a summary is busy with it for a while, so the text is not put back there.
    const goes = box === null || (canResume && this.carriable(box, config))
    if (closesUnasked) {
      // Such a pane waits for the text to be sent or cleared.
      if (!goes) {
        await this.holdForDraft(pane, from, target, reason, signal?.model, view, false, box ?? undefined)
        return cannotGo(service)
      }
      // Choosing the target read the accounts through the CLI (seconds, live): a turn the user
      // started meanwhile is never closed. Its end is a new event; a parked session is looked at
      // again at the next tick. When Orca cannot say, the move is held like one over unsent text.
      const turn = await this.turnState(pane)
      if (turn === 'unknown') {
        await this.holdForDraft(pane, from, target, reason, signal?.model, view, true)
        return `${NOT_CHECKED}.`
      }
      if (turn === 'gone') return GONE
      if (turn === 'busy') {
        this.deps.log(`${pane.agent} ${pane.terminalId}: in the middle of a turn again, not moving it`)
        return BUSY
      }
      if (!(await this.activeGate(pane, from, target, reason, signal?.model, view, config))) return 'The session on screen waits for you.'
    } else if (reason !== 'manual' && !goes) {
      // Advice (`advisoryOk` looked at the pane already, before the lock and the account read).
      this.deps.log(`${pane.agent} ${pane.terminalId}: unsent text in the input box, not moving it`)
      return cannotGo(service)
    }
    // Unsent text that goes with the session: put back in the new pane's input box. A hand-off by
    // hand over text that cannot go along is one the user agreed to (`forceTo`): it is not carried.
    const carry: string | null = box !== null && goes ? box : null
    // The wait this move carries out, if the session was waiting, and the signs of the user so
    // far: both are looked at again right before the session is closed.
    const pending = this.state.waiting.find((w) => w.terminalId === pane.terminalId)
    const signsBefore = this.signs
    // From here on the old pane may be gone (a failure before that leaves the session as it was).
    let closing = false
    this.moving.add(pane.terminalId)
    try {
      if (view.active[target.provider] !== target.key) {
        await this.selectOn(target.provider, target.accountId, pane.server)
        view.active[target.provider] = target.key
        for (const s of view.seats) if (s.provider === target.provider) s.active = s.key === target.key
        this.noteSelectionChange(target.provider, this.deps.now(), pane.server)
        reselected = true
      }
      // The last look, right before the pane is closed (or, for a service that starts a new
      // session, before that is launched): the account read and the selection took seconds, so
      // the input box is read twice, a moment apart, and Orca is asked again whether a turn runs.
      // Text being typed right now, or a turn the user started, is never closed. A limit move is
      // tried again at the next tick; advice waits for the next turn end.
      const whyLine = explained ?? this.why(reason, from, target, view, signal?.model ? { model: signal.model } : {})
      // A service that starts a new session: its summary is put together first (git is read,
      // live: up to seconds), so nothing but the launch stands between the last look and the close.
      const prompt = canResume ? '' : await this.handoffPrompt(pane, lines, signal, config)
      const look = await this.lastLook(pane, box, lines)
      if (look) {
        this.deps.log(`${pane.agent} ${pane.terminalId}: ${look === 'busy' ? 'in the middle of a turn again' : look === 'unchecked' ? 'could not check the session' : 'the input box is changing'}, not moving it now`)
        // It stays pending for the next tick, unless *Don't hand off* ended its wait meanwhile.
        const cancelled = !!pending && !this.state.waiting.includes(pending)
        if (closesUnasked && !cancelled) await this.waitAgain(pane, from, reason, signal?.model)
        return look === 'busy' ? BUSY : look === 'unchecked' ? `${NOT_CHECKED}.` : CHANGING
      }
      // Those same seconds are time for the user to answer. What they said meanwhile stands:
      // *Don't hand off* ended the wait, pausing (or the service's switch) stops every automatic
      // hand-off, and *Not now* or any other sign of them keeps the session on screen.
      if (reason !== 'manual') {
        if (pending && !this.state.waiting.includes(pending)) {
          this.deps.log(`${pane.agent} ${pane.terminalId}: no longer waiting to hand off, not moving it`)
          return 'This session is no longer waiting to hand off.'
        }
        // *Skip* turned on meanwhile for the account it was going to: not handed off there. A
        // session at a limit stays pending, and the next tick picks another account.
        if (isExcluded(target, await this.deps.config())) {
          this.deps.log(`${pane.agent} ${pane.terminalId}: ${toLabel} was set to Skip meanwhile, not handing off to it`)
          if (closesUnasked) await this.waitAgain(pane, from, reason, signal?.model)
          return `${toLabel} is set to Skip.`
        }
        if (!(await this.allowed(pane.agent))) {
          this.deps.log(`${pane.agent} ${pane.terminalId}: automatic hand-off was paused or turned off meanwhile, not moving it`)
          if (closesUnasked) await this.waitAgain(pane, from, reason, signal?.model)
          return `${service}: automatic hand-off is paused or off.`
        }
        const answered = pending?.declined || this.signs !== signsBefore
        if (pending?.activeSince !== undefined && !pending.forceAt && config.activeTerminal !== 'now' && answered && (await this.shownPane(pane)) !== false) {
          this.deps.log(`${pane.agent} ${pane.terminalId}: the user is at the session on screen again, not moving it now`)
          return 'The session on screen waits for you.'
        }
      }
      let newTerminal: string
      if (canResume) {
        // agent.resume refuses while the session still runs, so the old pane goes first.
        closing = true
        await this.closePane(pane)
        const resumed = await this.deps.host.call('agent.resume', {
          workspaceId: pane.workspaceId,
          agent: agentId,
          sessionId: pane.sessionId
        })
        newTerminal = resumed.terminalId
        if (!resumed.started) throw new Error('agent.resume did not start: the session already runs in another pane')
      } else {
        // A handoff starts a new session: launch it first and close the old pane only once the
        // new one exists, so a failed launch loses nothing.
        const launched = await this.deps.host.call('agent.launch', {
          workspaceId: pane.workspaceId,
          agent: agentId,
          prompt
        })
        newTerminal = launched.terminalId
        closing = true
        await this.closePane(pane)
      }
      // The resumed session redraws the same transcript, old banner included, possibly a while
      // after it starts: carry what this pane had already handled over to the new one.
      // With a session id the record is per session and carries over by itself.
      const carried = this.state.seen[pane.terminalId]
      this.forget(pane.terminalId)
      if (carried && canResume && !pane.sessionId) this.state.seen[newTerminal] = { ...carried }
      this.state.paneSeat[newTerminal] = target.key
      this.absentSince.delete(newTerminal)
      if (pane.server) this.remotePanes.add(newTerminal)
      this.state.waiting = this.state.waiting.filter((w) => w.terminalId !== pane.terminalId)
      const entry = this.record({
        provider: pane.agent,
        terminalId: newTerminal,
        reason,
        result: canResume ? 'resumed' : 'handoff',
        ...(from ? { from: from.key } : {}),
        to: target.key,
        why: whyLine
      })
      if (reason !== 'manual') this.startProbation(target, config, this.deps.now(), pane.server)
      await this.save()
      this.publishNow()
      // Why the first message was not typed into the resumed pane, if it was not.
      let left: 'busy' | 'draft' | 'unchecked' | 'untyped' | null = null
      if (canResume) {
        await this.waitReady(newTerminal, pane.workspaceId)
        await this.seedSeen(newTerminal, pane.agent, pane.sessionId)
        // The first message makes the agent work: it is typed only where work was interrupted (a
        // limit, or the wake of a session parked at one). A session that had finished its turn
        // and was moved as advice (early, idle, expiring quota, switch-back) or by hand is
        // resumed and left ready; typing there would start work nobody asked for.
        if (config.autoMessage && closesUnasked) {
          // The resumed pane takes a while to be ready, and the user can be in it already: typing
          // would send their unsent text with the message, or land in a turn they started.
          const resumed: PaneInfo = { ...pane, terminalId: newTerminal }
          const turn = await this.turnState(resumed)
          // (A resumed pane Orca does not list yet is typed into as before, once its box is known to be empty.)
          left = turn === 'busy' ? 'busy' : turn === 'unknown' ? 'unchecked' : await this.draftIn(resumed, [])
          if (left) this.deps.log(`${pane.agent} ${newTerminal}: ${left === 'busy' ? 'in the middle of a turn' : left === 'draft' ? 'unsent text in the input box' : 'could not check the pane'}, not typing the first message`)
          else {
            // The session is resumed on the new account whether or not the message gets through:
            // a send that fails must not turn the move into a failed one (below), which would set
            // the account the session now runs on aside.
            try {
              await this.type(newTerminal, config.autoMessage, pane.server)
            } catch (error) {
              left = 'untyped'
              this.deps.log(`${pane.agent} ${newTerminal}: could not type the first message: ${String((error as Error)?.message ?? error)}`)
            }
          }
        }
      }
      // The user's unsent text goes back into the new pane's input box, unsent, once the pane is
      // ready and its box is empty; after a first message, a moment later so it is not part of it.
      let restored: boolean | null = null
      if (carry) {
        restored = false
        try {
          if (!canResume) await this.waitReady(newTerminal, pane.workspaceId)
          else if (config.autoMessage && closesUnasked && !left) await this.deps.sleep(PASTE_AFTER_MESSAGE_MS)
          const box = await this.boxNow({ terminalId: newTerminal, ...(pane.server ? { server: pane.server } : {}) }, [])
          if (box === null) {
            await this.paste(newTerminal, carry, pane.server)
            restored = true
          } else this.deps.log(`${pane.agent} ${newTerminal}: the new input box is not empty, not putting the unsent text back`)
        } catch (error) {
          this.deps.log(`${pane.agent} ${newTerminal}: could not put the unsent text back: ${String((error as Error)?.message ?? error)}`)
        }
        // Not put back: the text is kept in full with the History entry, to copy from the panel.
        if (!restored) {
          entry.unsent = carry
          await this.save()
          this.publishNow()
        }
      }
      // The notification quotes the start of the text when it could not be put back (the whole
      // of it is in History; Orca shows no notification over 1000 characters); shortened when it was.
      const restoredNote =
        restored === true
          ? ` Your unsent text was put back in its input box: “${shortQuote(carry!)}”.`
          : restored === false
            ? ` Your unsent text could not be put back; it is kept in History: “${fullQuote(carry!)}”.`
            : ''
      // The notification gives the reason in words, and says that Orca's own restart prompt
      // (shown whenever the selected account changes) needs no action.
      const plain = reason !== 'manual'
      const body = plain ? `${service}: ${whyLine}.` : `${service}: handed off to ${toLabel}, as you chose.`
      const untyped =
        left === 'draft'
          ? ' The session has unsent text in its input box, so it is left for you to continue.'
          : left === 'unchecked'
            ? ' Orca could not be asked whether it is safe to type there, so the session is left for you to continue.'
            : left === 'untyped'
            ? ' The first message could not be typed, so the session is left for you to continue.'
            : ''
      await this.deps.notify('Auto Hand-off', `${body}${untyped}${restoredNote}${plain && reselected ? ` ${restartNote(config, pane.agent)}` : ''}`)
      return undefined
    } catch (error) {
      const message = String((error as Error)?.message ?? error)
      this.deps.log(`hand-off failed: ${message}`)
      // A session at a limit that is still there (the failure came before its pane was closed:
      // the account could not be selected, the new session not started) keeps waiting, so the next
      // tick tries the next account; the one that failed is skipped for a while (below). Never
      // forever: after MAX_HANDOFF_FAILURES in a row the wait ends, as it does for any other
      // failure, and when the user ended it meanwhile.
      const cancelled = !!pending && !this.state.waiting.includes(pending)
      const failures = (this.state.waiting.find((w) => w.terminalId === pane.terminalId)?.failures ?? 0) + 1
      const again = closesUnasked && !closing && !cancelled && failures < MAX_HANDOFF_FAILURES
      if (again) {
        await this.waitAgain(pane, from, reason, signal?.model)
        const kept = this.state.waiting.find((w) => w.terminalId === pane.terminalId)
        if (kept) {
          kept.failures = failures
          kept.wakeAt = this.deps.now()
          delete kept.forceAt
        }
      } else this.state.waiting = this.state.waiting.filter((w) => w.terminalId !== pane.terminalId)
      // A seat that could not be switched to is skipped for a while, so the rotation moves on to
      // a usable one instead of retrying a broken one (Orca PR #43578).
      const skipUntil = this.deps.now() + FAILED_SWITCH_SKIP_MS
      const h = this.healthOf(target.key, pane.server)
      if (!h?.cooldownUntil || h.cooldownUntil < skipUntil) {
        this.state.health[scopedKey(pane.server, target.key)] = cooled(h, this.deps.now(), skipUntil, `hand-off failed: ${message}`)
      }
      // The unsent text that was to go along is kept in full, whatever became of the old pane
      // (unless the pane was not closed and another account is tried: it is still in its box).
      this.record({ provider: pane.agent, terminalId: pane.terminalId, reason, result: 'failed', ...(from ? { from: from.key } : {}), to: target.key, detail: message.slice(0, 200), ...(carry && !again ? { unsent: carry } : {}) })
      await this.save()
      // Nothing was closed when another account is tried, so the text is still in the input box.
      const kept = carry && !again ? ` Your unsent text is kept in History: “${fullQuote(carry)}”.` : ''
      const next = again ? ' The session was not closed; another account is tried next.' : ''
      await this.deps.notify('Auto Hand-off', `${service}: hand-off to ${toLabel} failed: ${message.replace(/[.\s]+$/, '')}.${next}${kept}`)
      this.publishNow()
      return `Hand-off to ${toLabel} failed: ${message}`
    } finally {
      this.moving.delete(pane.terminalId)
      this.boxes.delete(pane.terminalId)
      // The pane was replaced: the next focus read starts afresh rather than count as the user.
      this.lastScene = undefined
    }
  }

  /** The look right before a pane is closed: its input box read twice, `SETTLE_MS` apart, must
   *  still be `expected`, and Orca must say it is between turns. Null when it may be closed;
   *  otherwise what stops it. A change in the box is the user typing (a read that failed is no
   *  sign of the user, only a reason not to close now). */
  private async lastLook(pane: PaneInfo, expected: string | null, lines: readonly string[]): Promise<'changed' | 'busy' | 'unchecked' | null> {
    const first = await this.boxNow(pane, lines)
    await this.deps.sleep(SETTLE_MS)
    const second = await this.boxNow(pane, lines)
    for (const box of [first, second]) {
      if (box === expected) continue
      if (box === UNCHECKED) return 'unchecked'
      this.notePresence()
      return 'changed'
    }
    const turn = await this.turnState(pane)
    return turn === 'idle' ? null : turn === 'busy' ? 'busy' : 'unchecked'
  }

  /** A limit move stopped at the last look: it stays pending, so the next tick tries again. */
  private async waitAgain(pane: PaneInfo, from: Seat | undefined, reason: SwapReason, model: string | undefined): Promise<void> {
    if (this.state.waiting.some((w) => w.terminalId === pane.terminalId)) return
    const entry: WaitingEntry = { terminalId: pane.terminalId, workspaceId: pane.workspaceId, agent: pane.agent, wakeAt: this.deps.now(), reason }
    if (model) entry.model = model
    if (pane.sessionId) entry.sessionId = pane.sessionId
    if (pane.agentId) entry.agentId = pane.agentId
    if (from) entry.fromSeat = from.key
    if (pane.server) entry.server = pane.server
    this.state.waiting = [...this.state.waiting, entry]
    await this.save()
    this.publishNow()
  }

  /** Unsent text in the pane's input box, as the pane is now (`lines` when it cannot be read):
   *  `draft`, or `unchecked` when Orca could not say. Either way the pane is not closed. */
  private async draftIn(pane: PaneInfo, lines: readonly string[]): Promise<'draft' | 'unchecked' | null> {
    const screen = await this.deps.host.call('terminal.read', { terminalId: pane.terminalId, maxLines: 80 }).catch(() => null)
    const box = await this.unsentText(pane.terminalId, pane.server, screen?.lines ?? lines)
    return box === null ? null : box === UNCHECKED ? 'unchecked' : 'draft'
  }

  /** The unsent text in a pane's input box (trimmed), null when there is none, or `UNCHECKED`
   *  when `orca terminal read` failed, timed out or gave no usable answer. Orca reports Claude
   *  Code's grey prompt suggestion and its fixed hints as `draft` too, and nothing tells a
   *  suggestion from typing, so it counts as unsent text; a fixed hint (`isClaudeHint`) is known
   *  by its exact wording and is no text. Live (Orca 1.4.263): `terminal.read` leaves that text
   *  out of its lines and only `orca terminal read` reports it, so Orca is asked, and the lines
   *  are looked at as well, for an Orca that leaves the text in them. */
  private async unsentText(terminalId: string, server: string | undefined, lines: readonly string[]): Promise<Unsent> {
    const ask = () => (server ? this.deps.cli.draft(terminalId, server) : this.deps.cli.draft(terminalId))
    const onScreen = draftOf(lines)
    if (onScreen !== null && !isClaudeHint(onScreen)) {
      // The screen shows text, so there is some whatever Orca answers. Orca's answer is the whole
      // of it; the screen gives one line, which can be a part (it is what goes with the session
      // and is put back, so a part would lose the rest).
      const whole = await ask().catch(() => undefined)
      return typeof whole === 'string' && whole.trim() !== '' && !isClaudeHint(whole) ? whole.trim() : onScreen
    }
    let text: string | undefined
    try {
      text = await ask()
    } catch (error) {
      this.deps.log(`could not ask Orca for unsent text in ${terminalId}: ${String((error as Error)?.message ?? error)}`)
      return UNCHECKED
    }
    if (typeof text !== 'string') {
      this.deps.log(`Orca gave no usable answer about unsent text in ${terminalId}`)
      return UNCHECKED
    }
    return text.trim() !== '' && !isClaudeHint(text) ? text.trim() : null
  }

  /** The pane holds unsent text, which closing it would throw away: it stays as it is, and the
   *  move stays pending as a waiting entry that every tick (and status event) looks at again.
   *  Noted in the history and said once per wait, not on every look. */
  private async holdForDraft(
    pane: PaneInfo,
    from: Seat | undefined,
    target: Seat,
    reason: SwapReason,
    model: string | undefined,
    view: AccountView,
    /** Orca could not say whether the pane is between turns with an empty input box: held the
     *  same way, and said as that, not as text the user typed. */
    unchecked = false,
    /** What the input box holds, when that is known: queued messages are said as that, not as
     *  text being typed. */
    text?: string
  ): Promise<void> {
    const parked = this.state.waiting.find((w) => w.terminalId === pane.terminalId)
    if (parked?.draftAt) return
    const now = this.deps.now()
    const labels = displayLabels(view.seats, pane.agent)
    const to = labels.get(target.key) ?? target.label
    const source = from ? (labels.get(from.key) ?? from.label) : undefined
    const service = PROVIDER_NAME[pane.agent]
    const queued = !unchecked && text !== undefined && QUEUED.test(text)
    this.deps.log(`${pane.agent} ${pane.terminalId}: ${unchecked ? 'could not check the session' : queued ? 'queued messages' : 'unsent text in the input box'}, not closing it`)
    if (parked) {
      parked.draftAt = now
      if (unchecked) parked.unchecked = true
      else delete parked.unchecked
      if (queued) parked.queued = true
      else delete parked.queued
    } else {
      const entry: WaitingEntry = { terminalId: pane.terminalId, workspaceId: pane.workspaceId, agent: pane.agent, wakeAt: now, draftAt: now, reason }
      if (model) entry.model = model
      if (pane.sessionId) entry.sessionId = pane.sessionId
      if (pane.agentId) entry.agentId = pane.agentId
      if (from) entry.fromSeat = from.key
      if (pane.server) entry.server = pane.server
      if (unchecked) entry.unchecked = true
      if (queued) entry.queued = true
      this.state.waiting = [...this.state.waiting, entry]
    }
    const waited = reason === 'reset'
    this.record({
      provider: pane.agent,
      terminalId: pane.terminalId,
      reason,
      result: 'waiting',
      ...(from ? { from: from.key } : {}),
      detail: unchecked ? 'could not check the session' : queued ? 'queued messages' : 'unsent text in the input box',
      why: `${waited ? `${to} is free` : `${source ?? service} hit its limit`}; the session hands off to ${to} once ${unchecked ? 'Orca can say that it is between turns with an empty input box' : queued ? 'its queued messages are sent or cleared' : 'the unsent text in its input box is sent or cleared'}`
    })
    await this.save()
    const what = waited ? `${service}: ${to} is free again.` : `${service} hit its limit${source ? ` on ${source}` : ''}.`
    await this.deps.notify(
      'Auto Hand-off',
      unchecked
        ? `${what} ${NOT_CHECKED}, so it was not handed off. It hands off to ${to} once that can be checked.`
        : queued
          ? `${what} The session has queued messages, which cannot go along. Once they are sent or cleared, the session hands off to ${to}.`
          : `${what} Send or clear the text you were typing and the session hands off to ${to}.`
    )
    this.publishNow()
  }

  /** A resumed session redraws its transcript, old limit banner included: that copy is not new. */
  private async seedSeen(terminalId: string, agent: Provider, sessionId?: string): Promise<void> {
    try {
      const { lines } = await this.deps.host.call('terminal.read', { terminalId, maxLines: 80 })
      const old = classify(agent, lines, this.deps.now())
      const key = this.seenKey(sessionId ? { terminalId, sessionId } : { terminalId })
      const had = this.state.seen[key]
      if (old && !(had && had.fingerprint === old.fingerprint && had.occurrences >= old.occurrences)) {
        this.remember(key, old.fingerprint, old.occurrences)
        await this.save()
      }
    } catch {
      // Unreadable: the next event classifies from scratch.
    }
  }

  private forget(terminalId: string): void {
    delete this.state.paneSeat[terminalId]
    delete this.state.seen[terminalId]
    delete this.state.apiRetries[terminalId]
    delete this.state.modelStep[terminalId]
  }

  private async closePane(pane: PaneInfo): Promise<void> {
    let failure: string | undefined
    try {
      await this.deps.host.call('terminal.close', { terminalId: pane.terminalId })
    } catch {
      // Refused outside the focused workspace; the CLI has no such limit.
      try {
        await this.closeOn(pane.terminalId, pane.server)
      } catch (error) {
        failure = String((error as Error)?.message ?? error)
      }
    }
    // agent.resume refuses while a pane still runs the session: wait until it is gone.
    for (let i = 0; i < 20; i++) {
      const { agents } = await this.deps.host.call('agents.list', { workspaceId: pane.workspaceId }).catch(() => ({ agents: [] }))
      if (!agents.some((a: any) => a.terminalId === pane.terminalId)) return
      await this.deps.sleep(500)
    }
    // Only a pane that is really still there is worth reporting (live: a close already under
    // way can make the CLI exit non-zero while the pane closes anyway).
    this.deps.log(`could not close ${pane.terminalId}${failure ? `: ${failure}` : ''}`)
  }

  private async waitReady(terminalId: string, workspaceId: string): Promise<void> {
    for (let i = 0; i < 60; i++) {
      await this.deps.sleep(1000)
      const { agents } = await this.deps.host.call('agents.list', { workspaceId }).catch(() => ({ agents: [] }))
      const row = agents.find((a: any) => a.terminalId === terminalId)
      if (row && (row.state === 'waiting' || row.state === 'done')) return
    }
  }

  private async type(terminalId: string, text: string, server?: string): Promise<void> {
    this.typedAt.set(terminalId, this.deps.now())
    try {
      const { accepted } = await this.deps.host.call('terminal.sendText', { terminalId, text, enter: true })
      if (accepted) return
    } catch {
      // Live Orca refuses plugin sends outside the focused workspace ("terminal is outside the
      // active worktree"); the CLI has no such limit.
    }
    await this.sendOn(terminalId, text, server)
    this.deps.log(`typed via orca CLI into ${terminalId}: ${text.slice(0, 40)}`)
  }

  private async handoffPrompt(pane: PaneInfo, lines: string[], signal: Signal | undefined, config: Config): Promise<string> {
    let branch = ''
    let status = ''
    let diff = ''
    try {
      const { workspaces } = await this.deps.host.call('workspace.list')
      const ws = workspaces.find((w: any) => w.id === pane.workspaceId)
      if (ws?.path) {
        branch = ws.branch ?? ''
        status = (await this.deps.cli.git(ws.path, ['status', '--short'])).replace(/\s+$/, '')
        diff = (await this.deps.cli.git(ws.path, ['diff', '--stat'])).replace(/\s+$/, '')
      }
    } catch (error) {
      this.deps.log(`handoff: git context unavailable: ${String((error as Error)?.message ?? error)}`)
    }
    // A hand-off that waited (for the session on screen, for unsent text, for a reset) comes from
    // the tick, with no banner in hand: it is read from the screen, where it still is.
    const now = this.deps.now()
    const banner = signal?.line ?? classify(pane.agent, lines, now)?.line
    // No line of the summary may be a limit banner itself: the new session shows its prompt, and
    // a banner at the start of a line there would read as a limit of the new account.
    const output = lines
      .filter((l) => l.trim() !== '' && !CHROME.test(l) && !/^[╭╰│─]/.test(l.trim()))
      .filter((l) => !(banner && l.includes(banner)) && !classify(pane.agent, [l], now))
      .slice(-40)
    // Orca takes a first message of at most ORCA_TEXT_MAX characters and refuses a longer one
    // whole (the hand-off would fail), so the summary never is longer, whatever the setting. What
    // gives way is the old output, oldest lines first; git's lists are cut to a part of the room.
    const max = Math.max(500, Math.min(config.handoffMaxChars, ORCA_TEXT_MAX))
    const clip = (text: string, room: number) => (text.length > room ? `${text.slice(0, Math.max(0, room - 1))}…` : text)
    status = clip(status, Math.floor(max / 5))
    diff = clip(diff, Math.floor(max / 5))
    const fixed = (tail: string) => [
      // The account is not named: its label is an email, and the summary is sent to the service as
      // a prompt from another account.
      `You are taking over a coding session that ${PROVIDER_NAME[pane.agent]} was running in this workspace.`,
      banner ? `It stopped because: ${banner}` : 'It was handed off to another account.',
      pane.title ? `Session title: ${cut(pane.title, 200)}` : '',
      branch ? `Branch: ${branch}` : '',
      status ? `git status --short:\n${status}` : '',
      diff ? `git diff --stat:\n${diff}` : '',
      tail ? `Last output of the previous agent:\n${tail}` : '',
      'First inspect the repository (git status, git diff) to see what is already done, then continue the task. Do not redo finished work.'
    ].filter(Boolean).join('\n\n')
    while (output.length && fixed(output.join('\n')).length > max) output.shift()
    const text = fixed(output.join('\n'))
    // (Still too long only with a title or a banner of thousands of characters.)
    return text.length > max ? `${text.slice(0, max - 1)}…` : text
  }

  // ---- periodic -------------------------------------------------------------------------

  /** Runs every 30 s: refresh usage, wake parked sessions, expire cooldowns. */
  async tick(): Promise<void> {
    const config = await this.config()
    this.noteConfig(config)
    const view = await this.accounts()
    const now = this.deps.now()
    let changed = this.pruneHistory()
    for (const [key, h] of Object.entries(this.state.health)) {
      if (h.cooldownUntil && h.cooldownUntil <= now) {
        // Only the cooldown ends here. Strikes count for 24 h, and a seat freed at a real reset
        // time is remembered as presumed reset.
        delete h.cooldownUntil
        delete h.reason
        h.freedAt = now
        changed = true
      }
      if (h.cooldownUntil) continue
      const struck = strikesOf(h, now) > 0
      if (!struck && (h.strikes !== undefined || h.strikeAt !== undefined)) {
        delete h.strikes
        delete h.strikeAt
        changed = true
      }
      const presumedReset = !!h.resetKnown && h.freedAt !== undefined && now - h.freedAt < STRIKE_TTL_MS
      if (!struck && !presumedReset) {
        delete this.state.health[key]
        changed = true
      }
    }
    for (const [scope, p] of Object.entries(this.state.probation ?? {})) {
      if (p && p.until <= now) {
        delete this.state.probation![scope]
        changed = true
      }
    }
    if (changed) await this.save()
    // Sessions whose turn ended while Orca could not say where their workspace runs were left
    // alone then: each is looked at again, as its event would have been (paused, or its service
    // off, a limit is only noted). One that still cannot be placed is kept for the next tick.
    for (const event of [...this.unplaced.values()]) {
      this.unplaced.delete(event.terminalId!)
      await this.look(event).catch((error) => this.deps.log(`look at ${event.terminalId} failed: ${String((error as Error)?.message ?? error)}`))
    }
    if (!this.state.paused) {
      for (const w of [...this.state.waiting]) {
        if (!config.services[w.agent]) continue
        const wServer = w.server ?? (await this.serverOfWorkspace(w.workspaceId))
        const wView = wServer === this.server ? view : await this.accountsFor(wServer)
        const chain = buildChain(wView.seats, w.agent, config)
        // A short wait ends at its time only; a wait for a model's bucket also ends once an
        // account is free that is not known to be full in that bucket.
        const sooner = w.hold
          ? null
          : w.model
            ? pickNext(chain, w.fromSeat, this.healthOn(wServer), config, now, { only: this.modelRoom(chain, w.model, now, true) })
            : pickNext(chain, undefined, this.healthOn(wServer), config, now)
        const ready = w.wakeAt <= now || sooner
        // A pane held in the tab the user is on is only tried again when that may have changed.
        if (ready && w.activeSince !== undefined && !w.forceAt && !(await this.activeMayGo(w, config))) continue
        // One waiting session whose look fails (storage, a send) does not keep the others, the
        // selection for new sessions and the idle sweep from their turn.
        if (ready) await this.wake(w).catch((error) => this.deps.log(`look at waiting ${w.terminalId} failed: ${String((error as Error)?.message ?? error)}`))
      }
      await this.reselectForLaunches(config)
      await this.sweepIdle(config)
    }
    await this.prunePanes()
    await this.refreshFocus()
    this.publishNow()
  }

  /** Forgets what is remembered per pane (`paneSeat`, `seen` by terminal, `apiRetries`,
   *  `modelStep`) for panes Orca has not listed for PANE_GONE_MS. Looked at on the tick, at most
   *  every PANE_PRUNE_EVERY_MS, only while the focused project is on this computer, and never
   *  while a move runs. Banners remembered per session (`session:<id>`) stay: a session can come
   *  back in a new pane. Passive, so it also runs while paused. */
  private async prunePanes(): Promise<void> {
    const now = this.deps.now()
    if (this.server || this.locked > 0 || now - this.panesPrunedAt < PANE_PRUNE_EVERY_MS) return
    this.panesPrunedAt = now
    const live = new Set<string>()
    try {
      const { workspaces, truncated } = await this.deps.host.call('workspace.list')
      // An incomplete list cannot show that a pane is gone.
      if (truncated) return
      for (const ws of workspaces as { id: string }[]) {
        const { agents } = await this.deps.host.call('agents.list', { workspaceId: ws.id })
        for (const row of agents) if (row.terminalId) live.add(row.terminalId)
      }
    } catch {
      // Orca could not say which panes exist: nothing is forgotten this time.
      return
    }
    // A move may have started while the panes were listed.
    if (this.locked > 0 || this.moving.size > 0) return
    // What is kept in memory per pane (its last state, when it was last typed into, its input
    // box) goes with a pane Orca no longer lists.
    for (const map of [this.paneStates, this.typedAt, this.boxes] as Map<string, unknown>[]) {
      for (const id of [...map.keys()]) if (!live.has(id) && !this.remotePanes.has(id)) map.delete(id)
    }
    const s = this.state
    const known = new Set([
      ...Object.keys(s.paneSeat),
      ...Object.keys(s.seen).filter((k) => !k.startsWith('session:')),
      ...Object.keys(s.apiRetries),
      ...Object.keys(s.modelStep)
    ])
    for (const id of [...this.absentSince.keys()]) if (!known.has(id)) this.absentSince.delete(id)
    let changed = false
    for (const id of known) {
      if (live.has(id) || this.inflight.has(id) || this.remotePanes.has(id) || s.waiting.some((w) => w.terminalId === id)) {
        this.absentSince.delete(id)
        continue
      }
      const since = this.absentSince.get(id)
      if (since === undefined) this.absentSince.set(id, now)
      else if (now - since >= PANE_GONE_MS) {
        this.forget(id)
        this.absentSince.delete(id)
        changed = true
      }
    }
    if (changed) await this.save()
  }

  /**
   * Changes the selected account, which only new launches use; running sessions are not touched.
   * - Switch-back (Custom order): a seat ahead of the selected one is healthy
   *   again.
   * - Auto and Custom order: the selected seat is Low or Out while a session on it is mid-turn, so
   *   it cannot move yet.
   * - Smart: another seat has weekly quota that would expire unused.
   * Every such change makes Orca show its own "sessions are still running… Restart" prompt, so it
   * happens at most once per switch cooldown, and the notification says why and that no restart
   * is needed.
   */
  private async reselectForLaunches(config: Config): Promise<void> {
    const server = this.server
    for (const provider of PROVIDERS) {
      if (!config.services[provider]) continue
      const view = await this.accountsFor(server)
      const now = this.deps.now()
      if (this.probation(provider, now, server)) continue
      // At most one such change per switch cooldown (checked first: it costs nothing).
      if (!this.canChangeSelection(provider, config, now, server)) continue
      if (!(await this.launchPlan(provider, view, server, config, now))) continue
      await this.withLock(provider, async () => {
        if (!(await this.allowed(provider))) return
        // A move this waited behind may have changed the selection a moment ago.
        if (!this.canChangeSelection(provider, config, this.deps.now(), server)) return
        const fresh = await this.accountsFor(server, true)
        const from = fresh.active[provider]
        if (this.probation(provider, this.deps.now(), server)) return
        // Only the selection moves, so a seat without numbers (and without strikes) is fine: at
        // worst one new session fails its first turn there, and the seat is struck.
        const plan = await this.launchPlan(provider, fresh, server, config, this.deps.now())
        if (!plan) return
        const preferred = plan.target
        try {
          await this.selectOn(provider, preferred.accountId, server)
        } catch (error) {
          const message = String((error as Error)?.message ?? error)
          this.deps.log(`switch back failed: ${message}`)
          this.state.health[scopedKey(server, preferred.key)] = cooled(this.healthOf(preferred.key, server), this.deps.now(), this.deps.now() + FAILED_SWITCH_SKIP_MS, `could not be selected: ${message}`)
          await this.save()
          return
        }
        fresh.active[provider] = preferred.key
        for (const s of fresh.seats) if (s.provider === provider) s.active = s.key === preferred.key
        this.noteSelectionChange(provider, this.deps.now(), server)
        this.startProbation(preferred, config, this.deps.now(), server)
        if (plan.leftLow) this.markLeftLow(plan.leftLow, this.deps.now(), server)
        this.record({ provider, reason: plan.reason, result: 'selected', ...(from ? { from } : {}), to: preferred.key, why: plan.why })
        await this.save()
        await this.deps.notify('Auto Hand-off', `${PROVIDER_NAME[provider]}: ${plan.why}. Only new sessions start on ${preferred.label}. ${restartNote(config, provider)}`)
        this.publishNow()
      })
    }
  }

  /** Which account new launches should use instead of the selected one, and why; null to leave
   *  the selection alone. */
  private async launchPlan(
    provider: Provider,
    view: AccountView,
    server: string | undefined,
    config: Config,
    now: number
  ): Promise<{ target: Seat; reason: SwapReason; why: string; leftLow?: Seat } | null> {
    const chain = buildChain(view.seats, provider, config)
    if (chain.length < 2) return null
    const selected = view.seats.find((s) => s.key === view.active[provider])
    const avoid = this.avoided(provider, view, server, config, now)
    const health = this.healthOn(server)
    const back = preferredOver(chain, view.active[provider], health, config, now, 'launch', avoid)
    if (back) return { target: back, reason: 'switch_back', why: this.why('switch_back', selected, back, view, { selectionOnly: true }) }
    if (!selected) return null
    const assessment = assess(selected, health[selected.key], this.recentOf(selected, server), config, now)
    if (assessment.state === 'out' || assessment.state === 'low') {
      const out = assessment.state === 'out'
      // Sessions between turns move by themselves, and take the selection with them. Only while
      // one is in the middle of a turn there (it cannot be moved) is the selection changed alone.
      if (!(await this.paneCounts(provider, view, server, true))[selected.key]) return null
      const context = config.strategy === 'smart' ? await this.smartContext(provider, view, server, now) : undefined
      // As for any move that is advice: a seat with known room, or, when the selected one cannot
      // work at all (at 100 %, or cooling down), one without numbers and without strikes.
      const target = pickNext(chain, selected.key, health, config, now, {
        mode: 'advisory',
        sourceExhausted: exhausted(selected, now) || (out && !assessment.over),
        avoid,
        ...(context ? { smart: context } : {})
      })
      if (!target || (!target.usage.known && strikesOf(health[target.key], now) > 0)) return null
      if (!out && !enoughGap(selected, target, config, true)) return null
      return {
        target,
        reason: 'threshold',
        why: this.explained(out ? 'out' : 'low', selected, target, view, { selectionOnly: true, assessment }),
        ...(out ? {} : { leftLow: selected })
      }
    }
    // Spending expiring quota is an early move: not with At limit, nor while the user is here.
    if (config.runningSessions !== 'move') return null
    const target = await this.expiringTarget(selected, provider, view, server, config, now)
    return target ? { target, reason: 'expiring', why: this.explained('expiring', selected, target, view, { selectionOnly: true }) } : null
  }

  /** A session idle on an over-threshold seat, or on a
   *  lower seat while a higher-priority one is healthy, is moved without waiting for its next
   *  turn. Only looked at when some seat gives a reason to. */
  private async sweepIdle(config: Config): Promise<void> {
    if (config.autoSwapIdleAfterSeconds <= 0) return
    const view = await this.accountsFor(this.server)
    const now = this.deps.now()
    const due = PROVIDERS.filter((p) => {
      if (!config.services[p] || this.probation(p, now, this.server)) return false
      const chain = buildChain(view.seats, p, config)
      if (chain.length < 2) return false
      const avoid = this.avoided(p, view, this.server, config, now)
      const samples = this.samplesOn(this.server)
      return chain.some(
        (s) =>
          this.leaving(s, this.server, config, now).leave ||
          preferredOver(chain, s.key, this.healthOn(this.server), config, now, 'pane', avoid) ||
          (config.mode === 'smart' && expiring(s, samples[s.key], now))
      )
    })
    if (due.length === 0) return
    let workspaces: { id: string; hostId?: string | null }[]
    try {
      workspaces = (await this.deps.host.call('workspace.list')).workspaces
    } catch {
      return
    }
    const idleMs = config.autoSwapIdleAfterSeconds * 1000
    // The expiring-quota target per account, looked up once per sweep.
    const expiringFor = new Map<string, Seat | null>()
    for (const ws of workspaces) {
      // Panes on a direct SSH target use that machine's own login: nothing to move them to. Nor
      // is anything moved while Orca cannot say where the workspace runs.
      const place = await this.placeOf(ws.id)
      if (!place || place.sshHost) continue
      let agents: any[]
      try {
        agents = (await this.deps.host.call('agents.list', { workspaceId: ws.id })).agents
      } catch {
        continue
      }
      const wsServer = parseServer(ws.hostId) ?? place.server
      const wsView = wsServer === this.server ? view : await this.accountsFor(wsServer)
      for (const row of agents) {
        const agent = providerOf(row.agent)
        if (!agent || !row.terminalId || !due.includes(agent)) continue
        if (row.state !== 'waiting' && row.state !== 'done') continue
        if (now - (row.stateStartedAt ?? now) < idleMs) continue
        if (this.inflight.has(row.terminalId) || this.state.waiting.some((w) => w.terminalId === row.terminalId)) continue
        // An idle move is advice: only a session that can resume as itself is moved (`resumes`).
        if (!this.resumes({ agent, sessionId: row.sessionId })) continue
        const seat = this.seatOf(row.terminalId, agent, wsView)
        if (!seat) continue
        const chain = buildChain(wsView.seats, agent, config)
        const over = this.leaving(seat, wsServer, config, now).leave
        const back = !over && !!preferredOver(chain, seat.key, this.healthOn(wsServer), config, now, 'pane', this.avoided(agent, wsView, wsServer, config, now))
        // Smart, "use it or lose it": another account's weekly quota would expire unused.
        const loseKey = `${wsServer ?? 'local'}|${seat.key}`
        if (!over && !back && !expiringFor.has(loseKey)) expiringFor.set(loseKey, await this.expiringTarget(seat, agent, wsView, wsServer, config, now))
        const lose = !over && !back && !!expiringFor.get(loseKey)
        if (!over && !back && !lose) continue
        const pane: PaneInfo = { terminalId: row.terminalId, workspaceId: ws.id, agent }
        if (row.agent !== agent) pane.agentId = row.agent
        if (row.sessionId) pane.sessionId = row.sessionId
        if (row.title) pane.title = row.title
        if (wsServer) pane.server = wsServer
        this.inflight.add(row.terminalId)
        try {
          const { lines } = await this.deps.host.call('terminal.read', { terminalId: row.terminalId, maxLines: 80 })
          // A limit banner on screen belongs to the status path, not to an idle move.
          if (classify(agent, lines, now)) continue
          if (over) await this.swap(pane, 'idle', lines)
          else if (back) await this.switchBack(pane, lines)
          else await this.moveToExpiring(pane, lines)
        } catch (error) {
          this.deps.log(`idle move of ${row.terminalId} failed: ${String((error as Error)?.message ?? error)}`)
        } finally {
          this.inflight.delete(row.terminalId)
        }
      }
    }
  }

  /** Looks at a waiting session and hands it off when it may go. Returns why it was not handed
   *  off (for the panel's *Hand off now*), or undefined when it was, or went on where it is. */
  private async wake(w: WaitingEntry): Promise<string | undefined> {
    return this.withLock(w.agent, async (): Promise<string | undefined> => {
      const service = PROVIDER_NAME[w.agent]
      // Cancelled, or carried out by another look at it, while this one waited for its turn.
      if (!this.state.waiting.includes(w)) return 'This session is no longer waiting to hand off.'
      if (!(await this.allowed(w.agent))) return `${service}: automatic hand-off is paused or off.`
      // The user went on in the parked pane, or the session already runs elsewhere: stop waiting.
      const listing = await this.deps.host.call('agents.list', { workspaceId: w.workspaceId }).catch(() => null)
      const agents: any[] = listing?.agents ?? []
      // Its row, by terminal id or (a background pane Orca lists without one) by session id.
      const row = rowOf(agents, w)
      const busy =
        // Anything but between turns: `blocked` (a permission question) is mid-turn too.
        (!!row && row.state !== 'waiting' && row.state !== 'done') ||
        agents.some((a: any) => w.sessionId && a.sessionId === w.sessionId && a.terminalId && a.terminalId !== w.terminalId)
      if (busy) {
        this.state.waiting = this.state.waiting.filter((x) => x.terminalId !== w.terminalId)
        await this.save()
        this.publishNow()
        return `${service}: the session is working again, so it no longer waits to hand off.`
      }
      // The parked pane is gone and the plugin did not close it (its own moves hold this lock and
      // end the wait themselves): the user closed it. Resuming would bring back what they closed.
      if (!this.moving.has(w.terminalId) && !row) {
        // Orca could not list the workspace: look again at the next tick, unless it is gone too.
        if (!listing && !(await this.workspaceGone(w))) return `${NOT_CHECKED}.`
        this.state.waiting = this.state.waiting.filter((x) => x.terminalId !== w.terminalId)
        this.forget(w.terminalId)
        this.record({ provider: w.agent, terminalId: w.terminalId, reason: w.reason ?? 'reset', result: 'closed', ...(w.fromSeat ? { from: w.fromSeat } : {}), detail: 'session closed', why: 'the waiting session was closed, so it is not resumed' })
        await this.save()
        this.deps.log(`${w.agent} ${w.terminalId}: the waiting pane was closed, not resuming its session`)
        this.publishNow()
        return 'The session was closed.'
      }
      const config = await this.config()
      if (w.draftAt) {
        // The move waits for unsent text: nothing to do, and nothing new to say, while it is there
        // and cannot go with the session.
        const screen = await this.deps.host.call('terminal.read', { terminalId: w.terminalId, maxLines: 80 }).catch(() => null)
        if (!screen) return `${NOT_CHECKED}.`
        const box = await this.unsentText(w.terminalId, w.server, screen.lines)
        if (box === UNCHECKED) return `${NOT_CHECKED}.`
        // As in `moveTo`: text goes along only with a session that resumes as itself. A service that
        // starts a new session keeps waiting for it, silently (it was said when the wait began).
        if (box !== null && !(this.resumes(w) && this.carriable(box, config))) return cannotGo(service)
        delete w.draftAt
        delete w.unchecked
        delete w.queued
      }
      const server = w.server ?? (await this.serverOfWorkspace(w.workspaceId))
      const view = await this.accountsFor(server, true)
      const now = this.deps.now()
      const chain = buildChain(view.seats, w.agent, config)
      const source = view.seats.find((s) => s.key === w.fromSeat)
      // The short wait is over and the account is back: the session continues where it is.
      if (w.hold === 'short' && source && isEligible(source, this.healthOf(source.key, server), now) && row) {
        return this.goOnThere(w, source, view, server, config)
      }
      // Before its time, a wait for a model's bucket ends only on an account not known to be full
      // in it.
      const early = w.model && w.wakeAt > now ? { only: this.modelRoom(chain, w.model, now, true) } : {}
      const context = config.strategy === 'smart' ? { smart: await this.smartContext(w.agent, view, server, now) } : {}
      // A model cap whose move waited for unsent text keeps its order: an account known to have
      // room for that model, then one not known to be full in it.
      const capped = w.reason === 'model_cap'
      const room = (unknownToo: boolean) =>
        pickNext(chain, w.fromSeat, this.healthOn(server), config, now, { only: this.modelRoom(chain, w.model, now, unknownToo), ...context })
      const target = capped
        ? (room(false) ?? room(true))
        : pickNext(chain, w.model && w.wakeAt > now ? w.fromSeat : undefined, this.healthOn(server), config, now, { ...early, ...context })
      if (!target) {
        // Its own account is one to Skip, so it is no target, but it has room again and no other
        // account has: staying on an account is not being handed off to it, so the session
        // continues where it is rather than wait for another account's reset.
        if (!w.model && source && row && isExcluded(source, config) && isEligible(source, this.healthOf(source.key, server), now)) {
          return this.goOnThere(w, source, view, server, config)
        }
        if (!config.waitForReset) {
          // "When everything is used up: Stop". The account this session was to go to has no room
          // any more (it was held for the session on screen, or for unsent text, meanwhile), or
          // the setting changed while it waited: it does not wait for a reset.
          this.state.waiting = this.state.waiting.filter((x) => x.terminalId !== w.terminalId)
          this.boxes.delete(w.terminalId)
          this.record({ provider: w.agent, terminalId: w.terminalId, reason: w.reason ?? 'reset', result: 'failed', ...(w.fromSeat ? { from: w.fromSeat } : {}), detail: 'no account with room', why: `no other ${service} account has room, and When everything is used up is set to Stop` })
          await this.save()
          await this.deps.notify('Auto Hand-off', `${service}: no other account has room, and When everything is used up is set to Stop. The session stays where it is.`)
          this.publishNow()
          return `No other ${service} account has room.`
        }
        // Nowhere to go any more: from here on it is an ordinary wait for a reset, and the panel
        // shows it as one (no question, no countdown). Its wake starts a hold afresh if the session
        // is still the one on screen then.
        delete w.reason
        for (const k of ['activeSince', 'countdownFrom', 'countdownUntil', 'asked', 'declined', 'reminded', 'toldCountdown', 'toldHeld'] as const) delete w[k]
        this.boxes.delete(w.terminalId)
        w.wakeAt = earliestReset(chain, this.healthOn(server), now) ?? now + config.defaultCooldownMinutes * 60_000
        await this.save()
        return `No other ${service} account has room.`
      }
      const pane: PaneInfo = { terminalId: w.terminalId, workspaceId: w.workspaceId, agent: w.agent }
      if (w.sessionId) pane.sessionId = w.sessionId
      if (w.agentId) pane.agentId = w.agentId
      if (server) pane.server = server
      const from = view.seats.find((s) => s.key === w.fromSeat)
      let lines: string[] = []
      let read = false
      try {
        lines = (await this.deps.host.call('terminal.read', { terminalId: w.terminalId, maxLines: 80 })).lines
        read = true
      } catch {
        // The parked pane may be gone already.
      }
      // The account with room is the one the session is on (its own limit reset first): the
      // session goes on in the pane it is in. Nothing is closed, and a service that cannot resume
      // keeps its conversation instead of starting a new session from a summary. With text in its
      // input box (or when Orca cannot say) it is handed off as before, which carries the text
      // along or waits for it.
      if (target.key === w.fromSeat && row && read && (await this.unsentText(w.terminalId, server, lines)) === null) {
        return this.goOnThere(w, target, view, server, config)
      }
      const reason = w.reason ?? 'reset'
      const why = reason === 'model_cap' && w.model ? this.why(reason, from, target, view, { model: w.model }) : undefined
      return this.moveTo(pane, from, target, reason, lines, undefined, view, config, why)
    })
  }

  /** A waiting session whose own account has room again goes on in the pane it is in: the first
   *  message is typed there, and nothing is closed. (Under the service's lock, from `wake`.) */
  private async goOnThere(w: WaitingEntry, source: Seat, view: AccountView, server: string | undefined, config: Config): Promise<string | undefined> {
    const service = PROVIDER_NAME[w.agent]
    const label = displayLabels(view.seats, w.agent).get(source.key) ?? source.label
    // A session held as the one on screen (it was to be handed off, and its own account got room
    // meanwhile) keeps the care its setting says: going on there types into it, so that waits as
    // the hand-off did, for the user to leave it, for the countdown, or for *Hand off now*.
    if (w.activeSince !== undefined) {
      const pane: PaneInfo = { terminalId: w.terminalId, workspaceId: w.workspaceId, agent: w.agent, ...(w.sessionId ? { sessionId: w.sessionId } : {}), ...(server ? { server } : {}) }
      if (!(await this.activeGate(pane, source, source, 'reset', w.model, view, config, true))) return 'The session on screen waits for you.'
    }
    const held = await this.deps.host.call('terminal.read', { terminalId: w.terminalId, maxLines: 80 }).catch(() => ({ lines: [] as string[] }))
    const box = await this.unsentText(w.terminalId, server, held.lines)
    // Orca cannot say whether typing is safe (the input box, or the turn): nothing is typed,
    // and the wait stays for the next tick to look again.
    if (box === UNCHECKED || (await this.turnState(w)) === 'unknown') return `${NOT_CHECKED}.`
    // Those reads took seconds (live: a CLI process, and the accounts before it): pausing, or the
    // service's switch, meanwhile stops this as it stops a hand-off. The wait stays.
    if (!(await this.allowed(w.agent))) {
      this.deps.log(`${w.agent} ${w.terminalId}: automatic hand-off was paused or turned off meanwhile, not typing into it`)
      return `${service}: automatic hand-off is paused or off.`
    }
    this.state.waiting = this.state.waiting.filter((x) => x.terminalId !== w.terminalId)
    this.boxes.delete(w.terminalId)
    if (box !== null) {
      // Typing the first message would send the user's unsent text with it: leave the pane alone.
      await this.save()
      await this.deps.notify('Auto Hand-off', `${service}: ${label} has reset. The session has unsent text in its input box, so it is left for you to continue.`)
      this.publishNow()
      return undefined
    }
    // The accounts were read afresh since the look at the pane above (live: seconds): a turn
    // the user started meanwhile is not typed into. They went on there, so the wait is over.
    if (await this.midTurn(w)) {
      this.deps.log(`${w.agent} ${w.terminalId}: in the middle of a turn again, not typing into it`)
      await this.save()
      this.publishNow()
      return BUSY
    }
    // A first message that cannot be typed (the send fails) must not pass for a session that
    // continues, nor stop the tick's look at the other waiting sessions: it is said, and the
    // session is left for the user.
    let typed = true
    if (config.autoMessage) {
      try {
        await this.type(w.terminalId, config.autoMessage, server)
      } catch (error) {
        typed = false
        this.deps.log(`${w.agent} ${w.terminalId}: could not type the first message: ${String((error as Error)?.message ?? error)}`)
      }
    }
    // With no first message set nothing is typed: the session is ready, not continuing.
    const silent = !config.autoMessage
    if (typed) this.record({ provider: w.agent, terminalId: w.terminalId, reason: 'reset', result: 'retried', from: source.key, to: source.key, why: silent ? `${label} has reset; no first message is set, so the session is left for you to continue` : `${label} has reset; the session continues there` })
    else this.record({ provider: w.agent, terminalId: w.terminalId, reason: 'reset', result: 'failed', from: source.key, detail: 'the first message could not be typed', why: `${label} has reset; the first message could not be typed, so the session is left for you to continue` })
    await this.save()
    await this.deps.notify(
      'Auto Hand-off',
      !typed
        ? `${service}: ${label} has reset. The first message could not be typed, so the session is left for you to continue.`
        : silent
          ? `${service}: ${label} has reset. No first message is set, so the session is left for you to continue.`
          : `${service}: ${label} has reset; the session continues there.`
    )
    this.publishNow()
    return undefined
  }

  /** True when Orca lists this computer's workspaces and the waiting entry's is not among them. */
  private async workspaceGone(w: WaitingEntry): Promise<boolean> {
    if (w.server) return false
    try {
      const { workspaces } = await this.deps.host.call('workspace.list')
      if (!Array.isArray(workspaces)) return false
      // Events name a workspace as `<repo>::<path>`; a row may carry another form of the id.
      const sep = w.workspaceId.indexOf('::')
      const repoId = sep > 0 ? w.workspaceId.slice(0, sep) : undefined
      const path = sep > 0 ? w.workspaceId.slice(sep + 2) : undefined
      return !workspaces.some((ws: any) => ws.id === w.workspaceId || (!!repoId && ws.projectId === repoId && ws.path === path))
    } catch {
      return false
    }
  }

  // ---- commands ---------------------------------------------------------------------------

  async selectSeat(seatKey: string, chosen?: (provider: Provider) => Promise<void>): Promise<string> {
    return this.selectSeatOn(await this.focusedServer(), seatKey, chosen)
  }

  /** The server of the project in focus now, noted as the one the panel shows. A choice made by
   *  hand settles it once, before the accounts are read (live: seconds): the focus can move to a
   *  project on another server meanwhile, whose accounts are other accounts under the same keys. */
  private async focusedServer(): Promise<string | undefined> {
    const server = await this.currentServer()
    this.server = server
    return server
  }

  private async selectSeatOn(server: string | undefined, seatKey: string, chosen?: (provider: Provider) => Promise<void>): Promise<string> {
    const view = await this.accountsFor(server, true)
    const seat = view.seats.find((s) => s.key === seatKey)
    if (!seat) throw Object.assign(new Error(`Unknown account ${seatKey}`), { code: 'invalid_params' })
    return this.withLock(seat.provider, async () => {
      const from = view.active[seat.provider]
      if (from !== seat.key) {
        await this.selectOn(seat.provider, seat.accountId, server)
        // A selection the user just made by hand is not changed again by advice (switch-back, a
        // Low account, expiring quota) within the switch cooldown: half a minute later would be a
        // flap, with Orca's restart prompt shown twice. A limit is still handled at once.
        this.state.lastAutoSwitchAt = { ...(this.state.lastAutoSwitchAt ?? {}), [scopedKey(server, seat.provider)]: this.deps.now() }
      }
      // Still under the lock: whatever automatic move waits behind this one sees what `chosen`
      // did (the panel's switch turns the service's automatic hand-off off) before it acts.
      await chosen?.(seat.provider)
      this.record({ provider: seat.provider, reason: 'manual', result: 'selected', ...(from ? { from } : {}), to: seat.key, why: this.why('manual', view.seats.find((s) => s.key === from), seat, view, { selectionOnly: true }) })
      await this.save()
      await this.accountsFor(server, true)
      this.publishNow()
      return `${PROVIDER_NAME[seat.provider]}: new sessions start on ${seat.label}`
    })
  }

  async selectNext(provider: Provider): Promise<string> {
    const config = await this.config()
    const server = await this.focusedServer()
    const view = await this.accountsFor(server, true)
    const chain = buildChain(view.seats, provider, config)
    const next = pickNext(chain, view.active[provider], this.healthOn(server), config, this.deps.now(), { mode: 'manual' })
    if (!next) return `${PROVIDER_NAME[provider]}: no other account with room`
    return this.selectSeatOn(server, next.key)
  }

  /** The panel's *Manual switch*: select the chosen account of its service for new launches and
   *  move the current terminal's pane over if it runs this service and is between turns. The
   *  worker then turns the service's automatic hand-off off, so the rotator never undoes a
   *  choice the user made by hand; the panel says so and offers the toggle. A limited account
   *  is refused. Returns what happened and whether anything was switched. `chosen` runs as soon
   *  as the account is selected, before any other move of that service can run.
   *
   *  Plain unsent text goes with the session, as with automatic moves (`carriable`, and only for
   *  a session that resumes as itself). Text that cannot go along (a pasted image or block,
   *  queued messages, or text in a session that starts anew) is not: the pane is not moved and
   *  nothing is selected; the text comes back as `draft`, with the pane it is in, and the panel
   *  asks. `acceptedDraft` is what the user then agreed to lose (the panel's second confirmation,
   *  nothing else, passes it): the pane moves only while it is that pane and its text is still
   *  exactly that; any other text is asked about again. */
  async forceTo(
    seatKey: string,
    chosen?: (provider: Provider) => Promise<void>,
    acceptedDraft?: { terminalId: string; text: string }
  ): Promise<{ message: string; switched: boolean; provider: Provider; draft?: { terminalId: string; text: string; queued?: boolean } }> {
    const config = await this.config()
    const server = await this.focusedServer()
    const view = await this.accountsFor(server, true)
    const seat = view.seats.find((s) => s.key === seatKey)
    if (!seat) throw Object.assign(new Error(`Unknown account ${seatKey}`), { code: 'invalid_params' })
    const provider = seat.provider
    const now = this.deps.now()
    const health = this.healthOf(seat.key, server)
    if (health?.cooldownUntil && health.cooldownUntil > now) {
      return { message: `${PROVIDER_NAME[provider]}: ${seat.label} is limited until ${clockWords(health.cooldownUntil, now)}; clear the cooldown first`, switched: false, provider }
    }
    if (view.active[provider] === seat.key) return { message: `${PROVIDER_NAME[provider]}: new sessions already start on ${seat.label}`, switched: false, provider }
    const agreed = (terminalId: string, text: string) => !!acceptedDraft && acceptedDraft.terminalId === terminalId && acceptedDraft.text.trim() === text
    // Text that goes with the session needs no answer: it is put back in the new pane.
    const goes = (pane: PaneInfo, text: string) => this.resumes(pane) && this.carriable(text, config)
    // Before anything is selected: would the pane in the tab move, and does it show unsent text
    // the user has not agreed to lose? Then the panel asks first, and nothing has changed yet.
    const ahead = await this.currentPane(provider)
    if (ahead && ahead.server === server && !ahead.sshHost && (ahead.state === 'waiting' || ahead.state === 'done') && this.locate(ahead.terminalId, provider, view).seat?.key !== seat.key) {
      const screen = await this.deps.host.call('terminal.read', { terminalId: ahead.terminalId, maxLines: 80 }).catch(() => null)
      // Unreadable: the pane is not moved at all (below), so there is nothing to ask.
      const turn = screen ? await this.turnState(ahead) : 'busy'
      const text = screen && turn === 'idle' ? await this.unsentText(ahead.terminalId, ahead.server, screen.lines) : null
      // Orca cannot say whether a turn runs there, or what the input box holds: said plainly, and
      // nothing changes. Agreeing to lose text does not apply: nobody knows what would be lost.
      if (turn === 'unknown' || text === UNCHECKED) {
        this.deps.log(`${provider} ${ahead.terminalId}: could not check the session, nothing switched`)
        return { message: `${PROVIDER_NAME[provider]}: Orca could not be asked whether this session is between turns with an empty input box, so nothing was handed off. Try again in a moment`, switched: false, provider }
      }
      if (text !== null && !goes(ahead, text) && !agreed(ahead.terminalId, text)) {
        this.deps.log(`${provider} ${ahead.terminalId}: unsent text that cannot go along, asking before moving it`)
        const queued = QUEUED.test(text)
        return {
          message: `${PROVIDER_NAME[provider]}: this session has ${queued ? 'queued messages' : 'unsent text'} that cannot go along; nothing was handed off`,
          switched: false,
          provider,
          draft: { terminalId: ahead.terminalId, text, ...(queued ? { queued: true } : {}) }
        }
      }
    }
    const selected = await this.selectSeatOn(server, seat.key, chosen)
    const pane = await this.currentPane(provider)
    // The focus moved to a project on another server meanwhile: the pane in front now runs on
    // other accounts, and is not the one the choice was made for.
    if (!pane || pane.server !== server) return { message: selected, switched: true, provider }
    if (pane.sshHost) return { message: `${selected}; this session runs on SSH target ${pane.sshHost} with that machine's own login and is left alone`, switched: true, provider }
    if (pane.state !== 'waiting' && pane.state !== 'done') return { message: `${selected}; this session keeps its account while it works`, switched: true, provider }
    let notMoved: string | undefined
    const moved = await this.withLock(provider, async () => {
      const fresh = await this.accountsFor(pane.server)
      const at = this.locate(pane.terminalId, provider, fresh)
      const target = fresh.seats.find((s) => s.key === seat.key)
      if (!target || target.provider !== provider || at.seat?.key === target.key) return null
      // Limited since the choice was made (another pane showed a banner while this waited).
      const cooling = this.healthOf(target.key, pane.server)?.cooldownUntil
      if (cooling && cooling > this.deps.now()) return null
      const screen = await this.deps.host.call('terminal.read', { terminalId: pane.terminalId, maxLines: 80 }).catch(() => null)
      // Unreadable: nothing shows that closing it is safe.
      if (!screen) return 'unchecked'
      // The user chose this account, so the guards of a move that is only advice (the headroom
      // gap, the selection cooldown, probation) do not apply. What protects the session does:
      // never in the middle of a turn, and never over unsent text that cannot go along, unless it
      // is exactly the text the user was shown and agreed to lose. Text that came or changed
      // since is theirs: the pane stays. (`moveTo` looks once more right before it closes.)
      const turn = await this.turnState(pane)
      if (turn === 'unknown' || turn === 'gone') return 'unchecked'
      if (turn === 'busy') {
        this.deps.log(`${pane.agent} ${pane.terminalId}: in the middle of a turn, not moving it`)
        return 'busy'
      }
      const again = await this.deps.host.call('terminal.read', { terminalId: pane.terminalId, maxLines: 80 }).catch(() => null)
      const text = await this.unsentText(pane.terminalId, pane.server, again?.lines ?? screen.lines)
      // Orca cannot say what the box holds now: not even text the user agreed to lose is known
      // to be all there is.
      if (text === UNCHECKED) return 'unchecked'
      const carried = text !== null && goes(pane, text)
      if (text !== null && !carried && !agreed(pane.terminalId, text)) {
        this.deps.log(`${pane.agent} ${pane.terminalId}: unsent text in the input box, not moving it`)
        return 'draft'
      }
      if (text !== null) this.deps.log(`${pane.agent} ${pane.terminalId}: ${carried ? 'moving it with its unsent text' : 'moving it over the unsent text the user agreed to lose'}`)
      const before = this.state.history.length
      notMoved = await this.moveTo(pane, at.seat, target, 'manual', [...screen.lines], undefined, fresh, config)
      return this.state.history.length > before ? this.state.history.at(-1)! : null
    })
    if (moved === 'busy') return { message: `${selected}; this session keeps its account while it works`, switched: true, provider }
    if (moved === 'draft') return { message: `${selected}; this session has unsent text in its input box and keeps its account`, switched: true, provider }
    if (moved === 'unchecked') return { message: `${selected}; Orca could not be asked about this session, so it was not handed off and keeps its account`, switched: true, provider }
    if (moved && (moved.result === 'resumed' || moved.result === 'handoff')) return { message: `${selected}; this session was handed off${moved.result === 'handoff' ? ' (as a new session)' : ''}`, switched: true, provider }
    if (notMoved) return { message: `${selected}. ${notMoved.replace(/[.\s]+$/, '')}`, switched: true, provider }
    return { message: `${selected}; this session keeps its account until it is relaunched`, switched: true, provider }
  }

  /** The agent in the current terminal tab of the focused workspace, if it runs `provider`. */
  private async currentPane(provider: Provider): Promise<(PaneInfo & { state: string }) | null> {
    try {
      const server = await this.currentServer()
      const [{ agents }, context, active] = await Promise.all([
        this.deps.host.call('agents.list'),
        this.deps.host.call('workspace.readContext'),
        this.activeTerminalsOn(server)
      ])
      if (!context?.workspaceId) return null
      const row = agents.find((a: any) => providerOf(a.agent) === provider && a.terminalId && active.includes(a.terminalId))
      if (!row) return null
      const pane: PaneInfo & { state: string } = { terminalId: row.terminalId, workspaceId: context.workspaceId, agent: provider, state: row.state }
      if (row.agent !== provider) pane.agentId = row.agent
      if (row.sessionId) pane.sessionId = row.sessionId
      if (row.title) pane.title = row.title
      if (server) pane.server = server
      // (Where Orca cannot say where the workspace runs, there is no pane to move by hand either.)
      const place = await this.placeOf(context.workspaceId)
      if (!place) return null
      if (place.sshHost) pane.sshHost = place.sshHost
      return pane
    } catch {
      return null
    }
  }

  async swapFocused(): Promise<string> {
    const { agents } = await this.deps.host.call('agents.list')
    const context = await this.deps.host.call('workspace.readContext')
    // The agent in the terminal tab in front is the one meant; without a layout listing (or with
    // no agent in that tab), the first agent between turns, as before.
    const active = await this.activeTerminalsOn(await this.currentServer())
    const row =
      agents.find((a: any) => providerOf(a.agent) && a.terminalId && active.includes(a.terminalId)) ??
      // (Orca lists a background pane that was never shown without a terminal id: not one to act on.)
      agents.find((a: any) => providerOf(a.agent) && a.terminalId && (a.state === 'waiting' || a.state === 'done')) ??
      agents.find((a: any) => providerOf(a.agent) && a.terminalId)
    if (!row || !context?.workspaceId) return 'No agent in the focused workspace'
    // Moving closes the pane: never in the middle of a turn.
    const name = PROVIDER_NAME[providerOf(row.agent)!]
    if (row.state !== 'waiting' && row.state !== 'done') return `${name}: this session is in the middle of a turn; run the command again once it has finished`
    const place = await this.placeOf(context.workspaceId)
    if (!place) return `${name}: Orca could not be asked where this session runs; it was not handed off`
    if (place.sshHost) return `${name}: this session runs on SSH target ${place.sshHost}; Orca manages no accounts there`
    const server = place.server
    const pane: PaneInfo = { terminalId: row.terminalId, workspaceId: context.workspaceId, agent: providerOf(row.agent)! }
    if (row.agent !== pane.agent) pane.agentId = row.agent
    if (row.sessionId) pane.sessionId = row.sessionId
    if (server) pane.server = server
    const { lines } = await this.deps.host.call('terminal.read', { terminalId: row.terminalId, maxLines: 80 })
    // Moving closes the pane, and with it whatever is typed in its input box.
    const box = await this.unsentText(pane.terminalId, pane.server, lines)
    if (box === UNCHECKED || (await this.turnState(pane)) === 'unknown') return `${name}: Orca could not be asked whether this session is between turns with an empty input box; it was not handed off`
    if (box !== null) return `${name}: this session has unsent text in its input box; send or clear it first`
    const before = this.state.history.length
    await this.swap(pane, 'manual', lines)
    const last = this.state.history.length > before ? this.state.history.at(-1) : undefined
    if (!last) return `${name}: nothing to do`
    const view = this.views.get(server ?? 'local')?.view ?? this.view
    const label = (key?: string) => view?.seats.find((s) => s.key === key)?.label ?? key ?? '?'
    if (last.result === 'resumed' || last.result === 'handoff') return `${name}: handed off to ${label(last.to)}`
    if (last.result === 'selected') return `${name}: new sessions start on ${label(last.to)}`
    return `${name}: ${last.result}${last.detail ? ` — ${last.detail}` : ''}`
  }

  async setPaused(paused: boolean): Promise<void> {
    this.state.paused = paused
    await this.save()
    this.publishNow()
  }

  async cancelWaiting(terminalId: string): Promise<void> {
    this.state.waiting = this.state.waiting.filter((w) => w.terminalId !== terminalId)
    this.boxes.delete(terminalId)
    await this.save()
    this.publishNow()
  }

  /** The panel's *Clear*: `seatKey` is an account of the project in focus (the panel lists those). */
  async clearCooldown(seatKey: string): Promise<void> {
    delete this.state.health[scopedKey(this.server, seatKey)]
    await this.save()
    this.publishNow()
  }

  /** The History the panel is sent: the last 7 days, at most 100 entries, and no more of them
   *  (newest first) than fit a message to the panel with room to spare for the rest. Entries that
   *  keep unsent text come first, older than the last 100 too: the panel is the only place to
   *  copy that text from. They get half the room at most (the newest of them always goes), so
   *  the latest entries are still shown beside them. */
  private shownHistory(now: number): HistoryEntry[] {
    const week = this.state.history.filter((h) => h.at >= now - HISTORY_MAX_AGE_MS)
    const recent = week.slice(-100)
    const shown = new Set<HistoryEntry>()
    let bytes = 0
    // (The newest entry always goes, whatever its size: it is what just happened.)
    const newest = recent.at(-1)
    if (newest) {
      shown.add(newest)
      bytes += jsonBytes(newest)
    }
    let kept = 0
    for (let i = week.length - 1; i >= 0; i--) {
      const h = week[i]!
      if (!h.unsent || shown.has(h)) continue
      const size = jsonBytes(h)
      if (kept > 0 && (kept + size > SNAPSHOT_HISTORY_BYTES / 2 || bytes + size > SNAPSHOT_HISTORY_BYTES)) break
      shown.add(h)
      kept += size
      bytes += size
    }
    for (let i = recent.length - 2; i >= 0; i--) {
      const h = recent[i]!
      if (shown.has(h)) continue
      bytes += jsonBytes(h)
      if (bytes > SNAPSHOT_HISTORY_BYTES) break
      shown.add(h)
    }
    return shown.size === week.length ? week : week.filter((h) => shown.has(h))
  }

  snapshot(): Snapshot {
    const entry = this.views.get(this.server ?? 'local')
    const view = entry?.view ?? this.view ?? { seats: [], active: {} }
    const updatedAt = entry ? entry.at : this.viewAt
    const error = entry ? entry.error : this.viewError
    const now = this.deps.now()
    const snap: Snapshot = {
      paused: this.state.paused,
      updatedAt,
      seats: view.seats.map((s) => {
        const h = this.healthOf(s.key, this.server)
        const { liveKeys: _liveKeys, ...seat } = s
        // The history covers this computer's accounts only.
        const runway = this.server ? null : runwayMs(this.samples.seats[s.key]?.recent ?? [], now)
        return {
          ...seat,
          ...(this.lastConfig && isExcluded(s, this.lastConfig) ? { excluded: true } : {}),
          ...(runway !== null ? { runwayMs: Math.round(runway) } : {}),
          ...(h?.cooldownUntil ? { cooldownUntil: h.cooldownUntil } : {}),
          ...(h?.reason ? { cooldownReason: h.reason } : {})
        }
      }),
      waiting: this.state.waiting,
      history: this.shownHistory(now),
      services: { ...this.services }
    }
    if (this.held) snap.held = this.held
    if (this.mode) snap.mode = this.mode
    if (this.chosenConfig) snap.activeTerminal = this.chosenConfig.activeTerminal
    if (this.atLimitOnly) snap.atLimitOnly = true
    else if (this.chosenConfig && this.userHere(this.chosenConfig)) snap.userHere = true
    // Custom order: the panel lists each service's accounts in that order, with arrows.
    if (this.mode === 'my-order' && this.lastConfig) snap.order = this.orderOf(view, this.lastConfig)
    if (this.focused) snap.focused = this.focused
    if (this.server) snap.server = this.server
    if (this.sshHost) snap.sshHost = this.sshHost
    if (error) snap.error = error
    return snap
  }

  publishNow(): void {
    this.deps.publish(this.snapshot())
  }
}
