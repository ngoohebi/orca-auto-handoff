// `oahd` daemon server: owns the `Rotator` engine, file store, periodic ticks, live-usage watcher,
// and Unix domain socket JSON-RPC server serving `oah` CLI and the thin Orca plugin.
import { existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { nodeCli } from '../core/cli.ts'
import { directQuotaUnavailable, managedProfileQuota } from './probes.ts'
import { Rotator, type Cli, type Deps, type HostLike, type StatusEvent } from '../core/engine.ts'
import { PROVIDER_NAME } from '../core/labels.ts'
import { liveFileName } from '../core/live-usage.ts'
import { ConsoleStatusLine, nodeFiles, type Files } from '../core/statusline-files.ts'
import { PROVIDERS, type Provider, type Snapshot } from '../core/types.ts'
import { VERSION } from '../core/version.ts'
import { createLineParser, encodeMessage, type RpcRequest, type RpcResponse, type WireMessage } from './ipc.ts'
import { OrcaTransport } from './orca-transport.ts'
import { FileStore, socketPathFor } from './store.ts'

const MAX_TICK_MS = 30_000
function tickMs(pollIntervalSeconds: number): number {
  return Math.min(MAX_TICK_MS, Math.max(15_000, pollIntervalSeconds * 1000))
}
function nextTickMs(period: number, due: number | undefined): number {
  return due === undefined ? period : Math.min(period, Math.max(1000, due + 250))
}

export type DaemonOptions = {
  home?: string
  sockPath?: string
  cli?: Cli
  host?: HostLike
  files?: Files
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (msg: string) => void
  /** Set false in tests to disable background timers and fs.watch. */
  background?: boolean
}

export class OahDaemon {
  readonly store: FileStore
  readonly sockPath: string
  readonly transport: OrcaTransport
  readonly rotator: Rotator
  readonly consoleLine: ConsoleStatusLine
  private readonly log: (msg: string) => void
  private readonly now: () => number
  private readonly startedAt: number
  private server: Server | null = null
  private clients = new Set<Socket>()
  private subscribers = new Set<Socket>()
  private bridgeSocket: Socket | null = null
  private bridgePending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private bridgeSeq = 0
  private tickTimer: ReturnType<typeof setTimeout> | null = null
  private liveWatcher: FSWatcher | null = null
  private liveDebounce: ReturnType<typeof setTimeout> | null = null
  private listChange: Promise<unknown> = Promise.resolve()
  private stopped = false
  private readonly background: boolean

  constructor(opts: DaemonOptions = {}) {
    this.store = new FileStore(opts.home)
    this.sockPath = opts.sockPath ?? socketPathFor(this.store.home)
    this.log = opts.log ?? (() => undefined)
    this.now = opts.now ?? (() => Date.now())
    this.startedAt = this.now()
    this.background = opts.background !== false

    this.transport = new OrcaTransport(() => this.store.loadConfig().orcaCliPath, this.log)
    const host: HostLike = opts.host ?? this.transport
    const cli: Cli = opts.cli ?? nodeCli(async () => this.store.loadConfig().orcaCliPath)

    const files = opts.files ?? nodeFiles()
    this.consoleLine = new ConsoleStatusLine(files, {
      host,
      settings: async () => this.store.settingValues(),
      log: this.log,
      now: this.now
    })

    const deps: Deps = {
      host,
      cli,
      now: this.now,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      loadState: async () => this.store.loadState(),
      saveState: async (s) => this.store.saveState(s),
      config: async () => this.store.loadConfig(),
      log: this.log,
      notify: async (title, body) => {
        await host.call('notifications.show', { title, body }).catch((err: Error) => {
          this.log(`notify failed: ${err.message}`)
        })
      },
      publish: (snap) => {
        this.consoleLine.writeStatus(snap)
        this.broadcast('snapshot', snap)
      },
      loadUsage: async () => this.store.loadUsage(),
      saveUsage: async (c) => this.store.saveUsage(c),
      refreshProfileQuota: opts.cli ? undefined : managedProfileQuota(this.now, {
        load: () => this.store.loadQuotaRetries(),
        save: (retries) => this.store.saveQuotaRetries(retries)
      }),
      quotaStatus: opts.cli
        ? undefined
        : (accounts, seats) => ({
            added: this.store.autoLinkQuota(seats.filter((seat) => !directQuotaUnavailable(accounts, seat)).map((seat) => seat.key))
          }),
      readLive: async (liveKey) => this.store.readLive(liveFileName(liveKey)),
      loadSamples: async () => this.store.loadSamples(),
      saveSamples: async (s) => this.store.saveSamples(s)
    }

    this.rotator = new Rotator(deps)
  }

  /** The `console_statusline` setting, applied: the wrapper in, or out of, every workspace on
   *  this computer. Only a change of the setting removes it, never startup or a focus change. */
  private async applyStatusLine(on: boolean): Promise<string> {
    try {
      const said = on ? await this.consoleLine.installEverywhere() : await this.consoleLine.uninstallEverywhere()
      this.log(said)
      const line = await this.consoleLine.status().catch(() => null)
      if (line) this.broadcast('consoleLine', line)
      return said
    } catch (error) {
      const said = `Claude status line: ${String((error as Error)?.message ?? error)}`
      this.log(said)
      return said
    }
  }

  async start(): Promise<void> {
    this.store.ensureDir()
    this.store.removeStaleSocket(this.sockPath)
    await this.rotator.init()
    // On: workspaces added while the daemon was down get the status line too.
    if (this.store.settingValues().console_statusline === true) void this.applyStatusLine(true)

    await new Promise<void>((resolve, reject) => {
      const srv = createServer((socket) => this.onConnection(socket))
      srv.on('error', reject)
      srv.listen(this.sockPath, () => {
        this.server = srv
        resolve()
      })
    })

    if (this.background) {
      this.startLiveWatcher()
      void this.runTick()
    }
    this.log(`oahd ${VERSION} listening on ${this.sockPath}`)
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.tickTimer) {
      clearTimeout(this.tickTimer)
      this.tickTimer = null
    }
    if (this.liveDebounce) {
      clearTimeout(this.liveDebounce)
      this.liveDebounce = null
    }
    try {
      this.liveWatcher?.close()
    } catch {
      // Ignore watcher close errors.
    }
    this.liveWatcher = null
    this.clearBridge(new Error('oahd shutting down'))
    for (const sock of this.clients) sock.destroy()
    this.clients.clear()
    this.subscribers.clear()
    this.rotator.dispose()
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()))
      this.server = null
    }
    this.store.removeStaleSocket(this.sockPath)
  }

  private scheduleTick(): void {
    if (this.stopped || !this.background) return
    if (this.tickTimer) clearTimeout(this.tickTimer)
    const period = tickMs(this.store.loadConfig().pollIntervalSeconds)
    const delay = nextTickMs(period, this.rotator.countdownDueIn())
    this.tickTimer = setTimeout(() => void this.runTick(), delay)
  }

  private async runTick(): Promise<void> {
    if (this.stopped) return
    try {
      await this.rotator.tick()
    } catch (err) {
      this.log(`tick failed: ${String((err as Error)?.message ?? err)}`)
    } finally {
      this.scheduleTick()
    }
  }

  private startLiveWatcher(): void {
    try {
      mkdirSync(this.store.liveDir, { recursive: true, mode: 0o700 })
      if (!existsSync(this.store.liveDir)) return
      this.liveWatcher = watch(this.store.liveDir, () => {
        if (this.liveDebounce) clearTimeout(this.liveDebounce)
        this.liveDebounce = setTimeout(() => {
          this.liveDebounce = null
          void this.rotator.syncLivePanes().catch(() => undefined)
        }, 250)
      })
      this.liveWatcher.on('error', () => undefined)
    } catch {
      // Live directory watching is best-effort.
    }
  }

  private broadcast(event: string, data: unknown): void {
    const wire = encodeMessage({ type: 'event', event, data })
    for (const sock of this.subscribers) {
      try {
        sock.write(wire)
      } catch {
        this.subscribers.delete(sock)
      }
    }
  }

  private inTurn<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.listChange.then(fn, fn)
    this.listChange = run.catch(() => undefined)
    return run
  }

  private clearBridge(reason: Error): void {
    this.bridgeSocket = null
    this.transport.setBridge(null)
    for (const pending of this.bridgePending.values()) pending.reject(reason)
    this.bridgePending.clear()
  }

  private callBridge(method: string, params?: unknown): Promise<unknown> {
    const sock = this.bridgeSocket
    if (!sock) return Promise.reject(new Error('Orca plugin bridge is not connected'))
    const id = `b${++this.bridgeSeq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.bridgePending.delete(id)) reject(new Error(`Orca bridge timed out calling ${method}`))
      }, 30_000)
      this.bridgePending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      sock.write(encodeMessage({ type: 'req', id, method: 'host.call', params: { method, params } }))
    })
  }

  private onConnection(socket: Socket): void {
    this.clients.add(socket)
    socket.setEncoding('utf8')

    const parse = createLineParser((msg: WireMessage) => {
      if (msg.type === 'res') {
        const pending = this.bridgePending.get(msg.id)
        if (!pending) return
        this.bridgePending.delete(msg.id)
        if (msg.ok) pending.resolve(msg.result)
        else pending.reject(new Error(msg.error.message))
        return
      }
      if (msg.type === 'req') {
        void this.handleRequest(socket, msg)
      }
    })

    socket.on('data', (chunk) => parse(chunk.toString('utf8')))
    socket.on('close', () => {
      this.clients.delete(socket)
      this.subscribers.delete(socket)
      if (this.bridgeSocket === socket) {
        this.clearBridge(new Error('Orca plugin bridge disconnected'))
        this.log('Orca plugin bridge disconnected')
      }
    })
    socket.on('error', () => {
      this.clients.delete(socket)
      this.subscribers.delete(socket)
    })
  }

  private async handleRequest(socket: Socket, req: RpcRequest): Promise<void> {
    const reply = (res: RpcResponse) => {
      try {
        socket.write(encodeMessage(res))
      } catch {
        // Client gone.
      }
    }
    try {
      const result = await this.dispatch(socket, req.method, (req.params ?? {}) as Record<string, any>)
      reply({ type: 'res', id: req.id, ok: true, result })
    } catch (err) {
      const e = err as Error & { code?: string }
      reply({ type: 'res', id: req.id, ok: false, error: { code: e.code, message: String(e?.message ?? err) } })
    }
  }

  async dispatch(socket: Socket | null, method: string, p: Record<string, any>): Promise<unknown> {
    switch (method) {
      case 'ping':
        return {
          version: VERSION,
          pid: process.pid,
          uptimeMs: Math.max(0, this.now() - this.startedAt),
          bridgeConnected: this.transport.bridgeConnected
        }
      case 'subscribe':
        if (socket) this.subscribers.add(socket)
        return { ok: true, version: VERSION }
      case 'bridge.register':
        if (socket) {
          this.bridgeSocket = socket
          this.transport.setBridge((m, params) => this.callBridge(m, params))
          this.log('Orca plugin bridge connected')
        }
        return { ok: true, version: VERSION }
      case 'snapshot': {
        if (p.refresh) this.rotator.notePresence()
        await Promise.all([this.rotator.accounts(!!p.refresh, !!p.refresh, p.directQuota === true), this.rotator.refreshFocus()])
        if (!p.refresh) await this.rotator.syncLivePanes(false)
        return this.rotator.snapshot()
      }
      case 'pause': {
        if (typeof p.paused !== 'boolean') throw new Error('paused (boolean) is required')
        this.rotator.notePresence()
        await this.rotator.setPaused(p.paused)
        return { paused: p.paused }
      }
      case 'setService': {
        const provider = String(p.provider ?? '') as Provider
        if (!(PROVIDERS as readonly string[]).includes(provider)) throw new Error(`Unknown service "${provider}"`)
        if (typeof p.enabled !== 'boolean') throw new Error('enabled (boolean) is required')
        this.rotator.notePresence()
        this.store.setSetting(`service_${provider}`, p.enabled)
        await this.rotator.refreshServices()
        return { services: this.rotator.services }
      }
      case 'settings': {
        if (p.key !== undefined) {
          this.rotator.notePresence()
          const values = this.store.setSetting(String(p.key), p.value)
          if (p.key === 'console_statusline') await this.applyStatusLine(values.console_statusline === true)
          await this.rotator.refreshServices()
          this.consoleLine.invalidate()
          this.rotator.publishNow()
          this.broadcast('settings', values)
          this.scheduleTick()
          return values
        }
        return this.store.settingValues()
      }
      case 'moveSeat': {
        if (typeof p.seatKey !== 'string' || (p.by !== -1 && p.by !== 1)) {
          throw new Error('seatKey and by (-1 or 1) are required')
        }
        this.rotator.notePresence()
        await this.inTurn(async () => {
          const chain = await this.rotator.orderMoved(p.seatKey, p.by)
          this.store.setSetting('chain', chain)
          await this.rotator.refreshServices()
        })
        return { ok: true }
      }
      case 'clearCooldown': {
        if (typeof p.seatKey !== 'string') throw new Error('seatKey is required')
        this.rotator.notePresence()
        await this.rotator.clearCooldown(p.seatKey)
        return { ok: true }
      }
      case 'switchTo': {
        if (typeof p.seatKey !== 'string') throw new Error('seatKey is required')
        this.rotator.notePresence()
        const accepted =
          p.acceptDraft === true && typeof p.draft?.terminalId === 'string' && typeof p.draft?.text === 'string'
            ? { terminalId: p.draft.terminalId, text: p.draft.text }
            : undefined
        // An early hand-off by hand: automatic hand-off stays on and goes on by its usual rules.
        const { message, switched, draft } = await this.rotator.forceTo(p.seatKey, undefined, accepted)
        if (draft !== undefined) return { message, draft }
        if (switched) this.rotator.publishNow()
        return { message }
      }
      case 'handoff': {
        this.rotator.notePresence()
        const message = await this.rotator.swapFocused()
        return { message }
      }
      case 'nextAccount': {
        const provider = String(p.provider ?? 'claude') as Provider
        if (!(PROVIDERS as readonly string[]).includes(provider)) throw new Error(`Unknown service "${provider}"`)
        this.rotator.notePresence()
        const message = await this.rotator.selectNext(provider)
        return { message }
      }
      case 'handoffNow': {
        if (typeof p.terminalId !== 'string') throw new Error('terminalId is required')
        this.rotator.notePresence()
        const message = await this.rotator.handoffNow(p.terminalId)
        return message ? { ok: true, message } : { ok: true }
      }
      case 'declineHandoff': {
        if (typeof p.terminalId !== 'string') throw new Error('terminalId is required')
        this.rotator.notePresence()
        await this.rotator.declineHandoff(p.terminalId)
        return { ok: true }
      }
      case 'cancelWaiting': {
        if (typeof p.terminalId !== 'string') throw new Error('terminalId is required')
        this.rotator.notePresence()
        await this.rotator.cancelWaiting(p.terminalId)
        return { ok: true }
      }
      case 'focus': {
        if (await this.rotator.refreshFocus()) this.rotator.publishNow()
        return this.rotator.focused ? { focused: this.rotator.focused } : {}
      }
      case 'consoleLine': {
        if (typeof p.enabled !== 'boolean') return this.consoleLine.status()
        this.rotator.notePresence()
        // The status line is one setting for every workspace: `oah statusline install` turns it on.
        const values = this.store.setSetting('console_statusline', p.enabled)
        this.broadcast('settings', values)
        const said = await this.applyStatusLine(p.enabled)
        const now = await this.consoleLine.status()
        return { ...now, message: said }
      }
      case 'history': {
        const snap: Snapshot = this.rotator.snapshot()
        const limit = typeof p.limit === 'number' && p.limit > 0 ? p.limit : 50
        return snap.history.slice(-limit)
      }
      case 'event.status': {
        await this.rotator.onAgentStatus(p as StatusEvent)
        this.scheduleTick()
        return { ok: true }
      }
      case 'event.workspace': {
        this.rotator.notePresence()
        if (await this.rotator.refreshFocus()) this.rotator.publishNow()
        // A workspace opened since the status line was turned on gets it too.
        if (this.store.settingValues().console_statusline === true) {
          await this.consoleLine.ensureFocused().catch((error: Error) => this.log(`console status line: ${error.message}`))
        }
        const line = await this.consoleLine.status().catch(() => null)
        if (line) this.broadcast('consoleLine', line)
        return { ok: true }
      }
      case 'event.launchBefore': {
        const agent = typeof p.agent === 'string' ? p.agent : ''
        const terminalId = typeof p.terminalId === 'string' ? p.terminalId : ''
        const workspaceId = typeof p.workspaceId === 'string' ? p.workspaceId : undefined
        if (agent && terminalId) this.rotator.noteLaunch(agent, terminalId, workspaceId)
        return { ok: true }
      }
      case 'event.presence': {
        this.rotator.notePresence()
        return { ok: true }
      }
      case 'event.stopFailure': {
        return this.rotator.onStopFailure({
          sessionId: typeof p.sessionId === 'string' ? p.sessionId : undefined,
          terminalId: typeof p.terminalId === 'string' ? p.terminalId : undefined,
          workspaceId: typeof p.workspaceId === 'string' ? p.workspaceId : undefined,
          error: typeof p.error === 'string' ? p.error : undefined
        })
      }
      case 'active': {
        const snap = this.rotator.snapshot()
        const want = typeof p.provider === 'string' ? p.provider.toLowerCase() : undefined
        const activeSeats = snap.seats.filter((s) => s.active && (!want || s.provider === want))
        return {
          active: activeSeats.map((s) => ({
            key: s.key,
            provider: s.provider,
            accountId: s.accountId,
            label: s.label,
            circuit: s.circuit ?? 'closed',
            ...(s.cooldownUntil ? { cooldownUntil: s.cooldownUntil } : {}),
            usage: s.usage
          }))
        }
      }
      case 'pins': {
        return { pins: this.store.getPins() }
      }
      case 'pin': {
        if (typeof p.target !== 'string' || !p.target.trim() || typeof p.seatKey !== 'string' || !p.seatKey.trim()) {
          throw new Error('target (workspaceId or terminalId) and seatKey are required')
        }
        this.rotator.notePresence()
        const pins = this.store.setPin(p.target.trim(), p.seatKey.trim())
        await this.rotator.refreshServices()
        return { pins }
      }
      case 'unpin': {
        if (typeof p.target !== 'string' || !p.target.trim()) throw new Error('target is required')
        this.rotator.notePresence()
        const pins = this.store.removePin(p.target.trim())
        await this.rotator.refreshServices()
        return { pins }
      }
      case 'sync.export': {
        return this.store.exportConfig()
      }
      case 'sync.import': {
        if (!p.config || typeof p.config !== 'object') throw new Error('config object is required')
        const values = this.store.importConfig(p.config as Record<string, unknown>)
        await this.rotator.refreshServices()
        this.rotator.publishNow()
        this.broadcast('settings', values)
        return { ok: true, settings: values }
      }
      case 'debug': {
        return {
          version: VERSION,
          pid: process.pid,
          home: this.store.home,
          sockPath: this.sockPath,
          bridgeConnected: this.transport.bridgeConnected,
          events: this.rotator.recentEvents
        }
      }
      case 'shutdown': {
        setTimeout(() => void this.stop(), 10)
        return { ok: true }
      }
      default:
        throw new Error(`Unknown RPC method "${method}"`)
    }
  }
}
