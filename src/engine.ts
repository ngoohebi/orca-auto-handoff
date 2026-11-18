// The rotator: reacts to agent status, classifies the terminal tail, and swaps seats.
// Every side effect goes through Deps so tests run it with a fake host, CLI and clock.
import { ADAPTERS, CHROME, classify, countCopies, hasDraft, parseModelFallback } from './adapters'
import { parseAccounts, type AccountView } from './accounts'
import { PROVIDER_NAME } from './labels'
import { parseLive } from './live-usage'
import { emptyUsageCache, loadedUsageCache, observe, observeLive, resolve, type UsageCache } from './usage-cache'
import {
  blindCooldownMs,
  buildChain,
  earliestReset,
  enoughGap,
  exhausted,
  isEligible,
  overThreshold,
  pickNext,
  preferredOver,
  strikesOf
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
  type Provider,
  type RotatorState,
  type Seat,
  type SeatHealth,
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
  /** When each provider's active account last changed, so a stale reading is not misattributed. */
  private activeSince: Partial<Record<Provider, number>> = {}
  /** One `orca account list` at a time: the timer, the panel and commands share it (~3 s). */
  /** In-flight `orca account list` per server. */
  private listings = new Map<string, Promise<AccountView>>()
  private followUp = 0
  private disposed = false

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
    this.services = { ...(await this.deps.config()).services }
    if (publish) this.publishNow()
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
    await this.deps.saveState(this.state)
  }

  private record(entry: Omit<HistoryEntry, 'at'>): void {
    this.state.history.push({ at: this.deps.now(), ...entry })
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
        if (this.clearStrikesByReading(parsed.seats, config, now)) await this.save()
      }
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
  private probation(provider: Provider, now: number): { key: string; until: number } | undefined {
    const p = this.state.probation?.[provider]
    return p && p.until > now ? p : undefined
  }

  /** An automatic move landed on a seat the plugin has no numbers for: hold further advisory moves
   *  of this provider for a while, and count a limit banner on that seat as a strike. */
  private startProbation(target: Seat, config: Config, now: number): void {
    if (target.usage.known) return
    const until = now + Math.max(MIN_PROBATION_MS, 2 * config.switchCooldownMinutes * 60_000)
    this.state.probation = { ...(this.state.probation ?? {}), [target.provider]: { key: target.key, until } }
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
    this.services = { ...config.services }
    return !this.state.paused && config.services[provider] !== false
  }

  // ---- events -----------------------------------------------------------------------------

  /** `agent.launch.before`: remember which seat a new pane starts on. */
  noteLaunch(agent: string, terminalId: string | undefined, workspaceId?: string | null): void {
    const provider = providerOf(agent)
    if (!provider || !terminalId) return
    const hostServer = parseServer(hostFromWorkspaceIdentity(workspaceId))
    const view = (hostServer ? this.views.get(hostServer)?.view : undefined) ?? this.cachedView()
    if (!view) return
    const key = view.active[provider]
    if (key) {
      this.state.paneSeat[terminalId] = key
      void this.save()
    }
  }

  /** Re-reads which project server and which agent the user is working with: the agent in the
   *  focused workspace's active terminal tab (from the CLI's layout listing); failing that, the
   *  agent whose state changed last, since the host API names the focused workspace but not the
   *  focused pane. Returns whether the focused server or agent moved. */
  async refreshFocus(): Promise<boolean> {
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
      const row = agents.find((a) => a.terminalId === event.terminalId)
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
      if (server) pane.server = server
      const sshHost = await this.sshTargetOfWorkspace(workspaceId)
      if (sshHost) pane.sshHost = sshHost
      return pane
    }
    return null
  }

  /** New when this banner was not seen in this pane, or another copy of it has been printed. */
  private isNew(key: string, signal: Signal): boolean {
    const seen = this.state.seen[key]
    if (!seen || seen.fingerprint !== signal.fingerprint) return true
    if (signal.occurrences > seen.occurrences) return true
    // Copies scrolled out of the read window: remember the lower count so the next copy counts.
    if (signal.occurrences < seen.occurrences) seen.occurrences = signal.occurrences
    return false
  }

  /** Copies of a handled banner that have scrolled out of the read window no longer count, so
   *  the next identical banner (same limit text hours later) is seen as new. */
  private recount(key: string, lines: readonly string[]): void {
    const seen = this.state.seen[key]
    if (!seen?.line) return
    const copies = countCopies(lines, seen.line)
    if (copies < seen.occurrences) seen.occurrences = copies
  }

  /** Handled banners are remembered per session: Orca can restore or restart a session in a new
   *  pane (live: after an account switch), and its redrawn transcript shows the old banner. */
  private seenKey(pane: { terminalId: string; sessionId?: string }): string {
    return pane.sessionId ? `session:${pane.sessionId}` : pane.terminalId
  }

  async inspect(pane: PaneInfo, observeOnly = false, turnEnded = false): Promise<void> {
    const config = await this.deps.config()
    this.services = { ...config.services }
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
    if (pane.sshHost && signal?.kind !== 'api_error') {
      // The agent runs on a direct SSH target with that machine's own login. This Orca's managed
      // accounts neither apply there nor can be selected there, so the pane is left alone; a
      // limit is noted once in the history so the user knows why nothing moved. (An API error
      // falls through: retrying in place only types into the pane.)
      if (signal && this.isNew(key, signal)) {
        this.state.seen[key] = { fingerprint: signal.fingerprint, occurrences: signal.occurrences, line: signal.line }
        const detail = `runs on SSH target ${pane.sshHost}: Orca manages no accounts there`
        this.record({ provider: pane.agent, terminalId: pane.terminalId, reason: signal.kind, result: 'failed', detail })
        await this.save()
        this.deps.log(`${pane.agent} ${pane.terminalId}: ${signal.kind} — ${detail}`)
        await this.deps.notify('Auto Hand-off', `${PROVIDER_NAME[pane.agent]} hit a limit on SSH target ${pane.sshHost}; Orca manages no accounts there, so the pane was left alone.`)
        this.publishNow()
      }
      return
    }
    if (observeOnly || !config.services[pane.agent]) {
      // Paused or service off: record what is on screen without acting on it.
      if (signal && this.isNew(key, signal)) {
        this.state.seen[key] = { fingerprint: signal.fingerprint, occurrences: signal.occurrences, line: signal.line }
        await this.save()
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
        const h = this.state.health[seat.key]
        if (h && strikesOf(h, this.deps.now()) > 0 && this.deps.now() - (h.strikeAt ?? 0) >= STRIKE_SETTLE_MS) {
          this.dropStrikes(seat.key)
          await this.save()
        }
      }
      if (config.autoSwitchOnThreshold && seat && overThreshold(seat, config, this.deps.now())) {
        await this.swap(pane, 'threshold', lines)
        return
      }
      // A turn just ended on a lower seat while a higher-priority one is healthy again.
      await this.switchBack(pane, lines)
      return
    }
    if (!this.isNew(key, signal)) return
    this.state.seen[key] = { fingerprint: signal.fingerprint, occurrences: signal.occurrences, line: signal.line }
    await this.save()
    this.deps.log(`${pane.agent} ${pane.terminalId}: ${signal.kind} — ${signal.line}`)

    switch (signal.kind) {
      case 'api_error':
        return this.retryApiError(pane, config)
      case 'model_cap':
        if (await this.fallbackModel(pane, config, signal)) return
        return this.limitHit(pane, signal, config, lines, 'model_cap')
      case 'auth':
        return this.limitHit(pane, signal, config, lines, 'auth')
      case 'rate_limit':
        return this.limitHit(pane, signal, config, lines, 'rate_limit')
    }
  }

  private async retryApiError(pane: PaneInfo, config: Config): Promise<void> {
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
    await this.type(pane.terminalId, config.autoMessage || 'continue', pane.server)
    this.record({ provider: pane.agent, terminalId: pane.terminalId, reason: 'api_error', result: 'retried', detail: `attempt ${attempt + 1}` })
    await this.save()
    this.publishNow()
  }

  private async fallbackModel(pane: PaneInfo, config: Config, signal: Signal): Promise<boolean> {
    const adapter = ADAPTERS[pane.agent]
    const models = (parseModelFallback(config.modelFallback)[pane.agent] ?? []).filter(
      (m) => !signal.model || !m.toLowerCase().includes(signal.model)
    )
    const step = this.state.modelStep[pane.terminalId] ?? 0
    if (!adapter.modelSwitch || step >= models.length) return false
    const model = models[step]!
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
        if (at.seat && (at.known || this.plausiblyLimited(at.seat))) await this.coolDown(at.seat, signal, config, reason)
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
  private async coolDown(seat: Seat, signal: Signal, config: Config, reason: SwapReason): Promise<void> {
    const now = this.deps.now()
    const prev = this.state.health[seat.key]
    const usageReset = [seat.usage.session, seat.usage.weekly]
      .filter((w) => w && w.usedPercent >= 100 && w.resetsAt && w.resetsAt > now)
      .map((w) => w!.resetsAt!)
    const realReset = signal.resetsAt ?? (usageReset.length ? Math.max(...usageReset) : undefined)
    const text = `${reason}: ${signal.line}`
    const strike = this.probation(seat.provider, now)?.key === seat.key || (!seat.usage.known && realReset === undefined)
    const stillCooling = !!prev?.cooldownUntil && prev.cooldownUntil > now
    if (strike && stillCooling && strikesOf(prev, now) > 0) {
      // Another pane on the seat showing the same limit: one strike, not two.
      const again = cooled(prev, now, Math.max(prev!.cooldownUntil!, realReset ?? 0), text)
      if (prev!.resetKnown || realReset !== undefined) again.resetKnown = true
      this.state.health[seat.key] = again
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
    this.state.health[seat.key] = next
    await this.save()
  }

  /** A seat left because of a threshold stays out of rotation until the window that is over
   *  resets. Once it is inactive Orca may report no usage for it, and it would look free again:
   *  with every seat over a threshold the session would rotate (and be typed into) forever. */
  private async coolOverThreshold(seat: Seat, config: Config, now: number): Promise<void> {
    if (!overThreshold(seat, config, now)) return
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
      this.state.health[seat.key]?.cooldownUntil ?? 0
    )
    const next = cooled(this.state.health[seat.key], now, until, 'threshold: over the usage threshold')
    if (resets.length) next.resetKnown = true
    this.state.health[seat.key] = next
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
    const run = prev.then(fn, fn)
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
      // Right after a move onto a seat without numbers, advice waits; only a real limit moves on.
      if (advisory && this.probation(pane.agent, this.deps.now())) return
      const view = await this.accountsFor(pane.server, true)
      const now = this.deps.now()
      const at = this.locate(pane.terminalId, pane.agent, view)
      let from = at.seat
      const active = view.seats.find((s) => s.key === view.active[pane.agent])
      let preferActive = false
      if (signal && from) {
        if (at.known || this.plausiblyLimited(from)) {
          await this.coolDown(from, signal, config, reason)
        } else {
          // Unknown pane (started before the plugin, or restored) while the active account has
          // plenty of room: the pane is on some other account. Cool nothing; move it to the
          // healthy active account.
          from = undefined
          preferActive = true
        }
      }
      if (reason === 'threshold' && from) await this.coolOverThreshold(from, config, now)
      const chain = buildChain(view.seats, pane.agent, config)
      const healthyActive =
        preferActive && active && isEligible(active, this.state.health[active.key], config, now) ? active : null
      const picked =
        healthyActive ??
        pickNext(chain, from?.key, this.state.health, config, now, {
          mode: reason === 'manual' ? 'manual' : advisory ? 'advisory' : 'hard',
          sourceExhausted: !!from && exhausted(from, now)
        })
      // Only ever another account of the same service.
      const target = picked && picked.provider === pane.agent ? picked : null
      if (!target) {
        // A threshold is advice: with nowhere to go, the session keeps working where it is.
        if (!advisory) await this.park(pane, from, chain, config, reason)
        return
      }
      if (advisory && !(await this.advisoryOk(pane, from, target, lines, view, config, now))) return
      await this.moveTo(pane, from, target, reason, lines, signal, view, config)
    })
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
    switchBack = false
  ): Promise<boolean> {
    if (hasDraft(lines)) {
      this.deps.log(`${pane.agent} ${pane.terminalId}: unsent text in the input box, not moving it`)
      return false
    }
    // Switch-back has its own rule for a target without numbers (see preferredOver).
    if (!(switchBack && !target.usage.known) && !enoughGap(from, target, config)) return false
    // Moving onto the seat Orca already selected changes nothing for other panes; a selection
    // change is what must not flap.
    if (view.active[target.provider] !== target.key && !this.canChangeSelection(target.provider, config, now)) return false
    return true
  }

  private canChangeSelection(provider: Provider, config: Config, now: number): boolean {
    const last = this.state.lastAutoSwitchAt?.[provider] ?? 0
    return now - last >= config.switchCooldownMinutes * 60_000
  }

  private noteSelectionChange(provider: Provider, reason: SwapReason, now: number): void {
    if (reason === 'manual') return
    this.state.lastAutoSwitchAt = { ...(this.state.lastAutoSwitchAt ?? {}), [provider]: now }
  }

  /** Switch-back (Orca issue #33193, tokenmaxx "return to primary"): a pane on a lower seat
   *  moves to the first healthy seat ahead of it in the chain. */
  async switchBack(pane: PaneInfo, lines: readonly string[]): Promise<void> {
    await this.withLock(pane.agent, async () => {
      if (!(await this.allowed(pane.agent))) return
      const config = await this.deps.config()
      if (!config.switchBack) return
      const view = await this.accountsFor(pane.server)
      const now = this.deps.now()
      if (this.probation(pane.agent, now)) return
      const at = this.locate(pane.terminalId, pane.agent, view)
      if (!at.seat) return
      const chain = buildChain(view.seats, pane.agent, config)
      // A running session only goes back to a seat that is known, or presumed reset.
      const preferred = preferredOver(chain, at.seat.key, this.state.health, config, now, 'pane')
      if (!preferred) return
      if (!(await this.advisoryOk(pane, at.seat, preferred, lines, view, config, now, true))) return
      await this.moveTo(pane, at.seat, preferred, 'switch_back', [...lines], undefined, view, config)
    })
  }

  private async park(pane: PaneInfo, from: Seat | undefined, chain: Seat[], config: Config, reason: SwapReason) {
    const now = this.deps.now()
    if (config.strategy === 'manual' || !config.waitForReset) {
      this.record({ provider: pane.agent, terminalId: pane.terminalId, reason, result: 'failed', ...(from ? { from: from.key } : {}), detail: config.strategy === 'manual' ? 'manual strategy' : 'no healthy seat' })
      await this.save()
      await this.deps.notify('Auto Hand-off', `${pane.agent}: no healthy account to switch to.`)
      this.publishNow()
      return
    }
    const wakeAt = earliestReset(chain, this.state.health, now) ?? now + config.defaultCooldownMinutes * 60_000
    const entry: WaitingEntry = { terminalId: pane.terminalId, workspaceId: pane.workspaceId, agent: pane.agent, wakeAt }
    if (pane.sessionId) entry.sessionId = pane.sessionId
    if (pane.agentId) entry.agentId = pane.agentId
    if (from) entry.fromSeat = from.key
    if (pane.server) entry.server = pane.server
    this.state.waiting = [...this.state.waiting.filter((w) => w.terminalId !== pane.terminalId), entry]
    this.record({ provider: pane.agent, terminalId: pane.terminalId, reason, result: 'waiting', ...(from ? { from: from.key } : {}), detail: `until ${new Date(wakeAt).toISOString()}` })
    await this.save()
    await this.deps.notify('Auto Hand-off', `Every ${pane.agent} account is exhausted; resuming at ${new Date(wakeAt).toLocaleString()}.`)
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
    config: Config
  ): Promise<void> {
    const canResume = !!pane.sessionId && ADAPTERS[pane.agent].resume === 'by-session-id'
    const agentId = pane.agentId ?? pane.agent
    try {
      if (view.active[target.provider] !== target.key) {
        await this.selectOn(target.provider, target.accountId, pane.server)
        view.active[target.provider] = target.key
        for (const s of view.seats) if (s.provider === target.provider) s.active = s.key === target.key
        this.noteSelectionChange(target.provider, reason, this.deps.now())
      }
      if (!config.autoResume) {
        // Only the account changes; the pane stays as it is for the user to resume.
        this.state.waiting = this.state.waiting.filter((w) => w.terminalId !== pane.terminalId)
        this.record({ provider: pane.agent, terminalId: pane.terminalId, reason, result: 'selected', ...(from ? { from: from.key } : {}), to: target.key, detail: 'auto_resume off' })
        if (reason !== 'manual') this.startProbation(target, config, this.deps.now())
        await this.save()
        this.publishNow()
        await this.deps.notify('Auto Hand-off', `${pane.agent}: new launches now use ${target.label}. Resume the session yourself (auto resume is off).`)
        return
      }
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
      this.state.waiting = this.state.waiting.filter((w) => w.terminalId !== pane.terminalId)
      this.record({
        provider: pane.agent,
        terminalId: newTerminal,
        reason,
        result: canResume ? 'resumed' : 'handoff',
        ...(from ? { from: from.key } : {}),
        to: target.key
      })
      if (reason !== 'manual') this.startProbation(target, config, this.deps.now())
      await this.save()
      this.publishNow()
      if (canResume) {
        await this.waitReady(newTerminal, pane.workspaceId)
        await this.seedSeen(newTerminal, pane.agent, pane.sessionId)
        if (config.autoMessage) await this.type(newTerminal, config.autoMessage, pane.server)
      }
      await this.deps.notify('Auto Hand-off', `${pane.agent}: ${from?.label ?? 'account'} → ${target.label} (${reason}).`)
    } catch (error) {
      const message = String((error as Error)?.message ?? error)
      this.deps.log(`swap failed: ${message}`)
      // Never retry a parked session forever: a failure ends its wait.
      this.state.waiting = this.state.waiting.filter((w) => w.terminalId !== pane.terminalId)
      // A seat that could not be switched to is skipped for a while, so the rotation moves on to
      // a usable one instead of retrying a broken one (Orca PR #43578).
      const skipUntil = this.deps.now() + FAILED_SWITCH_SKIP_MS
      const h = this.state.health[target.key]
      if (!h?.cooldownUntil || h.cooldownUntil < skipUntil) {
        this.state.health[target.key] = cooled(h, this.deps.now(), skipUntil, `switch failed: ${message}`)
      }
      this.record({ provider: pane.agent, terminalId: pane.terminalId, reason, result: 'failed', ...(from ? { from: from.key } : {}), to: target.key, detail: message.slice(0, 200) })
      await this.save()
      await this.deps.notify('Auto Hand-off', `Swap to ${target.label} failed: ${message}`)
      this.publishNow()
    }
  }

  /** A resumed session redraws its transcript, old limit banner included: that copy is not new. */
  private async seedSeen(terminalId: string, agent: Provider, sessionId?: string): Promise<void> {
    try {
      const { lines } = await this.deps.host.call('terminal.read', { terminalId, maxLines: 80 })
      const old = classify(agent, lines, this.deps.now())
      const key = this.seenKey(sessionId ? { terminalId, sessionId } : { terminalId })
      const had = this.state.seen[key]
      if (old && !(had && had.fingerprint === old.fingerprint && had.occurrences >= old.occurrences)) {
        this.state.seen[key] = { fingerprint: old.fingerprint, occurrences: old.occurrences }
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
    this.services = { ...config.services }
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
    for (const [provider, p] of Object.entries(this.state.probation ?? {})) {
      if (p && p.until <= now) {
        delete this.state.probation![provider as Provider]
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
        const ready = w.wakeAt <= now || pickNext(chain, undefined, this.state.health, config, now)
        if (ready) await this.wake(w)
      }
      await this.reselectPreferred(config)
      await this.sweepIdle(config)
    }
    await this.refreshFocus()
    this.publishNow()
  }

  /** Switch-back for new launches: when a seat ahead of the selected one is healthy again, select
   *  it, so the next launch uses it. Panes follow when they finish a turn or sit idle. */
  private async reselectPreferred(config: Config): Promise<void> {
    if (!config.switchBack) return
    const server = this.server
    for (const provider of PROVIDERS) {
      if (!config.services[provider]) continue
      const view = await this.accountsFor(server)
      const chain = buildChain(view.seats, provider, config)
      const now = this.deps.now()
      if (this.probation(provider, now)) continue
      if (!preferredOver(chain, view.active[provider], this.state.health, config, now, 'launch')) continue
      if (!this.canChangeSelection(provider, config, now)) continue
      await this.withLock(provider, async () => {
        if (!(await this.allowed(provider))) return
        const fresh = await this.accountsFor(server, true)
        const chain = buildChain(fresh.seats, provider, config)
        const from = fresh.active[provider]
        if (this.probation(provider, this.deps.now())) return
        // Only the selection moves, so a seat without numbers (and without strikes) is fine: at
        // worst one new session fails its first turn there, and the seat is struck.
        const preferred = preferredOver(chain, from, this.state.health, config, this.deps.now(), 'launch')
        if (!preferred) return
        try {
          await this.selectOn(provider, preferred.accountId, server)
        } catch (error) {
          const message = String((error as Error)?.message ?? error)
          this.deps.log(`switch back failed: ${message}`)
          this.state.health[preferred.key] = cooled(this.state.health[preferred.key], this.deps.now(), this.deps.now() + FAILED_SWITCH_SKIP_MS, `switch failed: ${message}`)
          await this.save()
          return
        }
        fresh.active[provider] = preferred.key
        for (const s of fresh.seats) if (s.provider === provider) s.active = s.key === preferred.key
        this.noteSelectionChange(provider, 'switch_back', this.deps.now())
        this.startProbation(preferred, config, this.deps.now())
        this.record({ provider, reason: 'switch_back', result: 'selected', ...(from ? { from } : {}), to: preferred.key })
        await this.save()
        await this.deps.notify('Auto Hand-off', `${PROVIDER_NAME[provider]}: ${preferred.label} is available again; new launches use it.`)
        this.publishNow()
      })
    }
  }

  /** cux `auto_swap_idle_after_seconds`: a session idle on an over-threshold seat, or on a
   *  lower seat while a higher-priority one is healthy, is moved without waiting for its next
   *  turn. Only looked at when some seat gives a reason to. */
  private async sweepIdle(config: Config): Promise<void> {
    if (config.autoSwapIdleAfterSeconds <= 0) return
    const view = await this.accountsFor(this.server)
    const now = this.deps.now()
    const due = PROVIDERS.filter((p) => {
      if (!config.services[p] || this.probation(p, now)) return false
      const chain = buildChain(view.seats, p, config)
      if (chain.length < 2) return false
      return chain.some(
        (s) =>
          (config.autoSwitchOnThreshold && overThreshold(s, config, now)) ||
          preferredOver(chain, s.key, this.state.health, config, now, 'pane')
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
        const seat = this.seatOf(row.terminalId, agent, wsView)
        if (!seat) continue
        const chain = buildChain(wsView.seats, agent, config)
        const over = config.autoSwitchOnThreshold && overThreshold(seat, config, now)
        if (!over && !preferredOver(chain, seat.key, this.state.health, config, now, 'pane')) continue
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
          else await this.switchBack(pane, lines)
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
      if (!(await this.allowed(w.agent))) return
      // The user went on in the parked pane, or the session already runs elsewhere: stop waiting.
      const { agents } = await this.deps.host.call('agents.list', { workspaceId: w.workspaceId }).catch(() => ({ agents: [] as any[] }))
      const busy = agents.some(
        (a: any) =>
          (a.terminalId === w.terminalId && a.state === 'working') ||
          (w.sessionId && a.sessionId === w.sessionId && a.terminalId !== w.terminalId)
      )
      if (busy) {
        this.state.waiting = this.state.waiting.filter((x) => x.terminalId !== w.terminalId)
        await this.save()
        this.publishNow()
        return
      }
      const config = await this.deps.config()
      const server = w.server ?? (await this.serverOfWorkspace(w.workspaceId))
      const view = await this.accountsFor(server, true)
      const now = this.deps.now()
      const chain = buildChain(view.seats, w.agent, config)
      const target = pickNext(chain, undefined, this.state.health, config, now)
      if (!target) {
        w.wakeAt = earliestReset(chain, this.state.health, now) ?? now + config.defaultCooldownMinutes * 60_000
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
      await this.moveTo(pane, from, target, 'reset', lines, undefined, view, config)
    })
  }

  // ---- commands ---------------------------------------------------------------------------

  async selectSeat(seatKey: string): Promise<string> {
    const view = await this.accounts(true)
    const server = this.server
    const seat = view.seats.find((s) => s.key === seatKey)
    if (!seat) throw Object.assign(new Error(`Unknown account ${seatKey}`), { code: 'invalid_params' })
    return this.withLock(seat.provider, async () => {
      const from = view.active[seat.provider]
      if (from !== seat.key) await this.selectOn(seat.provider, seat.accountId, server)
      this.record({ provider: seat.provider, reason: 'manual', result: 'selected', ...(from ? { from } : {}), to: seat.key })
      await this.save()
      await this.accountsFor(server, true)
      this.publishNow()
      return `${PROVIDER_NAME[seat.provider]}: new launches use ${seat.label}`
    })
  }

  async selectNext(provider: Provider): Promise<string> {
    const config = await this.deps.config()
    const view = await this.accounts(true)
    const chain = buildChain(view.seats, provider, config)
    const strategy = config.strategy === 'manual' ? 'drain' : config.strategy
    const next = pickNext(chain, view.active[provider], this.state.health, { ...config, strategy }, this.deps.now(), { mode: 'manual' })
    if (!next) return `${PROVIDER_NAME[provider]}: no other healthy account`
    return this.selectSeat(next.key)
  }

  /** The panel's *Manual switch*: select the chosen account of its service for new launches and
   *  move the current terminal's pane over if it runs this service and is between turns. The
   *  worker then turns the service's automatic hand-off off, so the rotator never undoes a
   *  choice the user made by hand; the panel says so and offers the toggle. A limited account
   *  is refused. Returns what happened and whether anything was switched. */
  async forceTo(seatKey: string): Promise<{ message: string; switched: boolean; provider: Provider }> {
    const config = await this.deps.config()
    const view = await this.accounts(true)
    const seat = view.seats.find((s) => s.key === seatKey)
    if (!seat) throw Object.assign(new Error(`Unknown account ${seatKey}`), { code: 'invalid_params' })
    const provider = seat.provider
    const now = this.deps.now()
    const health = this.state.health[seat.key]
    if (health?.cooldownUntil && health.cooldownUntil > now) {
      return { message: `${PROVIDER_NAME[provider]}: ${seat.label} is limited until ${new Date(health.cooldownUntil).toLocaleTimeString()}; clear the cooldown first`, switched: false, provider }
    }
    if (view.active[provider] === seat.key) return { message: `${PROVIDER_NAME[provider]}: new launches already use ${seat.label}`, switched: false, provider }
    const selected = await this.selectSeat(seat.key)
    const pane = await this.currentPane(provider)
    if (!pane) return { message: selected, switched: true, provider }
    if (pane.sshHost) return { message: `${selected}; this pane runs on SSH target ${pane.sshHost} with that machine's own login and is left alone`, switched: true, provider }
    if (pane.state !== 'waiting' && pane.state !== 'done') return { message: `${selected}; this pane keeps its account while it works`, switched: true, provider }
    const moved = await this.withLock(provider, async () => {
      const fresh = await this.accountsFor(pane.server)
      const at = this.locate(pane.terminalId, provider, fresh)
      const target = fresh.seats.find((s) => s.key === seat.key)
      if (!target || at.seat?.key === target.key) return null
      const { lines } = await this.deps.host.call('terminal.read', { terminalId: pane.terminalId, maxLines: 80 })
      if (!(await this.advisoryOk(pane, at.seat, target, lines, fresh, config, this.deps.now()))) return null
      const before = this.state.history.length
      await this.moveTo(pane, at.seat, target, 'manual', [...lines], undefined, fresh, config)
      return this.state.history.length > before ? this.state.history.at(-1) : null
    })
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
    const row =
      agents.find((a: any) => providerOf(a.agent) && (a.state === 'waiting' || a.state === 'done')) ??
      agents.find((a: any) => providerOf(a.agent))
    if (!row || !context?.workspaceId) return 'No agent in the focused workspace'
    const sshHost = await this.sshTargetOfWorkspace(context.workspaceId)
    if (sshHost) return `${providerOf(row.agent)}: this pane runs on SSH target ${sshHost}; Orca manages no accounts there`
    const server = await this.serverOfWorkspace(context.workspaceId)
    const pane: PaneInfo = { terminalId: row.terminalId, workspaceId: context.workspaceId, agent: providerOf(row.agent)! }
    if (row.agent !== pane.agent) pane.agentId = row.agent
    if (row.sessionId) pane.sessionId = row.sessionId
    if (server) pane.server = server
    const { lines } = await this.deps.host.call('terminal.read', { terminalId: row.terminalId, maxLines: 80 })
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

  async clearCooldown(seatKey: string): Promise<void> {
    delete this.state.health[seatKey]
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
        const h = this.state.health[s.key]
        const { liveKeys: _liveKeys, ...seat } = s
        return {
          ...seat,
          ...(h?.cooldownUntil ? { cooldownUntil: h.cooldownUntil } : {}),
          ...(h?.reason ? { cooldownReason: h.reason } : {})
        }
      }),
      waiting: this.state.waiting,
      history: this.state.history.filter((h) => h.at >= now - HISTORY_MAX_AGE_MS).slice(-100),
      services: { ...this.services }
    }
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
