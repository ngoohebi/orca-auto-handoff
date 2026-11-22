// Live fallback quota probes for `oahd` (strictly timeout-bounded, zero npm dependencies):
// 1. Codex: `codex app-server` JSON-RPC `account/rateLimits/read` per CODEX_HOME
//    (carries backend accountId, ordinaryUsageAllowed, and avoids the `codex_bengalfox` trap).
// 2. Claude: `claude -p "/usage" --output-format json` (live, $0 cost, 0 turns, active account).
// 3. OpenCode Go: `GET https://opencode.ai/zen/go/v1/usage` (rolling, weekly, monthly windows).
import { execFile, spawn } from 'node:child_process'
import type { SeatUsage, UsageWindow } from '../core/types.ts'

type Json = Record<string, any>

function toMs(ts: unknown): number | null {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    // Unix seconds vs milliseconds
    return ts < 1e12 ? Math.round(ts * 1000) : Math.round(ts)
  }
  if (typeof ts === 'string' && ts.trim()) {
    const parsed = Date.parse(ts)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function parseWindow(obj: unknown): UsageWindow | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const o = obj as Json
  const pct =
    typeof o.usedPercent === 'number'
      ? o.usedPercent
      : typeof o.used_percent === 'number'
        ? o.used_percent
        : typeof o.percent === 'number'
          ? o.percent
          : undefined
  if (pct === undefined || !Number.isFinite(pct)) return undefined
  return {
    usedPercent: Math.max(0, Math.min(100, pct)),
    resetsAt: toMs(o.resetsAt ?? o.resets_at ?? o.resetAt ?? o.reset_at)
  }
}

/** Parses a `codex app-server` `account/rateLimits/read` JSON-RPC response (or error). */
export function parseCodexRateLimits(
  rpcMessage: Json,
  now = Date.now()
): { accountId?: string; usage: SeatUsage } {
  if (rpcMessage?.error) {
    const code = rpcMessage.error.code
    const msg = String(rpcMessage.error.message ?? '')
    const isAuth = code === -32600 || /auth|sign.?in|login|credential/i.test(msg)
    return {
      usage: {
        known: false,
        source: 'unknown',
        reason: isAuth ? 'sign-in' : 'error',
        detail: msg.slice(0, 120)
      }
    }
  }
  const res: Json = rpcMessage?.result ?? rpcMessage ?? {}
  const accountId = typeof res.accountId === 'string' && res.accountId.trim() ? res.accountId.trim() : undefined
  const byId: Json = res.rateLimitsByLimitId && typeof res.rateLimitsByLimitId === 'object' ? res.rateLimitsByLimitId : {}
  // Prefer the main `codex` bucket, never `codex_bengalfox` (Spark tier).
  const mainBucket: Json = byId.codex ?? res.rateLimits ?? {}
  const primary = parseWindow(mainBucket.primary)
  const secondary = parseWindow(mainBucket.secondary)
  const ordinaryUsageAllowed = typeof res.ordinaryUsageAllowed === 'boolean' ? res.ordinaryUsageAllowed : undefined
  const rateLimitReachedType = typeof res.rateLimitReachedType === 'string' ? res.rateLimitReachedType : undefined

  // Map primary/secondary by windowDurationMins (<= 1440m -> session, > 1440m -> weekly).
  let session: UsageWindow | undefined
  let weekly: UsageWindow | undefined
  const durOf = (w: Json | undefined) => Number(w?.windowDurationMins ?? w?.window_minutes ?? 0)
  if (primary) {
    if (durOf(mainBucket.primary) > 1440) weekly = primary
    else session = primary
  }
  if (secondary) {
    if (durOf(mainBucket.secondary) > 1440) weekly = secondary
    else if (!session) session = secondary
  }

  const known = !!(session || weekly) || ordinaryUsageAllowed === false
  return {
    accountId,
    usage: {
      known,
      source: known ? 'live' : 'unknown',
      asOf: now,
      updatedAt: now,
      ...(session ? { session } : {}),
      ...(weekly ? { weekly } : {}),
      ...(ordinaryUsageAllowed !== undefined ? { ordinaryUsageAllowed } : {}),
      ...(rateLimitReachedType ? { rateLimitReachedType } : {}),
      ...(!known ? { reason: 'not-reported' as const } : {})
    }
  }
}

/** Spawns `codex app-server` isolated to `codexHome` and queries `account/rateLimits/read`. */
export function probeCodexAppServer(
  codexHome: string,
  opts: { codexBin?: string; timeoutMs?: number; now?: () => number } = {}
): Promise<{ accountId?: string; usage: SeatUsage }> {
  const timeoutMs = opts.timeoutMs ?? 6000
  const bin = opts.codexBin ?? 'codex'
  const now = opts.now ?? (() => Date.now())

  return new Promise((resolve) => {
    let settled = false
    let buf = ''
    let child: any
    const finish = (val: { accountId?: string; usage: SeatUsage }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child?.kill?.('SIGTERM')
      } catch {
        // Ignore.
      }
      resolve(val)
    }
    const timer = setTimeout(
      () => finish({ usage: { known: false, source: 'unknown', reason: 'error', detail: 'codex app-server timed out' } }),
      timeoutMs
    )

    try {
      child = spawn(bin, ['app-server'], {
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ['pipe', 'pipe', 'ignore']
      })
    } catch (err) {
      finish({ usage: { known: false, source: 'unknown', reason: 'error', detail: String((err as Error)?.message ?? err) } })
      return
    }

    child.on('error', (err: Error) => {
      finish({ usage: { known: false, source: 'unknown', reason: 'error', detail: err.message } })
    })
    child.on('close', () => {
      if (!settled) finish({ usage: { known: false, source: 'unknown', reason: 'error', detail: 'codex app-server exited' } })
    })

    child.stdout?.on('data', (chunk: { toString(enc?: string): string }) => {
      buf += chunk.toString('utf8')
      let idx = buf.indexOf('\n')
      while (idx >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (line) {
          try {
            const msg = JSON.parse(line) as Json
            if (msg.id === 1) {
              child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: null })}\n`)
            } else if (msg.id === 2) {
              finish(parseCodexRateLimits(msg, now()))
              return
            }
          } catch {
            // Ignore non-JSON preamble.
          }
        }
        idx = buf.indexOf('\n')
      }
    })

    try {
      child.stdin?.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'oah', version: '0.5.0' } } })}\n`
      )
    } catch (err) {
      finish({ usage: { known: false, source: 'unknown', reason: 'error', detail: String((err as Error)?.message ?? err) } })
    }
  })
}

/** Parses `claude -p "/usage" --output-format json` stdout into a `SeatUsage`. */
export function parseClaudeUsageJson(stdout: string, now = Date.now()): SeatUsage {
  try {
    const parsed = JSON.parse(stdout) as Json
    const text = typeof parsed?.result === 'string' ? parsed.result : typeof parsed === 'string' ? parsed : stdout
    // Parse structured JSON fields if present, otherwise extract percentages from `/usage` output.
    const session = parseWindow(parsed?.session ?? parsed?.five_hour)
    const weekly = parseWindow(parsed?.weekly ?? parsed?.seven_day)
    if (session || weekly) {
      return { known: true, source: 'live', asOf: now, updatedAt: now, ...(session ? { session } : {}), ...(weekly ? { weekly } : {}) }
    }
    const fiveMatch = text.match(/(?:5[- ]?hour|session)[^\n%]{0,40}?(\d{1,3}(?:\.\d+)?)\s*%/i)
    const weekMatch = text.match(/(?:7[- ]?day|all models|weekly)[^\n%]{0,40}?(\d{1,3}(?:\.\d+)?)\s*%/i)
    const modelMatch = text.match(/\b(fable|opus|sonnet)\b[^\n%]{0,40}?(\d{1,3}(?:\.\d+)?)\s*%/i)
    const s = fiveMatch ? { usedPercent: Math.min(100, Number(fiveMatch[1])), resetsAt: null } : undefined
    const w = weekMatch ? { usedPercent: Math.min(100, Number(weekMatch[1])), resetsAt: null } : undefined
    const m = modelMatch ? { name: modelMatch[1]!.toLowerCase(), usedPercent: Math.min(100, Number(modelMatch[2])), resetsAt: null } : undefined
    const known = !!(s || w)
    return {
      known,
      source: known ? 'live' : 'unknown',
      asOf: now,
      updatedAt: now,
      ...(s ? { session: s } : {}),
      ...(w ? { weekly: w } : {}),
      ...(m ? { model: m } : {}),
      ...(!known ? { reason: 'not-reported' as const } : {})
    }
  } catch {
    return { known: false, source: 'unknown', reason: 'error', detail: 'Could not parse claude /usage output' }
  }
}

/** Runs `claude -p "/usage" --output-format json` ($0 cost, 0 turns) for the active Claude account. */
export function probeClaudeUsage(opts: { claudeBin?: string; timeoutMs?: number; now?: () => number } = {}): Promise<SeatUsage> {
  const bin = opts.claudeBin ?? 'claude'
  const timeout = opts.timeoutMs ?? 8000
  const now = opts.now ?? (() => Date.now())
  return new Promise((resolve) => {
    execFile(bin, ['-p', '/usage', '--output-format', 'json'], { timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve({ known: false, source: 'unknown', reason: 'error', detail: err.message.slice(0, 120) })
        return
      }
      resolve(parseClaudeUsageJson(stdout.toString(), now()))
    })
  })
}

/** Parses `GET https://opencode.ai/zen/go/v1/usage` JSON into a `SeatUsage`. */
export function parseOpenCodeUsage(payload: Json, now = Date.now()): SeatUsage {
  const session = parseWindow(payload?.rolling ?? payload?.session)
  const weekly = parseWindow(payload?.weekly)
  const monthly = parseWindow(payload?.monthly)
  const effectiveWeekly = weekly ?? monthly
  const known = !!(session || effectiveWeekly)
  return {
    known,
    source: known ? 'live' : 'unknown',
    asOf: now,
    updatedAt: now,
    ...(session ? { session } : {}),
    ...(effectiveWeekly ? { weekly: effectiveWeekly } : {}),
    ...(!known ? { reason: 'not-reported' as const } : {})
  }
}

/** Probes OpenCode Go usage endpoint via built-in `fetch`. */
export async function probeOpenCodeGo(
  url = 'https://opencode.ai/zen/go/v1/usage',
  opts: { authHeader?: string; timeoutMs?: number; now?: () => number } = {}
): Promise<SeatUsage> {
  const now = opts.now ?? (() => Date.now())
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000)
  try {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (opts.authHeader) headers.authorization = opts.authHeader
    const res = await fetch(url, { headers, signal: controller.signal })
    if (res.status === 401 || res.status === 403) {
      return { known: false, source: 'unknown', reason: 'sign-in', detail: `HTTP ${res.status}` }
    }
    if (!res.ok) {
      return { known: false, source: 'unknown', reason: 'error', detail: `HTTP ${res.status}` }
    }
    const data = (await res.json()) as Json
    return parseOpenCodeUsage(data, now())
  } catch (err) {
    return { known: false, source: 'unknown', reason: 'error', detail: String((err as Error)?.message ?? err).slice(0, 120) }
  } finally {
    clearTimeout(timer)
  }
}
