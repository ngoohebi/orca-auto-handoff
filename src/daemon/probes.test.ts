// Tests for live quota probe parsers (`codex app-server`, `claude -p /usage`, OpenCode Go).
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseClaudeUsageJson, parseCodexRateLimits, parseOpenCodeUsage } from './probes.ts'

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
      weekly: { usedPercent: 77, resetsAt: '2026-11-28T00:00:00Z' }
    },
    1_790_000_000_000
  )
  assert.equal(usage.known, true)
  assert.equal(usage.session?.usedPercent, 17)
  assert.equal(usage.weekly?.usedPercent, 77)
  assert.ok((usage.session?.resetsAt ?? 0) > 0)
})
