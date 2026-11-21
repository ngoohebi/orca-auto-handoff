// Unix socket RPC client for `oahd`, with on-demand daemon auto-start and lifecycle helpers.
import { spawn } from 'node:child_process'
import { existsSync, openSync, closeSync, readFileSync, mkdirSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLineParser, encodeMessage, type WireMessage } from '../daemon/ipc.ts'
import { logPathFor, pidPathFor, resolveOahHome, socketPathFor } from '../daemon/store.ts'

export type DaemonPing = {
  version: string
  pid: number
  uptimeMs: number
  bridgeConnected: boolean
}

export class OahClient {
  readonly home: string
  readonly sockPath: string
  private seq = 0

  constructor(home: string = resolveOahHome(), sockPath?: string) {
    this.home = home
    this.sockPath = sockPath ?? socketPathFor(home)
  }

  /** Sends a single JSON-RPC request over a short-lived Unix socket connection. */
  call<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const id = `c${++this.seq}-${Math.random().toString(36).slice(2, 7)}`
    return new Promise<T>((resolvePromise, rejectPromise) => {
      let settled = false
      let sock: Socket | null = null
      const done = (err: Error | null, val?: T) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          sock?.end()
          sock?.destroy()
        } catch {
          // Ignore close errors.
        }
        if (err) rejectPromise(err)
        else resolvePromise(val as T)
      }
      const timer = setTimeout(() => done(new Error(`oahd timed out on ${method}`)), timeoutMs)
      try {
        sock = createConnection(this.sockPath)
      } catch (err) {
        done(err as Error)
        return
      }
      sock.setEncoding('utf8')
      const parse = createLineParser((msg: WireMessage) => {
        if (msg.type === 'res' && msg.id === id) {
          if (msg.ok) done(null, msg.result as T)
          else done(new Error(msg.error.message))
        }
      })
      sock.on('data', (chunk) => parse(chunk.toString('utf8')))
      sock.on('error', (err) => done(err))
      sock.on('close', () => {
        if (!settled) done(new Error(`oahd closed connection during ${method}`))
      })
      sock.on('connect', () => {
        sock!.write(encodeMessage({ type: 'req', id, method, params }))
      })
    })
  }

  async ping(timeoutMs = 1500): Promise<DaemonPing | null> {
    if (!existsSync(this.sockPath)) return null
    try {
      return await this.call<DaemonPing>('ping', {}, timeoutMs)
    } catch {
      return null
    }
  }

  /** Ensures `oahd` is running, spawning it detached on demand if needed. */
  async ensureDaemon(daemonEntry?: string): Promise<DaemonPing> {
    const existing = await this.ping()
    if (existing) return existing

    mkdirSync(this.home, { recursive: true, mode: 0o700 })
    const entry = daemonEntry ?? resolveDaemonEntry()
    const logFd = openSync(logPathFor(this.home), 'a', 0o600)
    try {
      const child = spawn(process.execPath, [entry], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, OAH_HOME: this.home }
      })
      child.unref()
    } finally {
      closeSync(logFd)
    }

    const deadline = Date.now() + 6000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 80))
      const up = await this.ping(500)
      if (up) return up
    }
    throw new Error(`oahd failed to start within 6s. Check ${logPathFor(this.home)}`)
  }

  async stopDaemon(): Promise<{ stopped: boolean; pid?: number }> {
    const info = await this.ping(1000)
    if (info) {
      await this.call('shutdown', {}, 3000).catch(() => undefined)
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 60))
        if (!(await this.ping(300))) return { stopped: true, pid: info.pid }
      }
      try {
        process.kill(info.pid, 'SIGTERM')
      } catch {
        // Already exited.
      }
      return { stopped: true, pid: info.pid }
    }
    const pidFile = pidPathFor(this.home)
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 'SIGTERM')
          return { stopped: true, pid }
        } catch {
          // Stale PID.
        }
      }
    }
    return { stopped: false }
  }
}

export function resolveDaemonEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', 'daemon', 'main.ts')
}
