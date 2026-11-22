// Optional local HTTP failover proxy + endpoint latency bench for API-key / relay providers.
// Zero npm dependencies: built on `node:http` + `fetch`, sharing OAH's 3-state circuit breaker.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { circuitState } from '../core/selector.ts'
import type { CircuitState, ProxyProvider, SeatHealth } from '../core/types.ts'

export type BenchResult = {
  id: string
  name: string
  kind: ProxyProvider['kind']
  baseUrl: string
  ok: boolean
  latencyMs: number
  band: 'fast' | 'ok' | 'slow' | 'error'
  status?: number
  error?: string
}

export type ProxyStatus = {
  running: boolean
  host: string
  port: number
  providers: {
    id: string
    name: string
    kind: ProxyProvider['kind']
    baseUrl: string
    priority: number
    enabled: boolean
    circuit: CircuitState
    cooldownUntil?: number
    consecutiveFailures: number
  }[]
}

const FAILOVER_STATUSES = new Set([429, 500, 502, 503, 529])
const BASE_BACKOFF_MS = 30_000
const MAX_BACKOFF_MS = 10 * 60_000

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function kindForPath(urlPath: string): ProxyProvider['kind'] {
  if (urlPath.startsWith('/v1/messages')) return 'anthropic'
  return 'openai'
}

function rewriteModel(bodyText: string, modelMap?: Record<string, string>): string {
  if (!modelMap || !bodyText.trim()) return bodyText
  try {
    const json = JSON.parse(bodyText) as Record<string, unknown>
    if (typeof json.model === 'string' && modelMap[json.model]) {
      json.model = modelMap[json.model]
      return JSON.stringify(json)
    }
  } catch {
    // Non-JSON body; forward as-is.
  }
  return bodyText
}

export class LocalProxy {
  private server: Server | null = null
  private port = 4080
  private readonly host = '127.0.0.1'
  private health = new Map<string, SeatHealth>()
  private readonly getProviders: () => ProxyProvider[]
  private readonly now: () => number
  private readonly log: (msg: string) => void

  constructor(opts: { getProviders: () => ProxyProvider[]; now?: () => number; log?: (msg: string) => void }) {
    this.getProviders = opts.getProviders
    this.now = opts.now ?? (() => Date.now())
    this.log = opts.log ?? (() => undefined)
  }

  get running(): boolean {
    return this.server !== null
  }

  get boundPort(): number {
    return this.port
  }

  status(): ProxyStatus {
    const now = this.now()
    return {
      running: this.running,
      host: this.host,
      port: this.port,
      providers: this.getProviders()
        .slice()
        .sort((a, b) => a.priority - b.priority)
        .map((p) => {
          const h = this.health.get(p.id)
          const circuit = circuitState(h, now)
          return {
            id: p.id,
            name: p.name,
            kind: p.kind,
            baseUrl: p.baseUrl,
            priority: p.priority,
            enabled: p.enabled,
            circuit,
            ...(h?.cooldownUntil && h.cooldownUntil > now ? { cooldownUntil: h.cooldownUntil } : {}),
            consecutiveFailures: h?.consecutiveFailures ?? 0
          }
        })
    }
  }

  async start(port = this.port): Promise<ProxyStatus> {
    if (this.server) return this.status()
    await new Promise<void>((resolve, reject) => {
      const srv = createServer((req, res) => {
        void this.handle(req, res)
      })
      srv.on('error', reject)
      srv.listen(port, this.host, () => {
        this.server = srv
        const addr = srv.address()
        this.port = addr && typeof addr === 'object' ? addr.port : port
        resolve()
      })
    })
    this.log(`local HTTP proxy listening on http://${this.host}:${this.port}`)
    return this.status()
  }

  async stop(): Promise<void> {
    if (!this.server) return
    const srv = this.server
    this.server = null
    await new Promise<void>((resolve) => srv.close(() => resolve()))
    this.log('local HTTP proxy stopped')
  }

  private candidates(kind: ProxyProvider['kind']): ProxyProvider[] {
    const now = this.now()
    const eligible = this.getProviders()
      .filter((p) => p.enabled && p.kind === kind)
      .filter((p) => circuitState(this.health.get(p.id), now) !== 'open')
    return eligible.sort((a, b) => {
      const ca = circuitState(this.health.get(a.id), now) === 'closed' ? 0 : 1
      const cb = circuitState(this.health.get(b.id), now) === 'closed' ? 0 : 1
      if (ca !== cb) return ca - cb
      return a.priority - b.priority
    })
  }

  private markSuccess(id: string): void {
    const h = this.health.get(id)
    if (h) {
      h.circuit = 'closed'
      h.consecutiveFailures = 0
      delete h.cooldownUntil
      delete h.reason
    }
  }

  private markFailure(id: string, reason: string, retryAfterSec?: number): void {
    const now = this.now()
    const prev = this.health.get(id) ?? {}
    const failures = (prev.consecutiveFailures ?? 0) + 1
    const backoff =
      retryAfterSec && retryAfterSec > 0
        ? retryAfterSec * 1000
        : Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (failures - 1))
    this.health.set(id, {
      ...prev,
      circuit: 'open',
      consecutiveFailures: failures,
      cooldownUntil: now + backoff,
      freedAt: now + backoff,
      reason
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const urlPath = req.url ?? '/'
    if (urlPath === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(this.status()))
      return
    }

    const kind = kindForPath(urlPath)
    const queue = this.candidates(kind)
    if (queue.length === 0) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `No healthy ${kind} proxy providers available` } }))
      return
    }

    const rawBody = req.method !== 'GET' && req.method !== 'HEAD' ? await readBody(req) : ''
    let lastError = 'All upstream providers failed'
    let lastStatus = 502

    for (const provider of queue) {
      const targetUrl = `${provider.baseUrl.replace(/\/+$/, '')}${urlPath}`
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase()
        if (lk === 'host' || lk === 'content-length' || lk === 'connection' || lk === 'authorization' || lk === 'x-api-key') continue
        if (typeof v === 'string') headers[lk] = v
      }
      if (provider.kind === 'anthropic') {
        headers['x-api-key'] = provider.apiKey
        if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01'
      } else {
        headers['authorization'] = `Bearer ${provider.apiKey}`
      }
      const body = rewriteModel(rawBody, provider.modelMap)

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30_000)
      try {
        const upstream = await fetch(targetUrl, {
          method: req.method ?? 'POST',
          headers,
          body: req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
          signal: controller.signal
        })
        clearTimeout(timer)

        if (FAILOVER_STATUSES.has(upstream.status)) {
          const retryAfter = Number(upstream.headers.get('retry-after') ?? '0')
          this.markFailure(provider.id, `HTTP ${upstream.status}`, Number.isFinite(retryAfter) ? retryAfter : undefined)
          lastStatus = upstream.status
          lastError = `${provider.name}: HTTP ${upstream.status}`
          this.log(`proxy failover from ${provider.name} (HTTP ${upstream.status})`)
          continue
        }

        this.markSuccess(provider.id)
        const outHeaders: Record<string, string> = {}
        upstream.headers.forEach((v, k) => {
          const lk = k.toLowerCase()
          if (lk !== 'transfer-encoding' && lk !== 'connection' && lk !== 'content-encoding') outHeaders[k] = v
        })
        outHeaders['x-oah-provider'] = provider.id
        res.writeHead(upstream.status, outHeaders)

        if (!upstream.body) {
          res.end()
          return
        }
        const reader = upstream.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) res.write(value)
        }
        res.end()
        return
      } catch (err) {
        clearTimeout(timer)
        const msg = String((err as Error)?.message ?? err)
        this.markFailure(provider.id, msg)
        lastError = `${provider.name}: ${msg}`
        this.log(`proxy failover from ${provider.name} (${msg})`)
      }
    }

    if (!res.headersSent) {
      res.writeHead(lastStatus, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: lastError } }))
    }
  }
}

/** Measures HTTP latency to every configured provider endpoint concurrently. */
export async function benchProviders(providers: readonly ProxyProvider[], timeoutMs = 5000): Promise<BenchResult[]> {
  const results = await Promise.all(
    providers.map(async (p): Promise<BenchResult> => {
      const start = Date.now()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetch(p.baseUrl, { method: 'HEAD', signal: controller.signal }).catch(() =>
          fetch(p.baseUrl, { method: 'GET', signal: controller.signal })
        )
        const latencyMs = Math.max(1, Date.now() - start)
        const band = latencyMs < 300 ? 'fast' : latencyMs <= 500 ? 'ok' : 'slow'
        return { id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, ok: true, latencyMs, band, status: res.status }
      } catch (err) {
        const latencyMs = Math.max(1, Date.now() - start)
        return {
          id: p.id,
          name: p.name,
          kind: p.kind,
          baseUrl: p.baseUrl,
          ok: false,
          latencyMs,
          band: 'error',
          error: String((err as Error)?.message ?? err).slice(0, 100)
        }
      } finally {
        clearTimeout(timer)
      }
    })
  )
  return results.sort((a, b) => Number(b.ok) - Number(a.ok) || a.latencyMs - b.latencyMs)
}
