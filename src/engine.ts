// The rotator: reacts to agent status, classifies the terminal tail, and swaps seats.
// Every side effect goes through Deps so tests run it with a fake host, CLI and clock.
import { ADAPTERS, CHROME, classify, countCopies, parseModelFallback } from './adapters'
import { parseAccounts, type AccountView } from './accounts'
import { buildChain, earliestReset, isEligible, overThreshold, pickNext } from './selector'
import {
  HISTORY_CAP,
  allServices,
  emptyState,
  isProvider,
  type Config,
  type HistoryEntry,
  type Provider,
  type RotatorState,
  type Seat,
  type Signal,
  type Snapshot,
  type SwapReason,
  type WaitingEntry
} from './types'

export type HostLike = { call(method: string, params?: unknown): Promise<any> }

export type Cli = {
  /** `orca account list --json` → its `result`. */
  listAccounts(): Promise<Record<string, any>>
  select(provider: Provider, accountId: string): Promise<void>
  /** `orca terminal close`, which also closes terminals outside the focused workspace. */
  closeTerminal(terminalId: string): Promise<void>
  /** `orca terminal send --enter`, which also reaches terminals outside the focused workspace. */
  sendText(terminalId: string, text: string): Promise<void>
  git(cwd: string, args: string[]): Promise<string>
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

export function backoffMs(attempt: number): number {
  let a = 1
  let b = 1
  for (let i = 0; i < attempt; i++) [a, b] = [b, a + b]
  return Math.min(a * 5000, 120_000)
}

export class Rotator {
  state: RotatorState = emptyState()
  private view: AccountView | null = null
  private viewAt = 0
  private viewError: string | undefined
  private locks = new Map<Provider, Promise<unknown>>()
  private inflight = new Set<string>()
  /** Services with automatic switching on (from settings). */
  services: Record<Provider, boolean> = allServices(true)
  /** The last few status events, for `rotator.debug`. */
  recentEvents: StatusEvent[] = []

  constructor(private deps: Deps) {}

  async init(): Promise<void> {
    const saved = await this.deps.loadState()
    this.state = { ...emptyState(), ...(saved ?? {}) }
    await this.refreshServices(false)
  }

  async refreshServices(publish = true): Promise<void> {
    this.services = { ...(await this.deps.config()).services }
    if (publish) this.publishNow()
  }

  private async save(): Promise<void> {
    if (this.state.history.length > HISTORY_CAP) {
      this.state.history = this.state.history.slice(-HISTORY_CAP)
    }
    const seenKeys = Object.keys(this.state.seen)
    if (seenKeys.length > 500) {
      for (const k of seenKeys.slice(0, seenKeys.length - 500)) delete this.state.seen[k]
    }
    await this.deps.saveState(this.state)
  }

  private record(entry: Omit<HistoryEntry, 'at'>): void {
    this.state.history.push({ at: this.deps.now(), ...entry })
  }

  // ---- accounts ---------------------------------------------------------------------------

  async accounts(force = false): Promise<AccountView> {
    const config = await this.deps.config()
    const fresh = this.deps.now() - this.viewAt < config.pollIntervalSeconds * 1000
    if (this.view && fresh && !force) return this.view
    try {
      this.view = parseAccounts(await this.deps.cli.listAccounts())
      this.viewAt = this.deps.now()
      this.viewError = undefined
    } catch (error) {
      this.viewError = `orca account list failed: ${String((error as Error)?.message ?? error)}`
      this.deps.log(this.viewError)
      if (!this.view) this.view = { seats: [], active: {} }
    }
    return this.view
  }

  /** The cached view without a CLI call; for hooks, which must answer within 2 s. */
  cachedView(): AccountView | null {
    return this.view
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
  noteLaunch(agent: string, terminalId: string | undefined): void {
    const provider = providerOf(agent)
    if (!provider || !terminalId || !this.view) return
    const key = this.view.active[provider]
    if (key) {
      this.state.paneSeat[terminalId] = key
      void this.save()
    }
  }

  async onAgentStatus(event: StatusEvent): Promise<void> {
    this.recentEvents = [...this.recentEvents.slice(-9), event]
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
      await this.inspect(pane, this.state.paused)
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

  async inspect(pane: PaneInfo, observeOnly = false): Promise<void> {
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
      if (config.autoSwitchOnThreshold) {
        const view = await this.accounts()
        const seat = this.seatOf(pane.terminalId, pane.agent, view)
        if (seat && overThreshold(seat, config, this.deps.now())) {
          await this.swap(pane, 'threshold', lines)
        }
      }
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
      await this.deps.notify('Account Rotator', `${pane.agent}: API errors persist after ${attempt} retries.`)
      this.publishNow()
      return
    }
    this.state.apiRetries[pane.terminalId] = attempt + 1
    await this.save()
    await this.deps.sleep(backoffMs(attempt))
    if (!(await this.allowed(pane.agent))) return
    await this.type(pane.terminalId, config.autoMessage || 'continue')
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
    await this.type(pane.terminalId, adapter.modelSwitch(model))
    await this.deps.sleep(1500)
    if (config.autoMessage) await this.type(pane.terminalId, config.autoMessage)
    this.record({ provider: pane.agent, terminalId: pane.terminalId, reason: 'model_cap', result: 'model', detail: `${signal.model ?? 'model'} capped → ${model}` })
    await this.save()
    this.publishNow()
    return true
  }

  private async limitHit(pane: PaneInfo, signal: Signal, config: Config, lines: string[], reason: SwapReason): Promise<void> {
    if (!config.autoSwitchOnRateLimit) {
      await this.withLock(pane.agent, async () => {
        const view = await this.accounts(true)
        const at = this.locate(pane.terminalId, pane.agent, view)
        if (at.seat && (at.known || this.plausiblyLimited(at.seat))) await this.coolDown(at.seat, signal, config, reason)
        await this.deps.notify('Account Rotator', `${pane.agent} hit a limit on ${at.seat?.label ?? 'its account'}; switching on rate limit is off.`)
        this.publishNow()
      })
      return
    }
    await this.swap(pane, reason, lines, signal)
  }

  private async coolDown(seat: Seat, signal: Signal, config: Config, reason: SwapReason): Promise<void> {
    const now = this.deps.now()
    const usageReset = [seat.usage.session, seat.usage.weekly]
      .filter((w) => w && w.usedPercent >= 100 && w.resetsAt && w.resetsAt > now)
      .map((w) => w!.resetsAt!)
    const until =
      signal.resetsAt ??
      (usageReset.length ? Math.max(...usageReset) : undefined) ??
      now + (reason === 'auth' ? 12 * 60 : config.defaultCooldownMinutes) * 60_000
    this.state.health[seat.key] = { cooldownUntil: until, reason: `${reason}: ${signal.line}`.slice(0, 200) }
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
    this.state.health[seat.key] = { cooldownUntil: until, reason: 'threshold: over the usage threshold' }
    await this.save()
  }

  /** Could this seat be the one that just hit a limit? False when Orca's own numbers say it has
   *  plenty of room, i.e. the limited pane must be on some other (older) account. */
  private plausiblyLimited(seat: Seat): boolean {
    const u = seat.usage
    if (!u.known) return true
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
      const view = await this.accounts(true)
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
      const picked = healthyActive ?? pickNext(chain, from?.key, this.state.health, config, now)
      // Only ever another account of the same service.
      const target = picked && picked.provider === pane.agent ? picked : null
      if (!target) {
        // A threshold is advice: with nowhere to go, the session keeps working where it is.
        if (reason !== 'threshold') await this.park(pane, from, chain, config, reason)
        return
      }
      await this.moveTo(pane, from, target, reason, lines, signal, view, config)
    })
  }

  private async park(pane: PaneInfo, from: Seat | undefined, chain: Seat[], config: Config, reason: SwapReason) {
    const now = this.deps.now()
    if (config.strategy === 'manual' || !config.waitForReset) {
      this.record({ provider: pane.agent, terminalId: pane.terminalId, reason, result: 'failed', ...(from ? { from: from.key } : {}), detail: config.strategy === 'manual' ? 'manual strategy' : 'no healthy seat' })
      await this.save()
      await this.deps.notify('Account Rotator', `${pane.agent}: no healthy account to switch to.`)
      this.publishNow()
      return
    }
    const wakeAt = earliestReset(chain, this.state.health, now) ?? now + config.defaultCooldownMinutes * 60_000
    const entry: WaitingEntry = { terminalId: pane.terminalId, workspaceId: pane.workspaceId, agent: pane.agent, wakeAt }
    if (pane.sessionId) entry.sessionId = pane.sessionId
    if (pane.agentId) entry.agentId = pane.agentId
    if (from) entry.fromSeat = from.key
    this.state.waiting = [...this.state.waiting.filter((w) => w.terminalId !== pane.terminalId), entry]
    this.record({ provider: pane.agent, terminalId: pane.terminalId, reason, result: 'waiting', ...(from ? { from: from.key } : {}), detail: `until ${new Date(wakeAt).toISOString()}` })
    await this.save()
    await this.deps.notify('Account Rotator', `Every ${pane.agent} account is exhausted; resuming at ${new Date(wakeAt).toLocaleString()}.`)
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
        await this.deps.cli.select(target.provider, target.accountId)
        view.active[target.provider] = target.key
        for (const s of view.seats) if (s.provider === target.provider) s.active = s.key === target.key
      }
      if (!config.autoResume) {
        // Only the account changes; the pane stays as it is for the user to resume.
        this.state.waiting = this.state.waiting.filter((w) => w.terminalId !== pane.terminalId)
        this.record({ provider: pane.agent, terminalId: pane.terminalId, reason, result: 'selected', ...(from ? { from: from.key } : {}), to: target.key, detail: 'auto_resume off' })
        await this.save()
        this.publishNow()
        await this.deps.notify('Account Rotator', `${pane.agent}: new launches now use ${target.label}. Resume the session yourself (auto resume is off).`)
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
      await this.save()
      this.publishNow()
      if (canResume) {
        await this.waitReady(newTerminal, pane.workspaceId)
        await this.seedSeen(newTerminal, pane.agent, pane.sessionId)
        if (config.autoMessage) await this.type(newTerminal, config.autoMessage)
      }
      await this.deps.notify('Account Rotator', `${pane.agent}: ${from?.label ?? 'account'} → ${target.label} (${reason}).`)
    } catch (error) {
      const message = String((error as Error)?.message ?? error)
      this.deps.log(`swap failed: ${message}`)
      // Never retry a parked session forever: a failure ends its wait.
      this.state.waiting = this.state.waiting.filter((w) => w.terminalId !== pane.terminalId)
      this.record({ provider: pane.agent, terminalId: pane.terminalId, reason, result: 'failed', ...(from ? { from: from.key } : {}), to: target.key, detail: message.slice(0, 200) })
      await this.save()
      await this.deps.notify('Account Rotator', `Swap to ${target.label} failed: ${message}`)
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
        await this.deps.cli.closeTerminal(pane.terminalId)
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

  private async type(terminalId: string, text: string): Promise<void> {
    try {
      const { accepted } = await this.deps.host.call('terminal.sendText', { terminalId, text, enter: true })
      if (accepted) return
    } catch {
      // Live Orca refuses plugin sends outside the focused workspace ("terminal is outside the
      // active worktree"); the CLI has no such limit.
    }
    await this.deps.cli.sendText(terminalId, text)
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
    let changed = false
    for (const [key, h] of Object.entries(this.state.health)) {
      if (h.cooldownUntil && h.cooldownUntil <= now) {
        delete this.state.health[key]
        changed = true
      }
    }
    if (changed) await this.save()
    if (!this.state.paused) {
      for (const w of [...this.state.waiting]) {
        if (!config.services[w.agent]) continue
        const chain = buildChain(view.seats, w.agent, config)
        const ready = w.wakeAt <= now || pickNext(chain, undefined, this.state.health, config, now)
        if (ready) await this.wake(w)
      }
    }
    this.publishNow()
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
      const view = await this.accounts(true)
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
    const seat = view.seats.find((s) => s.key === seatKey)
    if (!seat) throw Object.assign(new Error(`Unknown account ${seatKey}`), { code: 'invalid_params' })
    return this.withLock(seat.provider, async () => {
      const from = view.active[seat.provider]
      if (from !== seat.key) await this.deps.cli.select(seat.provider, seat.accountId)
      this.record({ provider: seat.provider, reason: 'manual', result: 'selected', ...(from ? { from } : {}), to: seat.key })
      await this.save()
      await this.accounts(true)
      this.publishNow()
      return `${seat.provider}: new launches use ${seat.label}`
    })
  }

  async selectNext(provider: Provider): Promise<string> {
    const config = await this.deps.config()
    const view = await this.accounts(true)
    const chain = buildChain(view.seats, provider, config)
    const strategy = config.strategy === 'manual' ? 'drain' : config.strategy
    const next = pickNext(chain, view.active[provider], this.state.health, { ...config, strategy }, this.deps.now())
    if (!next) return `${provider}: no other healthy account`
    return this.selectSeat(next.key)
  }

  async swapFocused(): Promise<string> {
    const { agents } = await this.deps.host.call('agents.list')
    const context = await this.deps.host.call('workspace.readContext')
    const row =
      agents.find((a: any) => providerOf(a.agent) && (a.state === 'waiting' || a.state === 'done')) ??
      agents.find((a: any) => providerOf(a.agent))
    if (!row || !context?.workspaceId) return 'No agent in the focused workspace'
    const pane: PaneInfo = { terminalId: row.terminalId, workspaceId: context.workspaceId, agent: providerOf(row.agent)! }
    if (row.agent !== pane.agent) pane.agentId = row.agent
    if (row.sessionId) pane.sessionId = row.sessionId
    const { lines } = await this.deps.host.call('terminal.read', { terminalId: row.terminalId, maxLines: 80 })
    const before = this.state.history.length
    await this.swap(pane, 'manual', lines)
    const last = this.state.history.length > before ? this.state.history.at(-1) : undefined
    if (!last) return `${pane.agent}: nothing to do`
    const label = (key?: string) => this.view?.seats.find((s) => s.key === key)?.label ?? key ?? '?'
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
    const view = this.view ?? { seats: [], active: {} }
    const snap: Snapshot = {
      paused: this.state.paused,
      updatedAt: this.viewAt,
      seats: view.seats.map((s) => {
        const h = this.state.health[s.key]
        return {
          ...s,
          ...(h?.cooldownUntil ? { cooldownUntil: h.cooldownUntil } : {}),
          ...(h?.reason ? { cooldownReason: h.reason } : {})
        }
      }),
      waiting: this.state.waiting,
      history: this.state.history.slice(-100),
      services: { ...this.services }
    }
    if (this.viewError) snap.error = this.viewError
    return snap
  }

  publishNow(): void {
    this.deps.publish(this.snapshot())
  }
}
