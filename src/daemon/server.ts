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
import { PROVIDERS, type Provider, type ProxyProvider, type Snapshot } from '../core/types.ts'
import { VERSION } from '../core/version.ts'
import { createLineParser, encodeMessage, type RpcRequest, type RpcResponse, type WireMessage } from './ipc.ts'
import { OrcaTransport } from './orca-transport.ts'
import { benchProviders, LocalProxy } from './proxy.ts'
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
  readonly proxy: LocalProxy
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
        : (accounts, seats) => {
            const unavailable: Record<string, string> = {}
            for (const seat of seats) {
              const why = directQuotaUnavailable(accounts, seat)
              if (why) unavailable[seat.key] = why
            }
            const added = this.store.autoLinkQuota(seats.filter((seat) => !unavailable[seat.key]).map((seat) => seat.key))
            return { added, off: this.store.getQuotaUnlinks(), unavailable }
          },
      readLive: async (liveKey) => this.store.readLive(liveFileName(liveKey)),
      loadSamples: async () => this.store.loadSamples(),
      saveSamples: async (s) => this.store.saveSamples(s)
    }

    this.rotator = new Rotator(deps)
    this.proxy = new LocalProxy({
      getProviders: () => this.store.loadProviders(),
      now: this.now,
      log: this.log
    })
  }

  async start(): Promise<void> {
    this.store.ensureDir()
    this.store.removeStaleSocket(this.sockPath)
    await this.rotator.init()

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
    await this.proxy.stop()
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
      case 'quota.link': {
        if (typeof p.seatKey !== 'string' || typeof p.linked !== 'boolean') throw new Error('Account and link state are required.')
        const view = await this.rotator.accounts()
        if (this.rotator.snapshot().server) throw new Error('Quota links are available for local accounts only.')
        if (!view.seats.some((seat) => seat.key === p.seatKey && seat.accountId !== 'system')) throw new Error('Choose a saved Orca account.')
        this.store.setQuotaLink(p.seatKey, p.linked)
        await this.rotator.accounts(true)
        this.rotator.publishNow()
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
      case 'setExcluded': {
        if (typeof p.seatKey !== 'string' || typeof p.excluded !== 'boolean') {
          throw new Error('seatKey and excluded (boolean) are required')
        }
        this.rotator.notePresence()
        await this.inTurn(async () => {
          const exclude = await this.rotator.excludedChanged(p.seatKey, p.excluded)
          this.store.setSetting('exclude', exclude)
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
        let turnedOff = false
        const { message, switched, provider, draft } = await this.rotator.forceTo(
          p.seatKey,
          async (chosen) => {
            if (this.rotator.services[chosen] === false) return
            this.store.setSetting(`service_${chosen}`, false)
            await this.rotator.refreshServices(false)
            turnedOff = true
          },
          accepted
        )
        if (draft !== undefined) return { message, draft }
        if (!switched || !turnedOff) return { message }
        this.rotator.publishNow()
        const off = `${PROVIDER_NAME[provider]}: automatic hand-off is now off, because you chose an account yourself.`
        return { message: `${message}. ${off}` }
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
        const message = p.enabled ? await this.consoleLine.install() : await this.consoleLine.uninstall()
        const state = await this.consoleLine.status()
        this.broadcast('consoleLine', state)
        return { ...state, message }
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
      case 'proxy.status': {
        return this.proxy.status()
      }
      case 'proxy.start': {
        const port = typeof p.port === 'number' && p.port >= 0 ? p.port : 4080
        return this.proxy.start(port)
      }
      case 'proxy.stop': {
        await this.proxy.stop()
        return this.proxy.status()
      }
      case 'provider.list': {
        return { providers: this.store.loadProviders().map(({ apiKey: _k, ...rest }) => rest) }
      }
      case 'provider.add': {
        const kind = p.kind === 'anthropic' || p.kind === 'openai' ? p.kind : null
        if (!kind) throw new Error('kind must be "anthropic" or "openai"')
        if (typeof p.name !== 'string' || !p.name.trim()) throw new Error('name is required')
        if (typeof p.baseUrl !== 'string' || !/^https?:\/\//.test(p.baseUrl.trim())) throw new Error('valid http(s) baseUrl is required')
        if (typeof p.apiKey !== 'string' || !p.apiKey.trim()) throw new Error('apiKey is required')
        const list = this.store.loadProviders()
        const id =
          typeof p.id === 'string' && p.id.trim()
            ? p.id.trim()
            : `${kind}-${p.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 6)}`
        const entry: ProxyProvider = {
          id,
          kind,
          name: p.name.trim(),
          baseUrl: p.baseUrl.trim(),
          apiKey: p.apiKey.trim(),
          priority: typeof p.priority === 'number' ? p.priority : list.length + 1,
          enabled: p.enabled !== false,
          ...(p.modelMap && typeof p.modelMap === 'object' ? { modelMap: p.modelMap as Record<string, string> } : {})
        }
        const next = [...list.filter((x) => x.id !== id), entry]
        this.store.saveProviders(next)
        const { apiKey: _k, ...safe } = entry
        return { provider: safe }
      }
      case 'provider.rm': {
        if (typeof p.id !== 'string' || !p.id.trim()) throw new Error('id is required')
        const list = this.store.loadProviders()
        const next = list.filter((x) => x.id !== p.id.trim())
        if (next.length === list.length) throw new Error(`No provider "${p.id}"`)
        this.store.saveProviders(next)
        return { ok: true, id: p.id.trim() }
      }
      case 'provider.toggle': {
        if (typeof p.id !== 'string' || typeof p.enabled !== 'boolean') throw new Error('id and enabled (boolean) are required')
        const list = this.store.loadProviders()
        const target = list.find((x) => x.id === p.id)
        if (!target) throw new Error(`No provider "${p.id}"`)
        target.enabled = p.enabled
        this.store.saveProviders(list)
        return { ok: true, id: target.id, enabled: target.enabled }
      }
      case 'provider.bench': {
        const list = this.store.loadProviders()
        return { results: await benchProviders(list) }
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
