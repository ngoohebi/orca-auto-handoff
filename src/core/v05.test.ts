// Unit tests for OAH v0.5.0 core upgrades: circuit breaker, Codex ordinaryUsageAllowed gate,
// nested whole-window pacing, modelWindowPolicy, and Claude StopFailure hook management.
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAccounts } from './accounts.ts'
import { emptyUsageCache, observe, resolve } from './usage-cache.ts'
import { buildChain, circuitState, exhausted, isEligible, pickNext } from './selector.ts'
import { assess, wholeWindowPace } from './smart.ts'
import { installStopFailureHook, isStopFailureHookInstalledIn, uninstallStopFailureHook } from './statusline.ts'
import { DEFAULT_CONFIG, SMART_CONFIG, type Seat, type SeatHealth } from './types.ts'

const HOUR = 3_600_000
const WEEK = 7 * 24 * HOUR

test('a newer direct Codex block survives a stale Orca reading until its reported reset', () => {
  const now = 1_790_000_000_000
  const reset = now + HOUR
  const saved: Seat = {
    key: 'codex:a', provider: 'codex', accountId: 'a', label: 'A', active: false,
    usage: {
      known: true, origin: 'codex-profile', updatedAt: now,
      ordinaryUsageAllowed: false, rateLimitReachedType: 'weekly',
      weekly: { usedPercent: 0, resetsAt: reset }
    }
  }
  const cache = emptyUsageCache()
  observe(cache, [saved], now, {})
  const stale: Seat = { ...saved, usage: { known: true, weekly: { usedPercent: 0, resetsAt: reset } } }
  observe(cache, [stale], now + 1000, {})
  const before = resolve(stale, cache, now + 1000, WEEK, {})
  assert.equal(before.source, 'cached')
  assert.equal(before.ordinaryUsageAllowed, false)
  assert.equal(exhausted({ ...stale, usage: before }, now + 1000), true)
  const after = resolve(stale, cache, reset + 1000, WEEK, {})
  assert.equal(after.source, 'projected')
  assert.equal(after.ordinaryUsageAllowed, undefined)
})

test('circuitState transitions: closed -> open -> half_open -> closed, and pickNext prefers closed over half_open', () => {
  const now = 1_790_000_000_000
  assert.equal(circuitState(undefined, now), 'closed')
  assert.equal(circuitState({ cooldownUntil: now + 60_000, consecutiveFailures: 1 }, now), 'open')
  assert.equal(circuitState({ cooldownUntil: now - 1000, freedAt: now - 1000, consecutiveFailures: 1 }, now), 'half_open')
  assert.equal(circuitState({ circuit: 'closed', consecutiveFailures: 0, freedAt: now - 1000 }, now), 'closed')

  const s1: Seat = { key: 'claude:a', provider: 'claude', accountId: 'a', label: 'a', active: true, usage: { known: true, session: { usedPercent: 100, resetsAt: null } } }
  const s2: Seat = { key: 'claude:b', provider: 'claude', accountId: 'b', label: 'b', active: false, usage: { known: true, session: { usedPercent: 10, resetsAt: null } } }
  const s3: Seat = { key: 'claude:c', provider: 'claude', accountId: 'c', label: 'c', active: false, usage: { known: true, session: { usedPercent: 20, resetsAt: null } } }
  const health: Record<string, SeatHealth> = {
    'claude:b': { circuit: 'half_open', consecutiveFailures: 2, freedAt: now - 1000 }
  }
  const picked = pickNext([s1, s2, s3], 'claude:a', health, DEFAULT_CONFIG, now)
  assert.equal(picked?.key, 'claude:c')
})

test('Antigravity hand-off picks another saved Antigravity account after a quota limit', () => {
  const now = 1_790_000_000_000
  const { seats, active } = parseAccounts({
    antigravity: {
      selectedAccountId: 'first',
      accounts: [{ id: 'first' }, { id: 'backup' }],
      currentAccount: { authMethod: 'consumer', identityKnown: false }
    },
    codex: { accounts: [{ id: 'other' }] },
    rateLimits: {
      antigravity: { status: 'ok', session: { usedPercent: 100, resetsAt: now + HOUR } }
    }
  })
  const chain = buildChain(seats, 'antigravity', DEFAULT_CONFIG)
  assert.deepEqual(chain.map((seat) => seat.key), ['antigravity:first', 'antigravity:backup'])
  assert.equal(active.antigravity, 'antigravity:first')
  assert.equal(exhausted(chain[0]!, now), true)
  assert.equal(pickNext(chain, active.antigravity, {}, DEFAULT_CONFIG, now)?.key, 'antigravity:backup')
})

test('Codex ordinaryUsageAllowed: false marks seat exhausted even when secondary buckets are 0 %', () => {
  const view = parseAccounts({
    codex: { activeAccountId: 'c1', accounts: [{ id: 'c1', email: 'c1@example.com' }] },
    rateLimits: {
      codex: {
        status: 'ok',
        ordinaryUsageAllowed: false,
        rateLimitReachedType: 'weekly',
        session: { usedPercent: 0, resetsAt: null }
      }
    }
  })
  const seat = view.seats[0]!
  assert.equal(seat.usage.ordinaryUsageAllowed, false)
  assert.equal(exhausted(seat, Date.now()), true)
  assert.equal(isEligible(seat, undefined, Date.now()), false)
})

test('wholeWindowPace catches nested long-window overruns (38 % used at 10 % elapsed -> 380 % projected) and guards <5 % elapsed', () => {
  const now = 1_790_000_000_000
  const fresh = wholeWindowPace({ usedPercent: 10, resetsAt: now + WEEK * 0.98 }, WEEK, now)
  assert.equal(fresh, null)

  const overrun = wholeWindowPace({ usedPercent: 38, resetsAt: now + WEEK * 0.9 }, WEEK, now)
  assert.ok(overrun !== null && Math.round(overrun) === 380)

  const seat: Seat = {
    key: 'claude:a',
    provider: 'claude',
    accountId: 'a',
    label: 'a',
    active: true,
    usage: {
      known: true,
      session: { usedPercent: 17, resetsAt: now + 5 * HOUR * 0.17 },
      weekly: { usedPercent: 38, resetsAt: now + WEEK * 0.9 }
    }
  }
  const res = assess(seat, undefined, [], SMART_CONFIG, now)
  assert.equal(res.nestedOverrun?.window, 'w')
  assert.ok((res.nestedOverrun?.projectedPercent ?? 0) > 300)
})

test('modelWindowPolicy: rotate marks seat out when model bucket is 100 %, fallback-model does not', () => {
  const now = 1_790_000_000_000
  const seat: Seat = {
    key: 'claude:a',
    provider: 'claude',
    accountId: 'a',
    label: 'a',
    active: true,
    usage: {
      known: true,
      session: { usedPercent: 20, resetsAt: null },
      weekly: { usedPercent: 25, resetsAt: null },
      model: { name: 'fable', usedPercent: 100, resetsAt: now + HOUR }
    }
  }
  assert.equal(assess(seat, undefined, [], { ...SMART_CONFIG, modelWindowPolicy: 'fallback-model' }, now).state, 'ok')
  assert.equal(assess(seat, undefined, [], { ...SMART_CONFIG, modelWindowPolicy: 'rotate' }, now).state, 'out')
})

test('installStopFailureHook and uninstallStopFailureHook preserve user hooks cleanly', () => {
  const initial = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } })
  assert.equal(isStopFailureHookInstalledIn(initial), false)

  const installed = installStopFailureHook(initial)
  assert.equal(installed.added, true)
  assert.equal(isStopFailureHookInstalledIn(installed.text), true)

  const second = installStopFailureHook(installed.text)
  assert.equal(second.added, false)

  const removed = uninstallStopFailureHook(installed.text)
  assert.equal(removed.removed, true)
  assert.equal(isStopFailureHookInstalledIn(removed.text), false)
  assert.match(removed.text!, /PreToolUse/)
})
