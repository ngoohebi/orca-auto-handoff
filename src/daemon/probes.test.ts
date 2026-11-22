// Tests for live quota probe parsers (`codex app-server`, `claude -p /usage`, OpenCode Go).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import type { Seat } from '../core/types.ts'
import { directQuotaUnavailable, managedProfileQuota, probeClaudeUsage, parseAntigravityQuota, parseClaudeOAuthQuota, parseClaudeUsageJson, parseCodexRateLimits, parseDevinQuota, parseOpenCodeUsage } from './probes.ts'

test('linked OpenCode Go and Devin checks use the credentials of their own saved profiles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oah-data-profile-quota-'))
  const oldRoot = process.env.ORCA_USER_DATA
  const originalFetch = globalThis.fetch
  const openCodeId = '30f24a64-d93e-445c-8d62-03f701633343'
  const devinId = 'e88eef90-9258-4965-98ca-5232311aa918'
  try {
    const profilePath = (provider: 'opencode' | 'devin', id: string) =>
      join(root, 'managed-data-accounts', provider, id, 'data', provider)
    const openCodeHome = profilePath('opencode', openCodeId)
    const devinHome = profilePath('devin', devinId)
    mkdirSync(openCodeHome, { recursive: true })
    mkdirSync(devinHome, { recursive: true })
    const db = new DatabaseSync(join(openCodeHome, 'opencode.db'))
    try {
      db.exec(`CREATE TABLE credential(integration_id TEXT, value TEXT);
        INSERT INTO credential VALUES ('opencode-go', '{"type":"key","key":"fixture-opencode"}');`)
    } finally {
      db.close()
    }
    writeFileSync(join(devinHome, 'credentials.toml'), 'api_server_url = "https://server.codeium.com"\nwindsurf_api_key = "fixture-devin"\n')
    process.env.ORCA_USER_DATA = root
    const requests: string[] = []
    globalThis.fetch = async (url, init) => {
      requests.push(String(url))
      if (url === 'https://opencode.ai/zen/go/v1/usage') {
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-opencode')
        return Response.json({ usage: { rolling: { usagePercent: 1 }, weekly: { usagePercent: 20 } } })
      }
      assert.equal(url, 'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus')
      assert.equal(JSON.parse(String(init?.body)).metadata.apiKey, 'fixture-devin')
      return Response.json({ userStatus: { planStatus: { dailyQuotaRemainingPercent: 76, weeklyQuotaRemainingPercent: 50 } } })
    }
    const seats: Seat[] = [
      { key: `opencode:${openCodeId}`, provider: 'opencode', accountId: openCodeId, label: 'Go', active: true, usage: { known: false } },
      { key: `devin:${devinId}`, provider: 'devin', accountId: devinId, label: 'Devin', active: false, usage: { known: false } }
    ]
    await managedProfileQuota(() => 1_790_000_000_000)({
      opencode: { accounts: [{ id: openCodeId, integrations: ['opencode-go'] }] },
      devin: { accounts: [{ id: devinId }] }
    }, seats, true)
    assert.equal(requests.length, 2)
    assert.deepEqual(seats.map(({ usage }) => [usage.origin, usage.session?.usedPercent, usage.weekly?.usedPercent]),
      [['opencode-profile', 1, 20], ['devin-profile', 24, 50]])
  } finally {
    globalThis.fetch = originalFetch
    if (oldRoot === undefined) delete process.env.ORCA_USER_DATA
    else process.env.ORCA_USER_DATA = oldRoot
    rmSync(root, { recursive: true, force: true })
  }
})

test('a saved quota retry blocks a manual check in a fresh quota reader', async () => {
  const home = mkdtempSync(join(tmpdir(), 'oah-quota-retry-'))
  try {
    const at = 1_790_000_000_000
    const retryAt = at + 60_000
    const seat: Seat = { key: 'codex:example', provider: 'codex', accountId: 'example', label: 'Example', active: true, usage: { known: false } }
    let saved = false
    const quota = managedProfileQuota(() => at, {
      load: () => ({ [seat.key]: retryAt }),
      save: () => { saved = true }
    })
    await quota({ codex: { accounts: [{ id: seat.accountId, managedHomeRuntime: 'host', providerAccountId: 'native', home }] } }, [seat], true)
    assert.deepEqual(seat.directQuotaIssue, { reason: 'rate-limited', retryAt })
    assert.equal(seat.usage.known, false)
    assert.equal(saved, false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('parseDevinQuota reads daily and weekly windows, including an omitted exhausted percentage', () => {
  const now = 1_790_000_000_000
  const quota = parseDevinQuota({ userStatus: { planStatus: {
    dailyQuotaRemainingPercent: 75,
    dailyQuotaResetAtUnix: '1790010000',
    weeklyQuotaResetAtUnix: '1790150000'
  } } }, now)
  assert.deepEqual(quota.session, { usedPercent: 25, resetsAt: 1_790_010_000_000 })
  assert.deepEqual(quota.weekly, { usedPercent: 100, resetsAt: 1_790_150_000_000 })
  assert.equal(parseDevinQuota({ userStatus: { planStatus: {} } }, now).known, false)
})

test('parseAntigravityQuota preserves quota windows and the separate third-party pool', () => {
  const resetTime = '2026-11-24T12:00:00Z'
  const payload = { groups: [{ buckets: [
    { bucketId: 'gemini-5h', remainingFraction: 0.7, resetTime },
    { bucketId: 'gemini-weekly', remainingFraction: 0.5, resetTime },
    { bucketId: '3p-weekly', remainingFraction: 0, resetTime },
    { bucketId: '3p-5h' }
  ] }] }
  const quota = parseAntigravityQuota(payload, 1000)
  assert.deepEqual(quota.session, { usedPercent: 30, resetsAt: Date.parse(resetTime) })
  assert.equal(quota.weekly?.usedPercent, 50)
  assert.equal(quota.model?.usedPercent, 100)
  assert.equal(parseAntigravityQuota({ groups: [] }, 1000).known, false)
})

test('parseClaudeOAuthQuota reads subscription windows and the fullest known model cap', () => {
  const reset = '2026-11-24T12:00:00Z'
  const quota = parseClaudeOAuthQuota({
    five_hour: { utilization: 0, resets_at: reset },
    seven_day: { utilization: 42, resets_at: reset },
    seven_day_opus: { utilization: 90, resets_at: reset },
    seven_day_sonnet: { utilization: 20, resets_at: reset },
    extra_usage: { utilization: 100 }
  }, 1000)
  assert.equal(quota.known, true)
  assert.deepEqual(quota.session, { usedPercent: 0, resetsAt: Date.parse(reset) })
  assert.equal(quota.weekly?.usedPercent, 42)
  assert.equal(quota.model?.name, 'opus')
  assert.equal(parseClaudeOAuthQuota({ five_hour: null }, 1000).known, false)
})

test('parseCodexRateLimits: ignores codex_bengalfox, honors ordinaryUsageAllowed, and preserves accountId', () => {
  const now = 1_790_000_000_000
  const parsed = parseCodexRateLimits(
    {
      jsonrpc: '2.0',
      id: 2,
      result: {
        accountId: 'acc-codex-1',
        ordinaryUsageAllowed: false,
        rateLimitReachedType: 'weekly',
        rateLimitsByLimitId: {
          codex_bengalfox: { primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1790480193 } },
          codex: { primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1790480193 } }
        }
      }
    },
    now
  )
  assert.equal(parsed.accountId, 'acc-codex-1')
  assert.equal(parsed.usage.known, true)
  assert.equal(parsed.usage.ordinaryUsageAllowed, false)
  assert.equal(parsed.usage.rateLimitReachedType, 'weekly')
  assert.equal(parsed.usage.weekly?.usedPercent, 100)
  assert.equal(parsed.usage.weekly?.resetsAt, 1790480193 * 1000)
})

test('parseCodexRateLimits: maps RPC -32600 authentication error to sign-in, never rate limit', () => {
  const parsed = parseCodexRateLimits({
    jsonrpc: '2.0',
    id: 2,
    error: { code: -32600, message: 'codex account authentication required to read rate limits' }
  })
  assert.equal(parsed.usage.known, false)
  assert.equal(parsed.usage.reason, 'sign-in')
})

test('parseCodexRateLimits: identifies a rate limit on the quota request', () => {
  const parsed = parseCodexRateLimits({
    error: { code: -32000, message: 'Quota request returned HTTP 429 Too Many Requests' }
  })
  assert.equal(parsed.usage.known, false)
  assert.equal(parsed.usage.reason, 'rate-limited')
})

test('parseClaudeUsageJson: parses free claude -p /usage JSON output including Fable model window', () => {
  const stdout = JSON.stringify({
    total_cost_usd: 0,
    num_turns: 0,
    result: 'Current session (5-hour): 42%\nAll models (weekly): 25%\nFable weekly: 98%'
  })
  const usage = parseClaudeUsageJson(stdout, 1_790_000_000_000)
  assert.equal(usage.known, true)
  assert.equal(usage.session?.usedPercent, 42)
  assert.equal(usage.weekly?.usedPercent, 25)
  assert.equal(usage.model?.name, 'fable')
  assert.equal(usage.model?.usedPercent, 98)
})

test('parseOpenCodeUsage: parses rolling and weekly/monthly windows with ISO reset times', () => {
  const usage = parseOpenCodeUsage(
    {
      rolling: { usedPercent: 17, resetsAt: '2026-11-23T05:00:00Z' },
      weekly: { usedPercent: 77, resetsAt: '2026-11-28T00:00:00Z' },
      monthly: { usagePercent: 63, resetInSec: 86_400 }
    },
    1_790_000_000_000
  )
  assert.equal(usage.known, true)
  assert.equal(usage.session?.usedPercent, 17)
  assert.equal(usage.weekly?.usedPercent, 77)
  assert.equal(usage.monthly?.usedPercent, 63)
  assert.equal(usage.monthly?.resetsAt, 1_790_086_400_000)
  assert.ok((usage.session?.resetsAt ?? 0) > 0)
})

test('directQuotaUnavailable: a saved profile whose sign-in a check can use, else why not', () => {
  const root = mkdtempSync(join(tmpdir(), 'oah-quota-available-'))
  const oldRoot = process.env.ORCA_USER_DATA
  const devinId = 'e88eef90-9258-4965-98ca-5232311aa918'
  try {
    process.env.ORCA_USER_DATA = root
    const seat = (provider: Seat['provider'], accountId: string): Seat => ({ key: `${provider}:${accountId}`, provider, accountId, label: accountId, active: false, usage: { known: false } })
    const accounts = {
      devin: { accounts: [{ id: devinId }] },
      opencode: { accounts: [{ id: 'oc1', integrations: [] }] },
      claude: { accounts: [{ id: 'a1', managedAuthRuntime: 'host' }] },
      antigravity: { currentAccount: { subject: 's2' }, accounts: [{ id: 'g1', subject: 's1' }, { id: 'g2', subject: 's2' }] }
    }
    // No credentials on disk yet: not available.
    assert.equal(directQuotaUnavailable(accounts, seat('devin', devinId)), 'no saved sign-in on this computer')
    const home = join(root, 'managed-data-accounts', 'devin', devinId, 'data', 'devin')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'credentials.toml'), 'windsurf_api_key = "fixture"\n')
    assert.equal(directQuotaUnavailable(accounts, seat('devin', devinId)), undefined)
    assert.equal(directQuotaUnavailable(accounts, seat('devin', 'system')), "the agent's own login")
    assert.equal(directQuotaUnavailable(accounts, seat('devin', 'gone')), 'not saved in Orca')
    // OpenCode without the Go integration, Claude without an email: not available, and why.
    assert.equal(directQuotaUnavailable(accounts, seat('opencode', 'oc1')), 'OpenCode Go not set up')
    assert.equal(directQuotaUnavailable(accounts, seat('claude', 'a1')), 'Orca has no email for it')
    // Antigravity: only the account signed in to Antigravity on this Mac.
    if (process.platform === 'darwin') {
      assert.equal(directQuotaUnavailable(accounts, seat('antigravity', 'g1')), 'not the account signed in to Antigravity')
      assert.equal(directQuotaUnavailable(accounts, seat('antigravity', 'g2')), undefined)
    }
  } finally {
    if (oldRoot === undefined) delete process.env.ORCA_USER_DATA
    else process.env.ORCA_USER_DATA = oldRoot
    rmSync(root, { recursive: true, force: true })
  }
})

test("probeClaudeUsage for one account: runs Claude Code's /usage with that account's config folder, never a token from the environment", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oah-claude-usage-'))
  const oldToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
  try {
    // A stand-in for `claude`: notes what it was given, then answers as `claude -p /usage` does.
    const bin = join(dir, 'claude')
    const seen = join(dir, 'seen')
    writeFileSync(bin, [
      '#!/bin/sh',
      `printf '%s|%s|%s' "$*" "$CLAUDE_CONFIG_DIR" "\${CLAUDE_CODE_OAUTH_TOKEN:-none}" > '${seen}'`,
      `printf '%s' '{"num_turns":0,"total_cost_usd":0,"result":"Current session: 3% used\\nCurrent week (all models): 87% used\\nCurrent week (Fable): 100% used"}'`,
      ''
    ].join('\n'), { mode: 0o755 })
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'from-env'
    const usage = await probeClaudeUsage({ claudeBin: bin, configDir: '/accounts/work', now: () => 1_790_000_000_000 })
    assert.equal(usage.known, true)
    assert.deepEqual([usage.session?.usedPercent, usage.weekly?.usedPercent, usage.model?.name, usage.model?.usedPercent], [3, 87, 'fable', 100])
    assert.equal(readFileSync(seen, 'utf8'), '-p /usage --output-format json|/accounts/work|none')
  } finally {
    if (oldToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = oldToken
    rmSync(dir, { recursive: true, force: true })
  }
})
