// The rotator: reacts to agent status, classifies the terminal tail, and swaps seats.
// Every side effect goes through Deps so tests run it with a fake host, CLI and clock.
import { ADAPTERS, CHROME, classify, countCopies, draftOf, isClaudeHint, parseModelFallback } from './adapters'
import { parseAccounts, type AccountView } from './accounts'
import { PROVIDER_NAME, displayLabels, whyMove } from './labels'
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
  overThreshold,
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
  git(cwd: string, args: string[]): Promise<string>
  /** The terminals in the active tab of every workspace (`orca terminal list
   *  --include-visual-layouts`); the host API does not say which pane is focused. */
  activeTerminals?(server?: string): Promise<string[]>
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

/** How long a seat that failed to switch is skipped. */
const FAILED_SWITCH_SKIP_MS = 10 * 60_000
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
function restartNote(config: Config): string {
  const moves = config.runningSessions === 'move' && config.autoResume
  return `Orca may now offer to restart your running sessions: you do not need to. They keep working on the account they are on${moves ? ', and Auto Hand-off moves each one by itself between turns or when it is idle' : ''}.`
}

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
  /** How the plugin decides (from settings, `auto` resolved), and the one-time note about it. */
  mode: Mode | undefined
  private modeNotice: string | undefined
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
  /** One `orca account list` at a time: the timer, the panel and commands share it (~3 s). */
  /** In-flight `orca account list` per server. */
  private listings = new Map<string, Promise<AccountView>>()
  private followUp = 0
  private disposed = false
  /** Moves (and anything else under a provider's lock) running or queued right now. */
  private locked = 0
  /** Panes the plugin itself is closing or moving right now. */
  private moving = new Set<string>()
  /** Panes on a remote Orca server: this computer's listing may not carry them. */
  private remotePanes = new Set<string>()
  /** Since when a remembered pane has been missing from `agents.list` (see `prunePanes`). */
  private absentSince = new Map<string, number>()
  private panesPrunedAt = 0

  constructor(private deps: Deps) {
    // Every account switch the plugin makes goes through here: note it, and read usage again
    // shortly after, because a switch is what makes Orca fetch its inactive accounts.
    const select = deps.cli.select.bind(deps.cli)
    this.deps = {
      ...deps,
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
    const saved = await this.deps.loadState()
    this.state = { ...emptyState(), ...(saved ?? {}) }
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
    this.noteConfig(await this.deps.config())
    if (publish) this.publishNow()
  }

  /** Keeps what the panel shows of the settings: the services, the mode and its note. */
  private noteConfig(config: Config): void {
    this.services = { ...config.services }
    this.mode = config.mode
    this.modeNotice = config.notice
  }

  /** The panel's note about `custom` mode was read. */
  async dismissNotice(): Promise<void> {
    this.state.customNoticeSeen = true
    await this.save()
    this.publishNow()
  }

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
    await this.deps.saveState(this.state)
  }

  private record(entry: Omit<HistoryEntry, 'at'>): void {
    this.state.history.push({ at: this.deps.now(), ...entry })
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

  /** Smart or Follow my order: the modes that look ahead. `custom` and `manual` never do. */
  private looksAhead(config: Config): boolean {
    return config.mode === 'smart' || config.mode === 'my-order'
  }

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
   *  or Low right now. Empty in `custom` and `manual`. */
  private avoided(provider: Provider, view: AccountView, server: string | undefined, config: Config, now: number): Set<string> {
    const avoid = new Set<string>()
    if (!this.looksAhead(config)) return avoid
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
    const config = await this.deps.config()
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
        if (this.clearStrikesByReading(parsed.seats, config, now) || freed) await this.save()
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
  private clearStrikesByReading(seats: readonly Seat[], config: Config, now: number): boolean {
    let changed = false
    for (const seat of seats) {
      const h = this.state.health[seat.key]
      if (!h || strikesOf(h, now) === 0) continue
      const u = seat.usage
      if (!u.known || (u.source !== undefined && u.source !== 'live')) continue
      if (u.asOf !== undefined && u.asOf <= (h.strikeAt ?? 0)) continue
      if (overThreshold(seat, config, now)) continue
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
    const fn = this.deps.cli.activeTerminals
    if (!fn) return Promise.resolve([])
    return (server ? fn.call(this.deps.cli, server) : fn.call(this.deps.cli)).catch(() => [] as string[])
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
    const config = await this.deps.config()
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
      const [{ agents }, active] = await Promise.all([
        this.deps.host.call('agents.list'),
        this.activeTerminalsOn(nextServer)
      ])
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
    if (await this.refreshFocus()) this.publishNow()
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
      const server = await this.serverOfWorkspace(workspaceId, event.workspaceListId)
      if (server) {
        pane.server = server
        this.remotePanes.add(pane.terminalId)
      }
      const sshHost = await this.sshTargetOfWorkspace(workspaceId)
      if (sshHost) pane.sshHost = sshHost
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
    const config = await this.deps.config()
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
        await this.deps.notify('Auto Hand-off', `${PROVIDER_NAME[pane.agent]} hit a limit on SSH target ${pane.sshHost}; Orca manages no accounts there, so the pane was left alone.`)
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
        if (this.looksAhead(config) && (await this.modelRoomElsewhere(pane, signal, config))) {
          return this.limitHit(pane, signal, config, lines, 'model_cap')
        }
        if (await this.fallbackModel(pane, config, signal, lines)) return
        return this.limitHit(pane, signal, config, lines, 'model_cap')
      case 'auth':
        return this.limitHit(pane, signal, config, lines, 'auth')
      case 'rate_limit':
        return this.limitHit(pane, signal, config, lines, 'rate_limit')
    }
  }

  private async retryApiError(pane: PaneInfo, config: Config, signal: Signal): Promise<void> {
    if (!config.retryOnApiError) return
    const attempt = this.state.apiRetries[pane.terminalId] ?? 0
    if (attempt >= config.maxApiRetries) {
      this.record({ provider: pane.agent, terminalId: pane.terminalId, reason: 'api_error', result: 'failed', detail: `gave up after ${attempt} retries` })
      await this.save()
      await this.deps.notify('Auto Hand-off', `${pane.agent}: API errors persist after ${attempt} retries.`)
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
    const row = agents.find((a: any) => a.terminalId === pane.terminalId)
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
    this.state.modelStep[pane.terminalId] = step + 1
    await this.type(pane.terminalId, adapter.modelSwitch(model), pane.server)
    await this.deps.sleep(1500)
    if (config.autoMessage) await this.type(pane.terminalId, config.autoMessage, pane.server)
    this.record({ provider: pane.agent, terminalId: pane.terminalId, reason: 'model_cap', result: 'model', detail: `${signal.model ?? 'model'} capped → ${model}` })
    await this.save()
    this.publishNow()
    return true
  }

  private async limitHit(pane: PaneInfo, signal: Signal, config: Config, lines: string[], reason: SwapReason): Promise<void> {
    if (!config.autoSwitchOnRateLimit) {
      await this.withLock(pane.agent, async () => {
        const view = await this.accountsFor(pane.server, true)
        const at = this.locate(pane.terminalId, pane.agent, view)
        if (at.seat && (at.known || this.plausiblyLimited(at.seat))) await this.coolDown(at.seat, signal, config, reason, pane.server)
        await this.deps.notify('Auto Hand-off', `${pane.agent} hit a limit on ${at.seat?.label ?? 'its account'}; switching on rate limit is off.`)
        this.publishNow()
      })
      return
    }
    await this.swap(pane, reason, lines, signal)
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

  /** A seat left because of a threshold stays out of rotation until the window that is over
   *  resets. Once it is inactive Orca may report no usage for it, and it would look free again:
   *  with every seat over a threshold the session would rotate (and be typed into) forever. */
  private async coolOverThreshold(seat: Seat, config: Config, now: number, server: string | undefined): Promise<void> {
    if (!overThreshold(seat, config, now)) return
    const stored = scopedKey(server, seat.key)
    const resets = (
      [
        [seat.usage.session, config.thresholdFiveHour],
        [seat.usage.weekly, config.thresholdSevenDay]
      ] as const
    )
      .filter(([w, limit]) => w && w.usedPercent >= Math.min(limit, 100) && w.resetsAt !== null && w.resetsAt > now)
      .map(([w]) => w!.resetsAt!)
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
      const base = await this.deps.config()
      // A manual move works under the manual strategy too.
      const config: Config = reason === 'manual' && base.strategy === 'manual' ? { ...base, strategy: 'drain' } : base
      const advisory = reason === 'threshold' || reason === 'idle'
      // Advice never starts a session over: see `resumes`.
      if (advisory && config.autoResume && !this.resumes(pane)) return
      // The user may have gone on in the pane while this waited behind another move: a turn that
      // runs is never closed. Its end is a new event. (Advice checks this in `advisoryOk`.) When
      // Orca cannot say, the move goes on to `moveTo`, which holds it until Orca can.
      if (reason !== 'manual' && !advisory && (await this.turnState(pane)) === 'busy') {
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
      const ahead = reason !== 'manual' && this.looksAhead(config)
      // Leaving because the account is about to run out (Low), not because it is at a limit.
      const leave = advisory && from && ahead ? this.leaving(from, pane.server, config, now) : null
      const low = !!leave && leave.leave && !leave.assessment.over
      if (reason === 'threshold' && from) await this.coolOverThreshold(from, config, now, pane.server)
      const chain = buildChain(view.seats, pane.agent, config)
      const healthyActive =
        preferActive && active && isEligible(active, this.healthOf(active.key, pane.server), config, now) ? active : null
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
      if (ahead && from && config.waitForReset && config.autoResume) {
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
            why: `${label} resets in ${minutesWords(resumeAt - now)}; waiting is cheaper than moving, which re-reads the whole conversation`,
            notify: `${PROVIDER_NAME[pane.agent]}: ${label} resets in ${minutesWords(resumeAt - now)}. The session waits and continues there, because moving it would re-read the whole conversation.`
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
      const config = await this.deps.config()
      if (config.autoResume && !this.resumes(pane)) return
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
    if (config.strategy !== 'smart' || config.mode !== 'smart') return null
    const chain = buildChain(view.seats, provider, config)
    const samples = this.samplesOn(server)
    // Cheap test first: pane counts cost host calls.
    const any = chain.some((s) => s.key !== from.key && expiring(s, samples[s.key], now))
    if (!any) return null
    const context = await this.smartContext(provider, view, server, now)
    const ordered = Boolean(config.chain.trim())
    const candidate = (seat: Seat, index: number) => {
      const h = this.healthOf(seat.key, server)
      const t = seat.key === from.key ? 'A' : tier(seat, h, config, now)
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
    // `lines` were read before this move waited for its turn (the lock, a fresh account read):
    // look at the pane as it is now.
    if (await this.midTurn(pane)) {
      this.deps.log(`${pane.agent} ${pane.terminalId}: in the middle of a turn again, not moving it`)
      return false
    }
    const screen = await this.deps.host.call('terminal.read', { terminalId: pane.terminalId, maxLines: 80 }).catch(() => null)
    if (await this.unsent(pane.terminalId, pane.server, screen?.lines ?? lines)) {
      this.deps.log(`${pane.agent} ${pane.terminalId}: unsent text in the input box, not moving it`)
      return false
    }
    const gapWaived = rule === 'expiring' || (rule === 'switch-back' && !target.usage.known)
    if (!gapWaived && !enoughGap(from, target, config, rule === 'low')) return false
    // Moving onto the seat Orca already selected changes nothing for other panes; a selection
    // change is what must not flap.
    if (view.active[target.provider] !== target.key && !this.canChangeSelection(target.provider, config, now, pane.server)) return false
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
   *  that is never taken for "between turns". */
  private async turnState(pane: Pick<PaneInfo, 'terminalId' | 'workspaceId'>): Promise<'busy' | 'idle' | 'unknown'> {
    let agents: any[]
    try {
      agents = (await this.deps.host.call('agents.list', { workspaceId: pane.workspaceId }))?.agents
    } catch (error) {
      this.deps.log(`could not ask Orca whether ${pane.terminalId} is in the middle of a turn: ${String((error as Error)?.message ?? error)}`)
      return 'unknown'
    }
    if (!Array.isArray(agents)) return 'unknown'
    const row = agents.find((a: any) => a.terminalId === pane.terminalId)
    return row && row.state !== 'waiting' && row.state !== 'done' ? 'busy' : 'idle'
  }

  /** In the middle of a turn, or possibly so (Orca cannot say): nothing closes the pane or types
   *  into it. */
  private async midTurn(pane: Pick<PaneInfo, 'terminalId' | 'workspaceId'>): Promise<boolean> {
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
      const config = await this.deps.config()
      if (!config.switchBack) return
      // "Only at a limit" and "New launches only" never move a running session back.
      if (config.mode !== 'custom' && config.runningSessions !== 'move') return
      if (config.autoResume && !this.resumes(pane)) return
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
    if (config.strategy === 'manual' || !config.waitForReset) {
      // Two different causes: nothing is switched automatically at all (manual), or no other
      // account has room and waiting for one is off.
      const manual = config.strategy === 'manual'
      const service = PROVIDER_NAME[pane.agent]
      this.record({ provider: pane.agent, terminalId: pane.terminalId, reason, result: 'failed', ...(from ? { from: from.key } : {}), detail: manual ? 'manual strategy' : 'no healthy seat', why: manual ? 'Auto-switch is manual, so nothing is switched automatically' : `no other ${service} account has room, and waiting for a reset is off` })
      await this.save()
      await this.deps.notify(
        'Auto Hand-off',
        manual
          ? `${service} hit a limit${from ? ` on ${from.label}` : ''}. Auto-switch is set to manual, so nothing was switched.`
          : `${service}: no other account has room, and waiting for a reset is off. The session stays where it is.`
      )
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
    this.record({ provider: pane.agent, terminalId: pane.terminalId, reason, result: 'waiting', ...(from ? { from: from.key } : {}), detail: `until ${new Date(wakeAt).toISOString()}`, why: special?.why ?? `every ${PROVIDER_NAME[pane.agent]} account is used up or cooling down; waiting for the earliest reset` })
    await this.save()
    await this.deps.notify('Auto Hand-off', special ? `${special.notify} Resuming at ${new Date(wakeAt).toLocaleString()}.` : `Every ${pane.agent} account is exhausted; resuming at ${new Date(wakeAt).toLocaleString()}.`)
    this.publishNow()
  }

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
  ): Promise<void> {
    let reselected = false
    const canResume = this.resumes(pane)
    const agentId = pane.agentId ?? pane.agent
    // A limit, or the wake of a parked session, closes the pane too: never while its input box
    // holds unsent text. (Moves that are advice check this in `advisoryOk`.) These are also the
    // moves that interrupted work, after which the first message is typed.
    const closesUnasked = reason === 'rate_limit' || reason === 'auth' || reason === 'model_cap' || reason === 'reset'
    if (config.autoResume && closesUnasked) {
      const box = await this.draftIn(pane, lines)
      if (box) {
        await this.holdForDraft(pane, from, target, reason, signal?.model, view, box === 'unchecked')
        return
      }
      // Choosing the target read the accounts through the CLI (seconds, live): a turn the user
      // started meanwhile is never closed. Its end is a new event; a parked session is looked at
      // again at the next tick. When Orca cannot say, the move is held like one over unsent text.
      const turn = await this.turnState(pane)
      if (turn === 'unknown') {
        await this.holdForDraft(pane, from, target, reason, signal?.model, view, true)
        return
      }
      if (turn === 'busy') {
        this.deps.log(`${pane.agent} ${pane.terminalId}: in the middle of a turn again, not moving it`)
        return
      }
    }
    this.moving.add(pane.terminalId)
    try {
      if (view.active[target.provider] !== target.key) {
        await this.selectOn(target.provider, target.accountId, pane.server)
        view.active[target.provider] = target.key
        for (const s of view.seats) if (s.provider === target.provider) s.active = s.key === target.key
        this.noteSelectionChange(target.provider, this.deps.now(), pane.server)
        reselected = true
      }
      if (!config.autoResume) {
        // Only the account changes; the pane stays as it is for the user to resume.
        this.state.waiting = this.state.waiting.filter((w) => w.terminalId !== pane.terminalId)
        // Why the session is not resumed: "Running sessions: new launches only", or (custom mode)
        // the legacy "Resume the session after a switch" setting.
        const byKnob = config.mode !== 'custom' && config.runningSessions === 'launches'
        this.record({ provider: pane.agent, terminalId: pane.terminalId, reason, result: 'selected', ...(from ? { from: from.key } : {}), to: target.key, detail: byKnob ? 'Running sessions: new launches only' : 'auto_resume off', why: explained ?? this.why(reason, from, target, view, { selectionOnly: true, ...(signal?.model ? { model: signal.model } : {}) }) })
        if (reason !== 'manual') this.startProbation(target, config, this.deps.now(), pane.server)
        await this.save()
        this.publishNow()
        await this.deps.notify(
          'Auto Hand-off',
          `${PROVIDER_NAME[pane.agent]}: new launches now use ${target.label}. The session stays where it is for you to resume, because ${byKnob ? 'Running sessions is set to new launches only' : 'Resume the session after a switch is off'}.`
        )
        return
      }
      const whyLine = explained ?? this.why(reason, from, target, view, signal?.model ? { model: signal.model } : {})
      let newTerminal: string
      if (canResume) {
        // agent.resume refuses while the session still runs, so the old pane goes first.
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
        const prompt = await this.handoffPrompt(pane, from, lines, signal, config)
        const launched = await this.deps.host.call('agent.launch', {
          workspaceId: pane.workspaceId,
          agent: agentId,
          prompt
        })
        newTerminal = launched.terminalId
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
      this.record({
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
      // In Smart the notification gives the reason in words, and says that Orca's own restart
      // prompt (shown whenever the selected account changes) needs no action.
      const plain = reason !== 'manual' && this.looksAhead(config)
      const body = plain ? `${PROVIDER_NAME[pane.agent]}: ${whyLine}.` : `${pane.agent}: ${from?.label ?? 'account'} → ${target.label} (${reason}).`
      const untyped =
        left === 'draft'
          ? ' The session has unsent text in its input box, so it is left for you to continue.'
          : left === 'unchecked'
            ? ' Orca could not be asked whether it is safe to type there, so the session is left for you to continue.'
            : left === 'untyped'
            ? ' The first message could not be typed, so the session is left for you to continue.'
            : ''
      await this.deps.notify('Auto Hand-off', `${body}${untyped}${plain && reselected ? ` ${restartNote(config)}` : ''}`)
    } catch (error) {
      const message = String((error as Error)?.message ?? error)
      this.deps.log(`swap failed: ${message}`)
      // Never retry a parked session forever: a failure ends its wait.
      this.state.waiting = this.state.waiting.filter((w) => w.terminalId !== pane.terminalId)
      // A seat that could not be switched to is skipped for a while, so the rotation moves on to
      // a usable one instead of retrying a broken one (Orca PR #43578).
      const skipUntil = this.deps.now() + FAILED_SWITCH_SKIP_MS
      const h = this.healthOf(target.key, pane.server)
      if (!h?.cooldownUntil || h.cooldownUntil < skipUntil) {
        this.state.health[scopedKey(pane.server, target.key)] = cooled(h, this.deps.now(), skipUntil, `switch failed: ${message}`)
      }
      this.record({ provider: pane.agent, terminalId: pane.terminalId, reason, result: 'failed', ...(from ? { from: from.key } : {}), to: target.key, detail: message.slice(0, 200) })
      await this.save()
      await this.deps.notify('Auto Hand-off', `Swap to ${target.label} failed: ${message}`)
      this.publishNow()
    } finally {
      this.moving.delete(pane.terminalId)
    }
  }

  /** Unsent text in the pane's input box, as the pane is now (`lines` when it cannot be read):
   *  `draft`, or `unchecked` when Orca could not say. Either way the pane is not closed. */
  private async draftIn(pane: PaneInfo, lines: readonly string[]): Promise<'draft' | 'unchecked' | null> {
    const screen = await this.deps.host.call('terminal.read', { terminalId: pane.terminalId, maxLines: 80 }).catch(() => null)
    const box = await this.unsentText(pane.terminalId, pane.server, screen?.lines ?? lines)
    return box === null ? null : box === UNCHECKED ? 'unchecked' : 'draft'
  }

  /** Is there unsent text in a pane's input box, or may there be? Live (Orca 1.4.263):
   *  `terminal.read` leaves that text out of its lines (the box reads as empty) and only `orca
   *  terminal read` reports it, as `draft`. So Orca is asked, and the lines are looked at as well,
   *  for an Orca that leaves the text in them. When Orca cannot say, the answer is yes. */
  private async unsent(terminalId: string, server: string | undefined, lines: readonly string[]): Promise<boolean> {
    return (await this.unsentText(terminalId, server, lines)) !== null
  }

  /** The unsent text in a pane's input box (trimmed), null when there is none, or `UNCHECKED`
   *  when `orca terminal read` failed, timed out or gave no usable answer. Orca reports Claude
   *  Code's grey prompt suggestion and its fixed hints as `draft` too, and nothing tells a
   *  suggestion from typing, so it counts as unsent text; a fixed hint (`isClaudeHint`) is known
   *  by its exact wording and is no text. */
  private async unsentText(terminalId: string, server: string | undefined, lines: readonly string[]): Promise<Unsent> {
    const onScreen = draftOf(lines)
    if (onScreen !== null && !isClaudeHint(onScreen)) return onScreen
    let text: string | undefined
    try {
      text = await (server ? this.deps.cli.draft(terminalId, server) : this.deps.cli.draft(terminalId))
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
    unchecked = false
  ): Promise<void> {
    const parked = this.state.waiting.find((w) => w.terminalId === pane.terminalId)
    if (parked?.draftAt) return
    const now = this.deps.now()
    const labels = displayLabels(view.seats, pane.agent)
    const to = labels.get(target.key) ?? target.label
    const source = from ? (labels.get(from.key) ?? from.label) : undefined
    const service = PROVIDER_NAME[pane.agent]
    this.deps.log(`${pane.agent} ${pane.terminalId}: ${unchecked ? 'could not check the session' : 'unsent text in the input box'}, not closing it`)
    if (parked) {
      parked.draftAt = now
      if (unchecked) parked.unchecked = true
      else delete parked.unchecked
    } else {
      const entry: WaitingEntry = { terminalId: pane.terminalId, workspaceId: pane.workspaceId, agent: pane.agent, wakeAt: now, draftAt: now, reason }
      if (model) entry.model = model
      if (pane.sessionId) entry.sessionId = pane.sessionId
      if (pane.agentId) entry.agentId = pane.agentId
      if (from) entry.fromSeat = from.key
      if (pane.server) entry.server = pane.server
      if (unchecked) entry.unchecked = true
      this.state.waiting = [...this.state.waiting, entry]
    }
    const waited = reason === 'reset'
    this.record({
      provider: pane.agent,
      terminalId: pane.terminalId,
      reason,
      result: 'waiting',
      ...(from ? { from: from.key } : {}),
      detail: unchecked ? 'could not check the session' : 'unsent text in the input box',
      why: `${waited ? `${to} is free` : `${source ?? service} hit its limit`}; the session moves to ${to} once ${unchecked ? 'Orca can say that it is between turns with an empty input box' : 'the unsent text in its input box is sent or cleared'}`
    })
    await this.save()
    const what = waited ? `${service}: ${to} is free again.` : `${service} hit its limit${source ? ` on ${source}` : ''}.`
    await this.deps.notify(
      'Auto Hand-off',
      unchecked ? `${what} ${NOT_CHECKED}, so it was not moved. It moves to ${to} once that can be checked.` : `${what} Send or clear the text you were typing and the session moves to ${to}.`
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

  private async handoffPrompt(pane: PaneInfo, from: Seat | undefined, lines: string[], signal: Signal | undefined, config: Config): Promise<string> {
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
    const tail = lines
      .filter((l) => l.trim() !== '' && !CHROME.test(l) && !/^[╭╰│─]/.test(l.trim()))
      .filter((l) => !signal || !l.includes(signal.line))
      .slice(-40)
      .join('\n')
    const parts = [
      `You are taking over a coding session that ${pane.agent}${from ? ` (${from.label})` : ''} was running in this workspace.`,
      signal ? `It stopped because: ${signal.line}` : 'It was moved to another account.',
      pane.title ? `Session title: ${pane.title}` : '',
      branch ? `Branch: ${branch}` : '',
      status ? `git status --short:\n${status}` : '',
      diff ? `git diff --stat:\n${diff}` : '',
      tail ? `Last output of the previous agent:\n${tail}` : '',
      'First inspect the repository (git status, git diff) to see what is already done, then continue the task. Do not redo finished work.'
    ].filter(Boolean)
    const text = parts.join('\n\n')
    return text.length > config.handoffMaxChars ? `${text.slice(0, config.handoffMaxChars - 1)}…` : text
  }

  // ---- periodic -------------------------------------------------------------------------

  /** Runs every 30 s: refresh usage, wake parked sessions, expire cooldowns. */
  async tick(): Promise<void> {
    const config = await this.deps.config()
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
        if (ready) await this.wake(w)
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
   * - Switch-back (my order, legacy drain/priority): a seat ahead of the selected one is healthy
   *   again.
   * - Smart and my order: the selected seat is Low or Out while a session on it is mid-turn, so
   *   it cannot move yet.
   * - Smart: another seat has weekly quota that would expire unused.
   * Every such change makes Orca show its own "sessions are still running… Restart" prompt, so it
   * happens at most once per switch cooldown, and the notification says why and that no restart
   * is needed.
   */
  private async reselectForLaunches(config: Config): Promise<void> {
    if (config.strategy === 'manual') return
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
          this.state.health[scopedKey(server, preferred.key)] = cooled(this.healthOf(preferred.key, server), this.deps.now(), this.deps.now() + FAILED_SWITCH_SKIP_MS, `switch failed: ${message}`)
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
        await this.deps.notify('Auto Hand-off', `${PROVIDER_NAME[provider]}: ${plan.why}. Only new sessions start on ${preferred.label}. ${restartNote(config)}`)
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
    if (!this.looksAhead(config) || !selected) return null
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
    const target = await this.expiringTarget(selected, provider, view, server, config, now)
    return target ? { target, reason: 'expiring', why: this.explained('expiring', selected, target, view, { selectionOnly: true }) } : null
  }

  /** cux `auto_swap_idle_after_seconds`: a session idle on an over-threshold seat, or on a
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
      // Panes on a direct SSH target use that machine's own login: nothing to move them to.
      if (await this.sshTargetOfWorkspace(ws.id)) continue
      let agents: any[]
      try {
        agents = (await this.deps.host.call('agents.list', { workspaceId: ws.id })).agents
      } catch {
        continue
      }
      const wsServer = parseServer(ws.hostId) ?? (await this.serverOfWorkspace(ws.id))
      const wsView = wsServer === this.server ? view : await this.accountsFor(wsServer)
      for (const row of agents) {
        const agent = providerOf(row.agent)
        if (!agent || !row.terminalId || !due.includes(agent)) continue
        if (row.state !== 'waiting' && row.state !== 'done') continue
        if (now - (row.stateStartedAt ?? now) < idleMs) continue
        if (this.inflight.has(row.terminalId) || this.state.waiting.some((w) => w.terminalId === row.terminalId)) continue
        // An idle move is advice: only a session that can resume as itself is moved (`resumes`).
        if (config.autoResume && !this.resumes({ agent, sessionId: row.sessionId })) continue
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

  private async wake(w: WaitingEntry): Promise<void> {
    await this.withLock(w.agent, async () => {
      // Cancelled, or carried out by another look at it, while this one waited for its turn.
      if (!this.state.waiting.includes(w)) return
      if (!(await this.allowed(w.agent))) return
      // The user went on in the parked pane, or the session already runs elsewhere: stop waiting.
      const listing = await this.deps.host.call('agents.list', { workspaceId: w.workspaceId }).catch(() => null)
      const agents: any[] = listing?.agents ?? []
      const busy = agents.some(
        (a: any) =>
          // Anything but between turns: `blocked` (a permission question) is mid-turn too.
          (a.terminalId === w.terminalId && a.state !== 'waiting' && a.state !== 'done') ||
          (w.sessionId && a.sessionId === w.sessionId && a.terminalId !== w.terminalId)
      )
      if (busy) {
        this.state.waiting = this.state.waiting.filter((x) => x.terminalId !== w.terminalId)
        await this.save()
        this.publishNow()
        return
      }
      // The parked pane is gone and the plugin did not close it (its own moves hold this lock and
      // end the wait themselves): the user closed it. Resuming would bring back what they closed.
      if (!this.moving.has(w.terminalId) && !agents.some((a: any) => a.terminalId === w.terminalId)) {
        // Orca could not list the workspace: look again at the next tick, unless it is gone too.
        if (!listing && !(await this.workspaceGone(w))) return
        this.state.waiting = this.state.waiting.filter((x) => x.terminalId !== w.terminalId)
        this.forget(w.terminalId)
        this.record({ provider: w.agent, terminalId: w.terminalId, reason: w.reason ?? 'reset', result: 'closed', ...(w.fromSeat ? { from: w.fromSeat } : {}), detail: 'pane closed', why: 'the waiting pane was closed, so its session is not resumed' })
        await this.save()
        this.deps.log(`${w.agent} ${w.terminalId}: the waiting pane was closed, not resuming its session`)
        this.publishNow()
        return
      }
      if (w.draftAt) {
        // The move waits for unsent text: nothing to do, and nothing new to say, while it is there.
        const screen = await this.deps.host.call('terminal.read', { terminalId: w.terminalId, maxLines: 80 }).catch(() => null)
        if (screen && (await this.unsent(w.terminalId, w.server, screen.lines))) return
        delete w.draftAt
        delete w.unchecked
      }
      const config = await this.deps.config()
      const server = w.server ?? (await this.serverOfWorkspace(w.workspaceId))
      const view = await this.accountsFor(server, true)
      const now = this.deps.now()
      const chain = buildChain(view.seats, w.agent, config)
      const source = view.seats.find((s) => s.key === w.fromSeat)
      if (w.hold === 'short' && source && isEligible(source, this.healthOf(source.key, server), config, now) && agents.some((a: any) => a.terminalId === w.terminalId)) {
        // The short wait is over and the account is back: the session continues where it is.
        const label = displayLabels(view.seats, w.agent).get(source.key) ?? source.label
        const held = await this.deps.host.call('terminal.read', { terminalId: w.terminalId, maxLines: 80 }).catch(() => ({ lines: [] as string[] }))
        const box = await this.unsentText(w.terminalId, server, held.lines)
        // Orca cannot say whether typing is safe (the input box, or the turn): nothing is typed,
        // and the wait stays for the next tick to look again.
        if (box === UNCHECKED || (await this.turnState(w)) === 'unknown') return
        this.state.waiting = this.state.waiting.filter((x) => x.terminalId !== w.terminalId)
        if (box !== null) {
          // Typing the first message would send the user's unsent text with it: leave the pane alone.
          await this.save()
          await this.deps.notify('Auto Hand-off', `${PROVIDER_NAME[w.agent]}: ${label} has reset. The session has unsent text in its input box, so it is left for you to continue.`)
          this.publishNow()
          return
        }
        // The accounts were read afresh since the look at the pane above (live: seconds): a turn
        // the user started meanwhile is not typed into. They went on there, so the wait is over.
        if (await this.midTurn(w)) {
          this.deps.log(`${w.agent} ${w.terminalId}: in the middle of a turn again, not typing into it`)
          await this.save()
          this.publishNow()
          return
        }
        this.record({ provider: w.agent, terminalId: w.terminalId, reason: 'reset', result: 'retried', from: source.key, to: source.key, why: `${label} has reset; the session continues there` })
        await this.save()
        if (config.autoMessage) await this.type(w.terminalId, config.autoMessage, server)
        await this.deps.notify('Auto Hand-off', `${PROVIDER_NAME[w.agent]}: ${label} has reset; the session continues there.`)
        this.publishNow()
        return
      }
      // Before its time, a wait for a model's bucket ends only on an account not known to be full
      // in it.
      const early = w.model && w.wakeAt > now ? { only: this.modelRoom(chain, w.model, now, true) } : {}
      const context = this.looksAhead(config) && config.strategy === 'smart' ? { smart: await this.smartContext(w.agent, view, server, now) } : {}
      // A model cap whose move waited for unsent text keeps its order: an account known to have
      // room for that model, then one not known to be full in it.
      const capped = w.reason === 'model_cap' && this.looksAhead(config)
      const room = (unknownToo: boolean) =>
        pickNext(chain, w.fromSeat, this.healthOn(server), config, now, { only: this.modelRoom(chain, w.model, now, unknownToo), ...context })
      const target = capped
        ? (room(false) ?? room(true))
        : pickNext(chain, w.model && w.wakeAt > now ? w.fromSeat : undefined, this.healthOn(server), config, now, { ...early, ...context })
      if (!target) {
        // Nowhere to go any more: from here on it is an ordinary wait for a reset.
        delete w.reason
        w.wakeAt = earliestReset(chain, this.healthOn(server), now) ?? now + config.defaultCooldownMinutes * 60_000
        await this.save()
        return
      }
      const pane: PaneInfo = { terminalId: w.terminalId, workspaceId: w.workspaceId, agent: w.agent }
      if (w.sessionId) pane.sessionId = w.sessionId
      if (w.agentId) pane.agentId = w.agentId
      if (server) pane.server = server
      const from = view.seats.find((s) => s.key === w.fromSeat)
      let lines: string[] = []
      try {
        lines = (await this.deps.host.call('terminal.read', { terminalId: w.terminalId, maxLines: 80 })).lines
      } catch {
        // The parked pane may be gone already.
      }
      const reason = w.reason ?? 'reset'
      const why = reason === 'model_cap' && w.model ? this.why(reason, from, target, view, { model: w.model }) : undefined
      await this.moveTo(pane, from, target, reason, lines, undefined, view, config, why)
    })
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
      return `${PROVIDER_NAME[seat.provider]}: new launches use ${seat.label}`
    })
  }

  async selectNext(provider: Provider): Promise<string> {
    const config = await this.deps.config()
    const server = await this.focusedServer()
    const view = await this.accountsFor(server, true)
    const chain = buildChain(view.seats, provider, config)
    const strategy = config.strategy === 'manual' ? 'drain' : config.strategy
    const next = pickNext(chain, view.active[provider], this.healthOn(server), { ...config, strategy }, this.deps.now(), { mode: 'manual' })
    if (!next) return `${PROVIDER_NAME[provider]}: no other healthy account`
    return this.selectSeatOn(server, next.key)
  }

  /** The panel's *Manual switch*: select the chosen account of its service for new launches and
   *  move the current terminal's pane over if it runs this service and is between turns. The
   *  worker then turns the service's automatic hand-off off, so the rotator never undoes a
   *  choice the user made by hand; the panel says so and offers the toggle. A limited account
   *  is refused. Returns what happened and whether anything was switched. `chosen` runs as soon
   *  as the account is selected, before any other move of that service can run.
   *
   *  A pane that would move but shows unsent text is not moved, and nothing is selected: the text
   *  comes back as `draft`, with the pane it is in, and the panel asks. `acceptedDraft` is what
   *  the user then agreed to lose (the panel's second confirmation, nothing else, passes it):
   *  the pane moves only while it is that pane and its text is still exactly that; any other
   *  text is asked about again. */
  async forceTo(
    seatKey: string,
    chosen?: (provider: Provider) => Promise<void>,
    acceptedDraft?: { terminalId: string; text: string }
  ): Promise<{ message: string; switched: boolean; provider: Provider; draft?: { terminalId: string; text: string } }> {
    const config = await this.deps.config()
    const server = await this.focusedServer()
    const view = await this.accountsFor(server, true)
    const seat = view.seats.find((s) => s.key === seatKey)
    if (!seat) throw Object.assign(new Error(`Unknown account ${seatKey}`), { code: 'invalid_params' })
    const provider = seat.provider
    const now = this.deps.now()
    const health = this.healthOf(seat.key, server)
    if (health?.cooldownUntil && health.cooldownUntil > now) {
      return { message: `${PROVIDER_NAME[provider]}: ${seat.label} is limited until ${new Date(health.cooldownUntil).toLocaleTimeString()}; clear the cooldown first`, switched: false, provider }
    }
    if (view.active[provider] === seat.key) return { message: `${PROVIDER_NAME[provider]}: new launches already use ${seat.label}`, switched: false, provider }
    const agreed = (terminalId: string, text: string) => !!acceptedDraft && acceptedDraft.terminalId === terminalId && acceptedDraft.text.trim() === text
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
        return { message: `${PROVIDER_NAME[provider]}: Orca could not be asked whether this session is between turns with an empty input box, so nothing was switched. Try again in a moment`, switched: false, provider }
      }
      if (text !== null && !agreed(ahead.terminalId, text)) {
        this.deps.log(`${provider} ${ahead.terminalId}: unsent text in the input box, asking before moving it`)
        return { message: `${PROVIDER_NAME[provider]}: this session shows unsent text; nothing was switched`, switched: false, provider, draft: { terminalId: ahead.terminalId, text } }
      }
    }
    const selected = await this.selectSeatOn(server, seat.key, chosen)
    const pane = await this.currentPane(provider)
    // The focus moved to a project on another server meanwhile: the pane in front now runs on
    // other accounts, and is not the one the choice was made for.
    if (!pane || pane.server !== server) return { message: selected, switched: true, provider }
    if (pane.sshHost) return { message: `${selected}; this pane runs on SSH target ${pane.sshHost} with that machine's own login and is left alone`, switched: true, provider }
    if (pane.state !== 'waiting' && pane.state !== 'done') return { message: `${selected}; this pane keeps its account while it works`, switched: true, provider }
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
      // never in the middle of a turn, and never over unsent text, unless it is exactly the text
      // the user was shown and agreed to lose. Text that came or changed since (the pane as it
      // is now, the last thing looked at before it is closed) is theirs: the pane stays.
      const turn = await this.turnState(pane)
      if (turn === 'unknown') return 'unchecked'
      if (turn === 'busy') {
        this.deps.log(`${pane.agent} ${pane.terminalId}: in the middle of a turn, not moving it`)
        return 'busy'
      }
      const again = await this.deps.host.call('terminal.read', { terminalId: pane.terminalId, maxLines: 80 }).catch(() => null)
      const text = await this.unsentText(pane.terminalId, pane.server, again?.lines ?? screen.lines)
      // Orca cannot say what the box holds now: not even text the user agreed to lose is known
      // to be all there is.
      if (text === UNCHECKED) return 'unchecked'
      if (text !== null && !agreed(pane.terminalId, text)) {
        this.deps.log(`${pane.agent} ${pane.terminalId}: unsent text in the input box, not moving it`)
        return 'draft'
      }
      if (text !== null) this.deps.log(`${pane.agent} ${pane.terminalId}: moving it over the unsent text the user agreed to lose`)
      const before = this.state.history.length
      // "Running sessions: new launches only" (and the legacy `auto_resume` off) say what the
      // plugin does by itself; this move was asked for, and the confirmation said it happens.
      await this.moveTo(pane, at.seat, target, 'manual', [...screen.lines], undefined, fresh, { ...config, autoResume: true })
      return this.state.history.length > before ? this.state.history.at(-1)! : null
    })
    if (moved === 'busy') return { message: `${selected}; this pane keeps its account while it works`, switched: true, provider }
    if (moved === 'draft') return { message: `${selected}; this pane has unsent text in its input box and keeps its account`, switched: true, provider }
    if (moved === 'unchecked') return { message: `${selected}; Orca could not be asked about this session, so it was not moved and keeps its account`, switched: true, provider }
    if (moved && (moved.result === 'resumed' || moved.result === 'handoff')) return { message: `${selected}; this pane moved (${moved.result})`, switched: true, provider }
    return { message: `${selected}; this pane keeps its account until it is relaunched`, switched: true, provider }
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
      const sshHost = await this.sshTargetOfWorkspace(context.workspaceId)
      if (sshHost) pane.sshHost = sshHost
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
      agents.find((a: any) => providerOf(a.agent) && (a.state === 'waiting' || a.state === 'done')) ??
      agents.find((a: any) => providerOf(a.agent))
    if (!row || !context?.workspaceId) return 'No agent in the focused workspace'
    // Moving closes the pane: never in the middle of a turn.
    if (row.state !== 'waiting' && row.state !== 'done') return `${providerOf(row.agent)}: this pane is in the middle of a turn; run the command again once it has finished`
    const sshHost = await this.sshTargetOfWorkspace(context.workspaceId)
    if (sshHost) return `${providerOf(row.agent)}: this pane runs on SSH target ${sshHost}; Orca manages no accounts there`
    const server = await this.serverOfWorkspace(context.workspaceId)
    const pane: PaneInfo = { terminalId: row.terminalId, workspaceId: context.workspaceId, agent: providerOf(row.agent)! }
    if (row.agent !== pane.agent) pane.agentId = row.agent
    if (row.sessionId) pane.sessionId = row.sessionId
    if (server) pane.server = server
    const { lines } = await this.deps.host.call('terminal.read', { terminalId: row.terminalId, maxLines: 80 })
    // Moving closes the pane, and with it whatever is typed in its input box.
    const box = await this.unsentText(pane.terminalId, pane.server, lines)
    if (box === UNCHECKED || (await this.turnState(pane)) === 'unknown') return `${pane.agent}: Orca could not be asked whether this pane is between turns with an empty input box; it was not moved`
    if (box !== null) return `${pane.agent}: this pane has unsent text in its input box; send or clear it first`
    const before = this.state.history.length
    await this.swap(pane, 'manual', lines)
    const last = this.state.history.length > before ? this.state.history.at(-1) : undefined
    if (!last) return `${pane.agent}: nothing to do`
    const view = this.views.get(server ?? 'local')?.view ?? this.view
    const label = (key?: string) => view?.seats.find((s) => s.key === key)?.label ?? key ?? '?'
    if (last.result === 'resumed' || last.result === 'handoff' || last.result === 'selected') {
      return `${pane.agent}: moved to ${label(last.to)} (${last.result})`
    }
    return `${pane.agent}: ${last.result}${last.detail ? ` — ${last.detail}` : ''}`
  }

  async setPaused(paused: boolean): Promise<void> {
    this.state.paused = paused
    await this.save()
    this.publishNow()
  }

  async cancelWaiting(terminalId: string): Promise<void> {
    this.state.waiting = this.state.waiting.filter((w) => w.terminalId !== terminalId)
    await this.save()
    this.publishNow()
  }

  /** The panel's *Clear*: `seatKey` is an account of the project in focus (the panel lists those). */
  async clearCooldown(seatKey: string): Promise<void> {
    delete this.state.health[scopedKey(this.server, seatKey)]
    await this.save()
    this.publishNow()
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
          ...(runway !== null ? { runwayMs: Math.round(runway) } : {}),
          ...(h?.cooldownUntil ? { cooldownUntil: h.cooldownUntil } : {}),
          ...(h?.reason ? { cooldownReason: h.reason } : {})
        }
      }),
      waiting: this.state.waiting,
      history: this.state.history.filter((h) => h.at >= now - HISTORY_MAX_AGE_MS).slice(-100),
      services: { ...this.services }
    }
    if (this.mode) snap.mode = this.mode
    if (this.modeNotice && !this.state.customNoticeSeen) snap.notice = this.modeNotice
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
