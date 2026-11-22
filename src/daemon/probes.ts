// Live fallback quota probes for `oahd` (strictly timeout-bounded, zero npm dependencies):
// 1. Codex: `codex app-server` JSON-RPC `account/rateLimits/read` per CODEX_HOME
//    (carries backend accountId, ordinaryUsageAllowed, and avoids the `codex_bengalfox` trap).
// 2. Claude: `claude -p "/usage" --output-format json` (live, $0 cost, 0 turns, active account).
// 3. OpenCode Go: `GET https://opencode.ai/zen/go/v1/usage` (rolling, weekly, monthly windows).
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Seat, SeatUsage, UsageWindow } from '../core/types.ts'

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
    const rateLimited = code === 429 || /\b429\b|rate[- ]limit(?:ed| exceeded| reached)|too many requests/i.test(msg)
    const isAuth = code === -32600 || /auth|sign.?in|login|credential/i.test(msg)
    return {
      usage: {
        known: false,
        source: 'unknown',
        reason: rateLimited ? 'rate-limited' : isAuth ? 'sign-in' : 'error',
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
    child.stdin?.on('error', () => finish({ usage: { known: false, source: 'unknown', reason: 'error' } }))

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

const PROFILE_QUOTA_MAX_AGE = 10 * 60_000
const PROFILE_QUOTA_RETRY = 60_000
const CLAUDE_QUOTA_INTERVAL = 15 * 60_000

function readKeychainSecret(service: string, account?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['find-generic-password', '-s', service, ...(account ? ['-a', account] : []), '-w']
    execFile('/usr/bin/security', args, { timeout: 3000, maxBuffer: 64 * 1024 },
      (error, stdout) => error ? reject(error) : resolve(stdout.trim()))
  })
}

export function parseClaudeOAuthQuota(payload: Json, now: number): SeatUsage {
  const window = (value: Json | null | undefined) => parseWindow({ percent: value?.utilization, resets_at: value?.resets_at })
  const session = window(payload.five_hour)
  const weekly = window(payload.seven_day)
  let model: SeatUsage['model']
  for (const name of ['opus', 'sonnet', 'fable']) {
    const usage = window(payload[`seven_day_${name}`])
    if (usage && (!model || usage.usedPercent > model.usedPercent)) model = { ...usage, name }
  }
  return {
    known: !!(session || weekly || model),
    updatedAt: now,
    ...(session ? { session } : {}),
    ...(weekly ? { weekly } : {}),
    ...(model ? { model } : {})
  }
}

async function claudeProfileCredential(home: string): Promise<{ token: string; expiresAt?: number } | undefined> {
  try {
    const raw = process.platform === 'darwin'
      ? await readKeychainSecret(`Claude Code-credentials-${createHash('sha256').update(home).digest('hex').slice(0, 8)}`)
      : readFileSync(join(home, '.credentials.json'), 'utf8')
    const credentials = JSON.parse(raw).claudeAiOauth
    const token = credentials?.accessToken
    if (typeof token !== 'string' || !token) return undefined
    const expiresAt = toMs(credentials.expiresAt)
    return expiresAt === null ? { token } : { token, expiresAt }
  } catch {
    return undefined
  }
}

function retryAfter(response: Response, now: number): number {
  const value = response.headers.get('retry-after')
  const retryAt = value && Number.isFinite(Number(value)) ? now + Number(value) * 1000 : Date.parse(value ?? '')
  return Number.isFinite(retryAt) ? retryAt : 0
}

/** Asks one saved Claude account for its usage with its saved sign-in, after checking the sign-in
 *  is that account's (email and organization). An expired sign-in is not renewed here: `renew`
 *  runs Claude Code's own `/usage` for the account, which renews it the way Claude Code always
 *  does, and the check goes on with the renewed sign-in (or that `/usage` reading). */
async function probeClaudeProfile(home: string, email: string, org: string, now: () => number, renew?: () => Promise<SeatUsage>): Promise<SeatUsage> {
  let credential = await claudeProfileCredential(home)
  if (!credential) return { known: false, reason: 'sign-in' }
  const expired = (c: { expiresAt?: number }) => c.expiresAt !== undefined && c.expiresAt <= now()
  if (expired(credential)) {
    if (!renew) return { known: false, reason: 'stale-token' }
    const reading = await renew()
    const again = await claudeProfileCredential(home)
    if (!again || expired(again)) {
      return reading.known ? { ...reading, source: 'live', origin: 'claude-profile' } : { known: false, reason: 'stale-token' }
    }
    credential = again
  }
  try {
    const signal = AbortSignal.timeout(6000)
    for (const endpoint of ['profile', 'usage']) {
      const response = await fetch(`https://api.anthropic.com/api/oauth/${endpoint}`, {
        headers: { Authorization: `Bearer ${credential.token}`, 'anthropic-beta': 'oauth-2025-04-20' },
        redirect: 'error',
        signal
      })
      if (response.status === 429) {
        return { known: false, reason: 'rate-limited', retryAt: retryAfter(response, now()) }
      }
      if (!response.ok) return { known: false, reason: response.status === 401 || response.status === 403 ? 'sign-in' : 'error' }
      const result = await response.json() as Json
      if (endpoint === 'usage') return parseClaudeOAuthQuota(result, now())
      if (result.account?.email?.toLowerCase() !== email.toLowerCase() || result.organization?.uuid !== org) {
        return { known: false, reason: 'sign-in' }
      }
    }
  } catch {
    return { known: false, reason: 'error' }
  }
  return { known: false, reason: 'not-reported' }
}

export function parseAntigravityQuota(payload: Json, now: number): SeatUsage {
  const buckets = new Map<string, UsageWindow>()
  for (const group of Array.isArray(payload?.groups) ? payload.groups : []) {
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      const remaining = bucket?.remainingFraction
      if (typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0 || remaining > 1) continue
      buckets.set(bucket.bucketId, { usedPercent: Math.round((1 - remaining) * 10_000) / 100, resetsAt: toMs(bucket.resetTime) })
    }
  }
  const session = buckets.get('gemini-5h') ?? buckets.get('3p-5h')
  const weekly = buckets.get('gemini-weekly') ?? buckets.get('3p-weekly')
  const sharedPaidModels = buckets.get('3p-weekly')
  const model = weekly !== sharedPaidModels && sharedPaidModels ? { ...sharedPaidModels, name: 'Claude and GPT weekly' } : undefined
  return {
    known: !!(session || weekly),
    source: 'live',
    origin: 'antigravity-profile',
    updatedAt: now,
    ...(session ? { session } : {}),
    ...(weekly ? { weekly } : {}),
    ...(model ? { model } : {})
  }
}

type QuotaBackoff = { get(seatKey: string): number; record(seatKey: string, retryAt: number): void }

/** The native agy sign-in can differ from Orca's selected profile. Bind using Google's subject. */
function antigravityNativeQuota(now: () => number, backoff: QuotaBackoff) {
  const nextCheck = new Map<string, number>()
  const issues = new Map<string, NonNullable<Seat['directQuotaIssue']>>()
  let last: { subject: string; usage: SeatUsage } | undefined
  return async (accountBlock: Json | undefined, seats: Seat[]): Promise<void> => {
    const rows = accountBlock?.accounts
    const linked = seats.filter((seat) => seat.provider === 'antigravity')
    if (process.platform !== 'darwin' || !Array.isArray(rows)) {
      for (const seat of linked) seat.directQuotaIssue = { reason: 'no-usage-api', retryAt: 0 }
      return
    }
    const profiles = rows.filter((profile) => linked.some((seat) => seat.accountId === profile?.id))
    const nativeSubject = accountBlock?.currentAccount?.subject
    const matches = profiles.filter((profile) => typeof nativeSubject === 'string' && profile?.subject === nativeSubject)
    for (const seat of linked) {
      if (matches.length !== 1 || matches[0].id !== seat.accountId) {
        seat.directQuotaIssue = { reason: 'native-sign-in-required', retryAt: 0 }
      }
    }
    if (matches.length !== 1) return
    const seat = linked.find((row) => row.accountId === matches[0].id)
    if (!seat) return
    const blockedUntil = backoff.get(seat.key)
    const issue = issues.get(seat.key)
    if (issue) seat.directQuotaIssue = issue
    if (blockedUntil > now()) seat.directQuotaIssue = { reason: 'rate-limited', retryAt: blockedUntil }
    const recordIssue = (reason: NonNullable<Seat['directQuotaIssue']>['reason'], retryAt = nextCheck.get(seat.key) ?? 0) => {
      const issue = { reason, retryAt }
      issues.set(seat.key, issue)
      seat.directQuotaIssue = issue
    }
    const recordFailure = (response: Response) => {
      if (response.status === 429) {
        const at = now()
        const retryAt = Math.max(at + PROFILE_QUOTA_MAX_AGE, retryAfter(response, at))
        backoff.record(seat.key, retryAt)
        recordIssue('rate-limited', retryAt)
      } else {
        recordIssue(response.status === 401 || response.status === 403 ? 'sign-in' : 'error')
      }
    }
    if (now() >= Math.max(blockedUntil, nextCheck.get(seat.key) ?? 0)) {
      nextCheck.set(seat.key, now() + PROFILE_QUOTA_MAX_AGE)
      try {
        const secret = await readKeychainSecret('gemini', 'antigravity')
        const prefix = 'go-keyring-base64:'
        const raw = secret.startsWith(prefix) ? Buffer.from(secret.slice(prefix.length), 'base64').toString('utf8') : secret
        const accessToken = JSON.parse(raw).token?.access_token
        if (typeof accessToken !== 'string' || !accessToken) {
          recordIssue('sign-in')
          return
        }
        const signal = AbortSignal.timeout(6000)
        const headers = { Authorization: `Bearer ${accessToken}` }
        const identity = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers, signal, redirect: 'error' })
        if (!identity.ok) {
          recordFailure(identity)
          return
        }
        const { sub } = await identity.json() as Json
        if (sub !== nativeSubject) {
          recordIssue('native-sign-in-required')
          return
        }
        const version = accountBlock?.chatAgyVersion
        const response = await fetch('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json', ...(typeof version === 'string' && /^[\d.]+$/.test(version)
            ? { 'User-Agent': `antigravity/cli/${version}` } : {}) },
          body: '{}',
          signal,
          redirect: 'error'
        })
        if (!response.ok) {
          recordFailure(response)
          return
        }
        const usage = parseAntigravityQuota(await response.json() as Json, now())
        if (usage.known) {
          last = { subject: sub, usage }
          issues.delete(seat.key)
          delete seat.directQuotaIssue
        } else {
          recordIssue('not-reported')
        }
      } catch {
        recordIssue('error')
        return
      }
    }
    if (last?.subject === nativeSubject && last && now() - (last.usage.updatedAt ?? 0) < PROFILE_QUOTA_MAX_AGE) {
      seat.usage = last.usage
    }
  }
}

function managedDataHome(provider: 'opencode' | 'devin', id: string): string | undefined {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return undefined
  const configured = process.env.ORCA_USER_DATA
  const root = configured && isAbsolute(configured)
    ? configured
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'Orca')
      : undefined
  return root ? join(root, 'managed-data-accounts', provider, id.toLowerCase(), 'data', provider) : undefined
}

async function probeOpenCodeProfile(database: string, now: () => number): Promise<SeatUsage> {
  let rows: { value?: unknown }[]
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(database, { readOnly: true })
    try {
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=250')
      rows = db.prepare("SELECT value FROM credential WHERE integration_id = 'opencode-go' LIMIT 2").all()
    } finally {
      db.close()
    }
  } catch {
    return { known: false, reason: 'error' }
  }
  try {
    if (rows.length !== 1 || typeof rows[0]?.value !== 'string') return { known: false, reason: 'sign-in' }
    const entry = JSON.parse(rows[0].value)
    if ((entry.type === 'key' || entry.type === 'api') && typeof entry.key === 'string' && entry.key.trim()) {
      return probeOpenCodeGo(undefined, { authHeader: `Bearer ${entry.key}`, now })
    }
  } catch {
    // A missing or ambiguous stored key can't be used for this profile.
  }
  return { known: false, reason: 'sign-in' }
}

export function parseDevinQuota(payload: Json, now: number): SeatUsage {
  const status = payload?.userStatus?.planStatus
  const window = (name: 'daily' | 'weekly'): UsageWindow | undefined => {
    const rawReset: unknown = status?.[`${name}QuotaResetAtUnix`]
    const timestamp = typeof rawReset === 'string' && /^\d+$/.test(rawReset) ? Number(rawReset) : rawReset
    const resetsAt = typeof timestamp === 'number' && timestamp > 0 ? toMs(timestamp) : null
    const rawRemaining: unknown = status?.[`${name}QuotaRemainingPercent`]
    const remaining = rawRemaining === undefined && resetsAt !== null ? 0 : rawRemaining
    if (typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0 || remaining > 100) return undefined
    return { usedPercent: 100 - remaining, resetsAt }
  }
  const session = window('daily')
  const weekly = window('weekly')
  return { known: !!(session || weekly), updatedAt: now, session, weekly }
}

/** Read only the two top-level strings written by the managed Devin login. */
function devinCredentials(file: string): { apiKey: string } | undefined {
  const values = new Map<string, string>()
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break
    const match = /^\s*(windsurf_api_key|api_server_url)\s*=\s*(?:"([^"\\\r\n]+)"|'([^'\r\n]+)')\s*(?:#.*)?$/.exec(line)
    if (!match) continue
    const [, field, basic, literal] = match
    if (!field || values.has(field)) return undefined
    values.set(field, basic ?? literal ?? '')
  }
  const apiKey = values.get('windsurf_api_key')
  const server = values.get('api_server_url')
  if (!apiKey || (server && !/^https:\/\/server\.codeium\.com\/?$/.test(server))) return undefined
  return { apiKey }
}

async function probeDevinProfile(file: string, now: () => number): Promise<SeatUsage> {
  try {
    const credentials = devinCredentials(file)
    if (!credentials) return { known: false, reason: 'sign-in' }
    const version = await new Promise<string>((resolve) => {
      execFile('devin', ['version'], { timeout: 2000, maxBuffer: 16 * 1024 },
        (error, stdout) => resolve((!error && stdout.match(/\b\d+(?:\.\d+){2,}\b/)?.[0]) || '3000.11.205'))
    })
    const response = await fetch('https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
      body: JSON.stringify({ metadata: { apiKey: credentials.apiKey, ideName: 'devin', ideVersion: version, extensionVersion: version, locale: 'en' } }),
      signal: AbortSignal.timeout(6000),
      redirect: 'error'
    })
    if (response.status === 429) return { known: false, reason: 'rate-limited', retryAt: retryAfter(response, now()) }
    if (!response.ok) return { known: false, reason: response.status === 401 || response.status === 403 ? 'sign-in' : 'error' }
    return parseDevinQuota(await response.json() as Json, now())
  } catch {
    return { known: false, reason: 'error' }
  }
}

/** Parses ChatGPT's `GET /backend-api/wham/usage` (what Codex itself shows) into a `SeatUsage`:
 *  `rate_limit.primary_window` and `secondary_window`, each with `used_percent`, `reset_at`
 *  (epoch seconds) or `reset_after_seconds`, and `limit_window_seconds`; a window of a week or
 *  more is the weekly one, a shorter one the session. */
export function parseCodexUsage(payload: Json, now: number): SeatUsage {
  const usage: SeatUsage = { known: false, source: 'live', origin: 'codex-profile', updatedAt: now, asOf: now }
  const rateLimit = payload?.rate_limit
  for (const raw of [rateLimit?.primary_window, rateLimit?.secondary_window]) {
    const used = raw?.used_percent
    if (typeof used !== 'number' || !Number.isFinite(used)) continue
    const resetsAt = typeof raw.reset_at === 'number' && raw.reset_at > 0
      ? raw.reset_at * 1000
      : typeof raw.reset_after_seconds === 'number' && raw.reset_after_seconds >= 0 ? now + raw.reset_after_seconds * 1000 : null
    const window = { usedPercent: Math.min(100, Math.max(0, used)), resetsAt }
    const weekly = typeof raw.limit_window_seconds === 'number' && raw.limit_window_seconds >= 6.5 * 86_400
    if (weekly) usage.weekly = window
    else usage.session = window
  }
  if (rateLimit?.allowed === false || rateLimit?.limit_reached === true) usage.ordinaryUsageAllowed = false
  usage.known = !!(usage.session || usage.weekly) || usage.ordinaryUsageAllowed === false
  if (!usage.known) usage.reason = 'not-reported'
  return usage
}

/** When a JWT expires (its `exp`, in ms), when it says. */
function jwtExpiry(token: string): number | undefined {
  try {
    const exp = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))?.exp
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/** Asks ChatGPT for one saved Codex profile's usage with the sign-in saved in its home
 *  (`auth.json`), and never renews it: an expired access token is said as such and left for
 *  Codex to renew when it next runs, so this check can never race a running Codex session over
 *  the same rotating refresh token. `accountId` is the account the sign-in belongs to. */
async function probeCodexProfile(home: string, now: () => number): Promise<{ accountId?: string; usage: SeatUsage }> {
  let token: string | undefined
  let accountId: string | undefined
  try {
    const tokens = JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8'))?.tokens
    token = typeof tokens?.access_token === 'string' && tokens.access_token ? tokens.access_token : undefined
    accountId = typeof tokens?.account_id === 'string' && tokens.account_id ? tokens.account_id : undefined
  } catch {
    // No saved sign-in to read.
  }
  if (!token) return { usage: { known: false, reason: 'sign-in' } }
  const expiresAt = jwtExpiry(token)
  if (expiresAt !== undefined && expiresAt <= now()) return { ...(accountId ? { accountId } : {}), usage: { known: false, reason: 'stale-token' } }
  try {
    const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      headers: { Authorization: `Bearer ${token}`, ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}), Accept: 'application/json', 'User-Agent': 'codex-cli' },
      signal: AbortSignal.timeout(6000),
      redirect: 'error'
    })
    if (response.status === 429) return { ...(accountId ? { accountId } : {}), usage: { known: false, reason: 'rate-limited', retryAt: retryAfter(response, now()) } }
    if (!response.ok) return { ...(accountId ? { accountId } : {}), usage: { known: false, reason: response.status === 401 || response.status === 403 ? 'stale-token' : 'error' } }
    return { ...(accountId ? { accountId } : {}), usage: parseCodexUsage(await response.json() as Json, now()) }
  } catch {
    return { ...(accountId ? { accountId } : {}), usage: { known: false, reason: 'error' } }
  }
}

/** Services whose saved Orca profiles can be asked for usage with the profile's own sign-in. */
const PROFILE_PROVIDERS = new Set<Seat['provider']>(['claude', 'codex', 'opencode', 'devin'])

type ProfileTarget = { profile: Json; expectedId: string; home: string; claude: boolean; opencode: boolean; devin: boolean; dataProfile: boolean }

const SERVICE_NAME: Record<Seat['provider'], string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', opencode: 'OpenCode', devin: 'Devin' }

/** What a direct check of one saved profile needs (its Orca profile, the account id it must answer
 *  for, and its home on disk), or why this profile cannot be checked directly, in a few words. */
function profileTarget(accounts: Json, seat: Seat): ProfileTarget | { why: string } {
  const claude = seat.provider === 'claude'
  const opencode = seat.provider === 'opencode'
  const devin = seat.provider === 'devin'
  const dataProfile = opencode || devin
  if (!PROFILE_PROVIDERS.has(seat.provider)) return { why: `${SERVICE_NAME[seat.provider]} offers no direct check` }
  if (seat.accountId === 'system') return { why: "the agent's own login" }
  const profiles = accounts?.[seat.provider]?.accounts
  const profile = Array.isArray(profiles) ? profiles.find((row: Json | null) => row?.id === seat.accountId) : undefined
  if (!profile) return { why: 'not saved in Orca' }
  if (!dataProfile && (claude ? profile.managedAuthRuntime : profile.managedHomeRuntime) !== 'host') return { why: 'its sign-in is not kept on this computer' }
  if (claude && (typeof profile.email !== 'string' || !profile.email)) return { why: 'Orca has no email for it' }
  if (opencode && (!Array.isArray(profile.integrations) || !profile.integrations.includes('opencode-go'))) return { why: 'OpenCode Go not set up' }
  const expectedId = claude ? profile.organizationUuid : dataProfile ? seat.accountId : profile.workspaceAccountId || profile.providerAccountId
  if (typeof expectedId !== 'string' || !expectedId.trim()) return { why: 'Orca has no account ID for it' }
  const dataHome = dataProfile ? managedDataHome(opencode ? 'opencode' : 'devin', seat.accountId) : undefined
  const home = dataProfile ? (dataHome ? join(dataHome, opencode ? 'opencode.db' : 'credentials.toml') : undefined)
    : typeof profile.home === 'string' && isAbsolute(profile.home)
    ? profile.home
    : !claude && process.platform === 'darwin' && /^[a-z0-9_-]+$/i.test(seat.accountId)
      ? join(homedir(), 'Library', 'Application Support', 'Orca', 'codex-accounts', seat.accountId, 'home')
      : undefined
  if (!home || !existsSync(home)) return { why: 'no saved sign-in on this computer' }
  return { profile, expectedId, home, claude, opencode, devin, dataProfile }
}

/** Why a direct check cannot work for this saved account right now, or undefined when it can: the
 *  same conditions the check itself uses, so an account turned on automatically never only shows
 *  "not available". Antigravity only for the account signed in to Antigravity on this Mac (its
 *  check reads the native sign-in). */
export function directQuotaUnavailable(accounts: Json, seat: Seat): string | undefined {
  if (seat.accountId === 'system') return "the agent's own login"
  if (seat.provider === 'antigravity') {
    if (process.platform !== 'darwin') return 'only on macOS'
    const block = accounts?.antigravity
    const subject = block?.currentAccount?.subject
    const matches = Array.isArray(block?.accounts) && typeof subject === 'string' ? block.accounts.filter((row: Json | null) => row?.subject === subject) : []
    return matches.length === 1 && matches[0].id === seat.accountId ? undefined : 'not the account signed in to Antigravity'
  }
  const target = profileTarget(accounts, seat)
  return 'why' in target ? target.why : undefined
}

/** Check native profiles without changing Orca's active selection. */
export function managedProfileQuota(now: () => number, persisted: {
  load(): Record<string, number>
  save(retries: Record<string, number>): void
} = { load: () => ({}), save: () => {} }) {
  const readings = new Map<string, { retryAt: number; checkedAt: number; usage?: SeatUsage; issue?: Seat['directQuotaIssue'] }>()
  const retries = new Map(Object.entries(persisted.load()).filter(([, retryAt]) => Number.isFinite(retryAt) && retryAt > now()))
  const backoff: QuotaBackoff = {
    get: (key) => retries.get(key) ?? 0,
    record: (key, retryAt) => {
      for (const [id, until] of retries) if (until <= now()) retries.delete(id)
      retries.set(key, Math.max(retryAt, retries.get(key) ?? 0))
      try { persisted.save(Object.fromEntries(retries)) } catch { /* Keep the in-memory backoff. */ }
    }
  }
  const nativeAntigravity = antigravityNativeQuota(now, backoff)
  // Claude Code's own `/usage` for an account whose saved sign-in expired: at most once per
  // check interval per account, since it starts Claude Code.
  const renewedAt = new Map<string, number>()
  const renewClaude = (home: string) => async (): Promise<SeatUsage> => {
    if (now() - (renewedAt.get(home) ?? 0) < CLAUDE_QUOTA_INTERVAL) return { known: false, reason: 'stale-token' }
    renewedAt.set(home, now())
    return probeClaudeUsage({ configDir: home, timeoutMs: 30_000, now })
  }
  return async (accounts: Json, seats: Seat[], force: boolean): Promise<void> => {
    const attemptedAt = now()
    const pending: (() => Promise<void>)[] = []
    const managedIds = new Set<string>()
    for (const seat of seats) {
      if (!PROFILE_PROVIDERS.has(seat.provider) || seat.accountId === 'system') continue
      seat.directQuotaIssue = { reason: 'no-usage-api', retryAt: 0 }
      const target = profileTarget(accounts, seat)
      if ('why' in target) continue
      const { profile, expectedId, home, claude, opencode, devin, dataProfile } = target
      delete seat.directQuotaIssue
      const key = JSON.stringify([seat.key, expectedId, home, claude ? profile.email : null])
      managedIds.add(key)
      const prev = readings.get(key)
      const usage = prev?.usage
      if (prev?.issue) seat.directQuotaIssue = prev.issue
      const directAt = usage?.updatedAt ?? 0
      const interval = claude ? CLAUDE_QUOTA_INTERVAL : PROFILE_QUOTA_MAX_AGE
      const recentDirect = !!usage && attemptedAt - directAt < interval
      // An earlier direct reading stands in only when Orca has nothing newer.
      if (usage && recentDirect && (!seat.usage.known || (usage.updatedAt ?? 0) >= (seat.usage.updatedAt ?? 0))) seat.usage = usage
      const blockedUntil = backoff.get(seat.key)
      if (blockedUntil > attemptedAt) {
        seat.directQuotaIssue = { reason: 'rate-limited', retryAt: blockedUntil }
        continue
      }
      const authFailure = prev?.issue?.reason === 'sign-in' || prev?.issue?.reason === 'stale-token'
      const authenticatedAt = toMs(profile.lastAuthenticatedAt)
      const canRetrySignIn = !!prev && authFailure && (
        (authenticatedAt !== null && authenticatedAt > prev.checkedAt) ||
        (force && attemptedAt - prev.checkedAt >= PROFILE_QUOTA_RETRY)
      )
      // A manual refresh asks again at once, except Claude: its usage endpoint locks an account out
      // for an hour when asked more often than every 15 minutes, so it keeps its pace.
      const forced = force && !claude
      if (!force && recentDirect && !canRetrySignIn) continue
      if (prev && attemptedAt < prev.retryAt && !canRetrySignIn && !forced) continue
      pending.push(async () => {
        const result = claude
          ? { accountId: expectedId, usage: await probeClaudeProfile(home, profile.email, expectedId, now, renewClaude(home)) }
          : opencode
            ? { accountId: expectedId, usage: await probeOpenCodeProfile(home, now) }
            : devin
              ? { accountId: expectedId, usage: await probeDevinProfile(home, now) }
              : await probeCodexProfile(home, now)
        // What went wrong, if anything, decided first: a sign-in for another account is a sign-in
        // problem (it does not go away in a minute), whatever the numbers said.
        const mismatch = result.accountId !== undefined && result.accountId !== expectedId
        const reason = mismatch ? (result.usage.known ? 'sign-in' : (result.usage.reason ?? 'sign-in')) : result.usage.known ? undefined : (result.usage.reason ?? 'not-reported')
        const delay = claude || dataProfile || reason === 'rate-limited' || reason === 'sign-in' || reason === 'stale-token'
          ? interval
          : PROFILE_QUOTA_RETRY
        const checkedAt = now()
        const retryAt = Math.max(checkedAt + delay, result.usage.retryAt ?? 0)
        if (reason === 'rate-limited') backoff.record(seat.key, retryAt)
        if (reason) {
          const issue = { reason, retryAt }
          readings.set(key, { retryAt, checkedAt, usage, issue })
          seat.directQuotaIssue = issue
          return
        }
        const origin = claude ? 'claude-profile' : opencode ? 'opencode-profile' : devin ? 'devin-profile' : 'codex-profile'
        const verified: SeatUsage = { ...result.usage, source: 'live', origin }
        readings.set(key, { retryAt, checkedAt, usage: verified })
        delete seat.directQuotaIssue
        seat.usage = verified
      })
    }
    for (const [key, reading] of readings) {
      if (!managedIds.has(key) && reading.retryAt <= attemptedAt) readings.delete(key)
    }
    if (seats.some((seat) => seat.provider === 'antigravity')) pending.push(() => nativeAntigravity(accounts.antigravity, seats))
    for (let start = 0; start < pending.length; start += 3) {
      await Promise.all(pending.slice(start, start + 3).map((probe) => probe()))
    }
  }
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

/** Runs `claude -p "/usage" --output-format json` ($0 cost, 0 turns): for the active Claude
 *  account, or with `configDir` for one saved account (its `CLAUDE_CONFIG_DIR`). Claude Code renews
 *  that account's expired sign-in itself on the way, so nothing but Claude Code writes it. */
export function probeClaudeUsage(opts: { claudeBin?: string; timeoutMs?: number; now?: () => number; configDir?: string } = {}): Promise<SeatUsage> {
  const bin = opts.claudeBin ?? 'claude'
  const timeout = opts.timeoutMs ?? 8000
  const now = opts.now ?? (() => Date.now())
  // Never a token from the environment: the account is the config folder's.
  const { CLAUDE_CODE_OAUTH_TOKEN: _token, ...env } = process.env
  const options = { timeout, maxBuffer: 2 * 1024 * 1024, ...(opts.configDir ? { env: { ...env, CLAUDE_CONFIG_DIR: opts.configDir } } : {}) }
  return new Promise((resolve) => {
    execFile(bin, ['-p', '/usage', '--output-format', 'json'], options, (err, stdout) => {
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
  const usage = payload?.usage ?? payload
  const window = (value: Json | undefined) => {
    if (!value) return undefined
    const parsed = parseWindow({ ...value, percent: value.usagePercent ?? value.percent })
    if (parsed && parsed.resetsAt === null && typeof value.resetInSec === 'number' && Number.isFinite(value.resetInSec)) {
      parsed.resetsAt = now + Math.max(0, value.resetInSec) * 1000
    }
    return parsed
  }
  const session = window(usage?.rolling ?? usage?.session)
  const weekly = window(usage?.weekly)
  const monthly = window(usage?.monthly)
  const known = !!(session || weekly || monthly)
  return {
    known,
    source: known ? 'live' : 'unknown',
    asOf: now,
    updatedAt: now,
    ...(session ? { session } : {}),
    ...(weekly ? { weekly } : {}),
    ...(monthly ? { monthly } : {}),
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
    const res = await fetch(url, { headers, signal: controller.signal, redirect: 'error' })
    if (res.status === 429) return { known: false, reason: 'rate-limited', retryAt: retryAfter(res, now()) }
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
