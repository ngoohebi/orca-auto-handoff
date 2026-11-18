import { assert, test } from 'orca/testing'
import { parseAccounts } from './accounts'
import { accountList } from './fixtures'
import { buildChain, earliestReset, enoughGap, pickNext, preferredOver } from './selector'
import { DEFAULT_CONFIG, type Config } from './types'

const NOW = 1_000_000
const cfg = (over: Partial<Config> = {}): Config => ({ ...DEFAULT_CONFIG, ...over })

test('parses seats, dedupes the system login, maps usage', () => {
  const { seats, active } = parseAccounts(accountList())
  const keys = seats.map((s) => s.key)
  // me@example.test is both a managed account (c3) and the Claude system login: one seat.
  assert.deepEqual(keys, ['claude:c1', 'claude:c2', 'claude:c3', 'codex:x1', 'codex:x2', 'codex:system'])
  assert.equal(active.claude, 'claude:c1')
  const c1 = seats[0]!
  assert.equal(c1.usage.known, true)
  assert.equal(c1.usage.session?.usedPercent, 7)
  assert.equal(c1.usage.model?.name, 'fable')
  assert.equal(seats[1]!.usage.known, false) // stale-token inactive Claude seat
  assert.equal(seats.find((s) => s.key === 'codex:x2')!.usage.session?.usedPercent, 100)
})

test('system login active and duplicate of a managed seat marks that seat active', () => {
  const { seats, active } = parseAccounts(accountList({ claudeActive: null }))
  assert.equal(active.claude, 'claude:c3')
  assert.equal(seats.find((s) => s.key === 'claude:c3')!.usage.session?.usedPercent, 7)
})

test('drain takes the next seat in chain order, skipping limited ones', () => {
  const { seats } = parseAccounts(accountList())
  const chain = buildChain(seats, 'claude', cfg())
  assert.equal(pickNext(chain, 'claude:c1', {}, cfg(), NOW)?.key, 'claude:c2')
  assert.equal(pickNext(chain, 'claude:c1', { 'claude:c2': { cooldownUntil: NOW + 1 } }, cfg(), NOW)?.key, 'claude:c3')
  assert.equal(pickNext(chain, 'claude:c3', {}, cfg(), NOW)?.key, 'claude:c1')
})

test('exhausted seats by usage are skipped; null when all are limited', () => {
  const { seats } = parseAccounts(accountList())
  const chain = buildChain(seats, 'codex', cfg())
  // x2 is at 100 % session usage → skipped.
  assert.equal(pickNext(chain, 'codex:x1', {}, cfg(), NOW)?.key, 'codex:system')
  const health = { 'codex:system': { cooldownUntil: NOW + 5000 } }
  assert.equal(pickNext(chain, 'codex:x1', health, cfg(), NOW), null)
  assert.equal(earliestReset(chain, health, NOW), NOW + 5000)
})

test('chain orders accounts within one service and never includes another service', () => {
  const { seats } = parseAccounts(accountList())
  const c = cfg({ chain: 'two@example.test, claude:*, codex:*' })
  const chain = buildChain(seats, 'claude', c)
  assert.deepEqual(chain.map((s) => s.key), ['claude:c2', 'claude:c1', 'claude:c3'])
  const allClaudeLimited = {
    'claude:c1': { cooldownUntil: NOW + 1 },
    'claude:c2': { cooldownUntil: NOW + 1 },
    'claude:c3': { cooldownUntil: NOW + 1 }
  }
  // Every Claude account limited: nothing, even though the chain names codex:*.
  assert.equal(pickNext(chain, 'claude:c1', allClaudeLimited, c, NOW), null)
  // The same email on Codex orders the Codex chain, separately.
  assert.deepEqual(buildChain(seats, 'codex', c).map((s) => s.key), ['codex:x2', 'codex:x1', 'codex:system'])
})

test('balanced prefers the least used known seat; manual never picks', () => {
  const { seats } = parseAccounts(accountList({ inactiveCodex: { x2: 10 } }))
  const chain = buildChain(seats, 'codex', cfg())
  assert.equal(pickNext(chain, 'codex:system', {}, cfg({ strategy: 'balanced' }), NOW)?.key, 'codex:x1')
  assert.equal(pickNext(chain, 'codex:x1', {}, cfg({ strategy: 'manual' }), NOW), null)
})

test('thresholds make a busy seat ineligible', () => {
  const { seats } = parseAccounts(accountList({ claudeUsage: { session: 85, weekly: 10 } }))
  const chain = buildChain(seats, 'claude', cfg({ thresholdFiveHour: 80 }))
  assert.equal(pickNext(chain, 'claude:c3', {}, cfg({ thresholdFiveHour: 80, strategy: 'priority' }), NOW)?.key, 'claude:c2')
})

test('switch back: the first healthy seat ahead in the chain, for drain and priority only', () => {
  const { seats } = parseAccounts(accountList())
  const chain = buildChain(seats, 'claude', cfg())
  // On c3 with c1 limited: c2 is ahead and healthy.
  assert.equal(preferredOver(chain, 'claude:c3', { 'claude:c1': { cooldownUntil: NOW + 1 } }, cfg(), NOW)?.key, 'claude:c2')
  // c1 free again: it wins over c2.
  assert.equal(preferredOver(chain, 'claude:c3', {}, cfg(), NOW)?.key, 'claude:c1')
  // Already on the first seat, or nothing ahead is healthy: nothing.
  assert.equal(preferredOver(chain, 'claude:c1', {}, cfg(), NOW), null)
  const ahead = { 'claude:c1': { cooldownUntil: NOW + 1 }, 'claude:c2': { cooldownUntil: NOW + 1 } }
  assert.equal(preferredOver(chain, 'claude:c3', ahead, cfg(), NOW), null)
  assert.equal(preferredOver(chain, 'claude:c3', {}, cfg({ switchBack: false }), NOW), null)
  assert.equal(preferredOver(chain, 'claude:c3', {}, cfg({ strategy: 'balanced' }), NOW), null)
  assert.equal(preferredOver(chain, 'claude:c3', {}, cfg({ strategy: 'priority' }), NOW)?.key, 'claude:c1')
  // Excluded seats are never a target, for switch-back or rotation.
  assert.equal(preferredOver(chain, 'claude:c3', {}, cfg({ exclude: 'one@example.test' }), NOW)?.key, 'claude:c2')
  assert.equal(pickNext(chain, 'claude:c3', {}, cfg({ exclude: 'claude:c1, two@example.test' }), NOW), null)
})

test('soonest-reset spends the usage that expires first', () => {
  const { seats } = parseAccounts(accountList({ inactiveCodex: { x2: 10 } }))
  for (const s of seats) {
    if (s.key === 'codex:x2') s.usage.weekly = { usedPercent: 10, resetsAt: NOW + 1000 }
    if (s.key === 'codex:x1') s.usage.weekly = { usedPercent: 0, resetsAt: NOW + 5000 }
  }
  const chain = buildChain(seats, 'codex', cfg())
  assert.equal(pickNext(chain, 'codex:system', {}, cfg({ strategy: 'soonest-reset' }), NOW)?.key, 'codex:x2')
  // Unknown resets sort last.
  assert.equal(pickNext(chain, 'codex:x2', {}, cfg({ strategy: 'soonest-reset' }), NOW)?.key, 'codex:x1')
})

test('headroom gap: a threshold move needs a clearly better seat; exhausted seats may always leave', () => {
  const seat = (key: string, session: number, weekly: number) =>
    ({ key, provider: 'claude', accountId: key, label: key, active: false, usage: { known: true, session: { usedPercent: session, resetsAt: null }, weekly: { usedPercent: weekly, resetsAt: null } } }) as const
  assert.equal(enoughGap(seat('a', 0, 85), seat('b', 0, 80), cfg()), false)
  assert.equal(enoughGap(seat('a', 0, 85), seat('b', 0, 70), cfg()), true)
  assert.equal(enoughGap(seat('a', 100, 85), seat('b', 0, 84), cfg()), true)
  assert.equal(enoughGap(undefined, seat('b', 0, 84), cfg()), true)
  assert.equal(enoughGap(seat('a', 0, 85), { ...seat('b', 0, 0), usage: { known: false } }, cfg()), true)
  assert.equal(enoughGap(seat('a', 0, 85), seat('b', 0, 80), cfg({ minHeadroomGap: 0 })), true)
})
