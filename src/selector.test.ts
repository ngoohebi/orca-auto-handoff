import { assert, test } from 'orca/testing'
import { parseAccounts } from './accounts'
import { activeTerminalsIn } from './cli'
import { accountList } from './fixtures'
import { blindCooldownMs, buildChain, earliestReset, enoughGap, pickNext, preferredOver, strikesOf, tier } from './selector'
import { DEFAULT_CONFIG, SMART_CONFIG, type Config, type Seat, type SeatHealth } from './types'

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

test('the Antigravity host login is a seat of its own when no managed account is selected', () => {
  const list = accountList()
  list.antigravity = {
    accounts: [],
    activeAccountId: null,
    selectedAccountId: null,
    currentAccount: { email: null, subject: null, authMethod: 'consumer', identityKnown: false }
  }
  list.rateLimits.antigravity = {
    provider: 'antigravity',
    status: 'ok',
    session: { usedPercent: 12, resetsAt: NOW + 3_600_000 },
    weekly: { usedPercent: 3, resetsAt: NOW + 86_400_000 }
  }
  const { seats, active } = parseAccounts(list)
  const agy = seats.find((s) => s.provider === 'antigravity')!
  assert.equal(agy.key, 'antigravity:system')
  assert.equal(agy.label, 'system')
  assert.equal(agy.active, true)
  assert.equal(agy.usage.session?.usedPercent, 12)
  assert.equal(active.antigravity, 'antigravity:system')
  // Without a login or usage there is nothing to show.
  const none = accountList()
  assert.equal(parseAccounts(none).seats.some((s) => s.provider === 'antigravity'), false)
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
  // A target without numbers is not "clearly better": only an exhausted seat may move onto it.
  assert.equal(enoughGap(seat('a', 0, 85), { ...seat('b', 0, 0), usage: { known: false } }, cfg()), false)
  assert.equal(enoughGap(seat('a', 100, 85), { ...seat('b', 0, 0), usage: { known: false } }, cfg()), true)
  assert.equal(enoughGap({ ...seat('a', 0, 0), usage: { known: false } }, { ...seat('b', 0, 0), usage: { known: false } }, cfg()), false)
  assert.equal(enoughGap(seat('a', 0, 85), seat('b', 0, 80), cfg({ minHeadroomGap: 0 })), true)
  // 5-hour use is halved: a seat at 97 % of its 5-hour window is not "clearly worse" than one at
  // 45 % of its week. Left because it is about to run out (`low`), it counts as having no room,
  // and the target only needs the gap as room of its own.
  assert.equal(enoughGap(seat('a', 97, 30), seat('b', 5, 45), cfg()), false)
  assert.equal(enoughGap(seat('a', 97, 30), seat('b', 5, 45), cfg(), true), true)
  assert.equal(enoughGap(seat('a', 60, 30), seat('b', 5, 90), cfg(), true), true)
  assert.equal(enoughGap(seat('a', 97, 30), seat('b', 5, 91), cfg(), true), false)
  assert.equal(enoughGap(seat('a', 97, 30), seat('b', 95, 10), cfg(), true), false)
  assert.equal(enoughGap(seat('a', 97, 30), { ...seat('b', 0, 0), usage: { known: false } }, cfg(), true), false)
})

test('activeTerminalsIn picks the active leaf of each workspace\u2019s active tab', () => {
  const result = {
    visualLayouts: [
      {
        worktreeId: 'w1',
        root: {
          type: 'group',
          activeTabId: 'tab2',
          tabs: [
            { tabId: 'tab1', activeLeafId: 'l1', panes: { type: 'terminal', handle: 'term_a', leafId: 'l1', active: true } },
            {
              tabId: 'tab2',
              activeLeafId: 'l3',
              panes: {
                type: 'split',
                children: [
                  { type: 'terminal', handle: 'term_b', leafId: 'l2', active: false },
                  { type: 'terminal', handle: 'term_c', leafId: 'l3', active: true }
                ]
              }
            }
          ]
        }
      },
      { worktreeId: 'w2', root: { type: 'group', activeTabId: 'x', tabs: [{ tabId: 'x', activeLeafId: 'y', panes: { type: 'terminal', handle: 'term_d', leafId: 'y', active: true } }] } }
    ]
  }
  assert.deepEqual(activeTerminalsIn(result), ['term_c', 'term_d'])
  assert.deepEqual(activeTerminalsIn({}), [])
})

// ---- deciding with no data: tiers A / B+ / B ----------------------------------------------------

const HOUR = 3_600_000
/** A Claude seat with known usage (`weekly` %, optional weekly reset) or, with no numbers, unknown. */
function mk(id: string, weekly?: number, weeklyReset: number | null = null): Seat {
  return {
    key: `claude:${id}`,
    provider: 'claude',
    accountId: id,
    label: id,
    active: false,
    usage:
      weekly === undefined
        ? { known: false, source: 'unknown' }
        : { known: true, source: 'live', session: { usedPercent: 0, resetsAt: null }, weekly: { usedPercent: weekly, resetsAt: weeklyReset } }
  }
}
/** A seat whose cooldown ended at a real reset time: presumed reset. */
const FREED: SeatHealth = { resetKnown: true, freedAt: NOW - 1000 }
const STRATEGIES = ['drain', 'priority', 'balanced', 'soonest-reset'] as const

test('tiers: A known, B+ presumed reset, B unknown; cooled and over-threshold seats are out', () => {
  const c = cfg({ thresholdSevenDay: 80 })
  assert.equal(tier(mk('a', 10), undefined, c, NOW), 'A')
  assert.equal(tier(mk('a', 90), undefined, c, NOW), null)
  assert.equal(tier(mk('a', 10), { cooldownUntil: NOW + 1 }, c, NOW), null)
  assert.equal(tier(mk('b'), undefined, c, NOW), 'B')
  assert.equal(tier(mk('b'), { cooldownUntil: NOW + 1, resetKnown: true }, c, NOW), null)
  assert.equal(tier(mk('b'), FREED, c, NOW), 'B+')
  // Expired but not yet swept by the tick: the same.
  assert.equal(tier(mk('b'), { cooldownUntil: NOW - 1, resetKnown: true }, c, NOW), 'B+')
  // A guessed cooldown that expired says nothing; neither does a seat with a strike.
  assert.equal(tier(mk('b'), { freedAt: NOW - 1000 }, c, NOW), 'B')
  assert.equal(tier(mk('b'), { ...FREED, strikes: 1, strikeAt: NOW - HOUR }, c, NOW), 'B')
  // Strikes lapse after 24 h.
  assert.equal(strikesOf({ strikes: 3, strikeAt: NOW - 23 * HOUR }, NOW), 3)
  assert.equal(strikesOf({ strikes: 3, strikeAt: NOW - 24 * HOUR }, NOW), 0)
  assert.equal(tier(mk('b'), { ...FREED, strikes: 1, strikeAt: NOW - 25 * HOUR }, c, NOW), 'B+')
  // A known reading always wins, whatever the history.
  assert.equal(tier(mk('a', 10), { strikes: 2, strikeAt: NOW - 1 }, c, NOW), 'A')
})

test('hard limit, every strategy: a known seat first, then presumed reset, then unknown', () => {
  // Chain: current, unknown, presumed reset, known. Chain order alone would take the unknown seat.
  const chain = [mk('cur', 100), mk('u'), mk('p'), mk('k', 60)]
  const health = { 'claude:p': FREED }
  for (const strategy of STRATEGIES) {
    const c = cfg({ strategy })
    assert.equal(pickNext(chain, 'claude:cur', health, c, NOW)?.key, 'claude:k', strategy)
    // No known seat left: presumed reset before unknown.
    const noA = { ...health, 'claude:k': { cooldownUntil: NOW + 1 } }
    assert.equal(pickNext(chain, 'claude:cur', noA, c, NOW)?.key, 'claude:p', strategy)
    // Only unknown seats left: still a target, never parked while one exists.
    const onlyB = { ...noA, 'claude:p': { cooldownUntil: NOW + 1 } }
    assert.equal(pickNext(chain, 'claude:cur', onlyB, c, NOW)?.key, 'claude:u', strategy)
    assert.equal(pickNext(chain, 'claude:cur', { ...onlyB, 'claude:u': { cooldownUntil: NOW + 1 } }, c, NOW), null, strategy)
  }
})

test('hard limit among unknown seats: fewest strikes first, then the strategy order', () => {
  const chain = [mk('cur', 100), mk('u1'), mk('u2'), mk('u3')]
  const health = { 'claude:u1': { strikes: 2, strikeAt: NOW - HOUR }, 'claude:u2': { strikes: 1, strikeAt: NOW - HOUR } }
  for (const strategy of STRATEGIES) {
    const c = cfg({ strategy })
    assert.equal(pickNext(chain, 'claude:cur', health, c, NOW)?.key, 'claude:u3', strategy)
    assert.equal(pickNext(chain, 'claude:cur', { ...health, 'claude:u3': { cooldownUntil: NOW + 1 } }, c, NOW)?.key, 'claude:u2', strategy)
    // No strikes anywhere: plain strategy order.
    assert.equal(pickNext(chain, 'claude:cur', {}, c, NOW)?.key, 'claude:u1', strategy)
    // Old strikes no longer count.
    const old = { 'claude:u1': { strikes: 2, strikeAt: NOW - 25 * HOUR } }
    assert.equal(pickNext(chain, 'claude:cur', old, c, NOW)?.key, 'claude:u1', strategy)
  }
})

test('the strategy still orders seats within one tier', () => {
  const chain = [mk('cur', 100), mk('u'), mk('k1', 60, NOW + 9 * HOUR), mk('k2', 20, NOW + 5 * HOUR), mk('k3', 40, NOW + 2 * HOUR)]
  const pick = (strategy: Config['strategy'], from = 'claude:cur') => pickNext(chain, from, {}, cfg({ strategy }), NOW)?.key
  assert.equal(pick('drain'), 'claude:k1')
  assert.equal(pick('drain', 'claude:k1'), 'claude:k2')
  assert.equal(pick('priority'), 'claude:k1')
  assert.equal(pick('balanced'), 'claude:k2')
  assert.equal(pick('soonest-reset'), 'claude:k3')
})

test('balanced and soonest-reset: an unknown seat no longer competes as 50 %', () => {
  const chain = [mk('cur', 100), mk('u'), mk('k', 80)]
  // 80 % known is worse than "50", but it is the only seat with numbers.
  assert.equal(pickNext(chain, 'claude:cur', {}, cfg({ strategy: 'balanced' }), NOW)?.key, 'claude:k')
  assert.equal(pickNext(chain, 'claude:cur', {}, cfg({ strategy: 'soonest-reset' }), NOW)?.key, 'claude:k')
  // Within the presumed-reset and unknown tiers there are no numbers: chain order.
  const blind = [mk('cur', 100), mk('u1'), mk('u2'), mk('p')]
  assert.equal(pickNext(blind, 'claude:cur', { 'claude:p': FREED }, cfg({ strategy: 'balanced' }), NOW)?.key, 'claude:p')
  assert.equal(pickNext(blind, 'claude:cur', {}, cfg({ strategy: 'soonest-reset' }), NOW)?.key, 'claude:u1')
})

test('threshold or idle move, every strategy: only onto a known seat, unless the source is at 100 % and none exists', () => {
  const chain = [mk('cur', 85), mk('u'), mk('p'), mk('k', 10)]
  const health = { 'claude:p': FREED }
  const noA = { ...health, 'claude:k': { cooldownUntil: NOW + 1 } }
  for (const strategy of STRATEGIES) {
    const c = cfg({ strategy })
    assert.equal(pickNext(chain, 'claude:cur', health, c, NOW, { mode: 'advisory' })?.key, 'claude:k', strategy)
    assert.equal(pickNext(chain, 'claude:cur', noA, c, NOW, { mode: 'advisory' }), null, strategy)
    // Known to be at 100 %: presumed reset, then unknown.
    assert.equal(pickNext(chain, 'claude:cur', noA, c, NOW, { mode: 'advisory', sourceExhausted: true })?.key, 'claude:p', strategy)
    const onlyB = { ...noA, 'claude:p': { cooldownUntil: NOW + 1 } }
    assert.equal(pickNext(chain, 'claude:cur', onlyB, c, NOW, { mode: 'advisory', sourceExhausted: true })?.key, 'claude:u', strategy)
    // At 100 % with a known seat available: the known seat.
    assert.equal(pickNext(chain, 'claude:cur', health, c, NOW, { mode: 'advisory', sourceExhausted: true })?.key, 'claude:k', strategy)
  }
})

test('a manual pick ignores tiers: chain and strategy order as before', () => {
  const chain = [mk('cur', 100), mk('u'), mk('k', 60)]
  const health = { 'claude:u': { strikes: 3, strikeAt: NOW - 1 } }
  assert.equal(pickNext(chain, 'claude:cur', health, cfg(), NOW, { mode: 'manual' })?.key, 'claude:u')
  assert.equal(pickNext(chain, 'claude:cur', health, cfg({ strategy: 'balanced' }), NOW, { mode: 'manual' })?.key, 'claude:u')
  assert.equal(pickNext(chain, 'claude:cur', health, cfg(), NOW)?.key, 'claude:k')
})

test('switch back: a running pane needs a known or presumed-reset seat; new launches also take an unknown one without strikes', () => {
  const on = (first: Seat) => [first, mk('mid', 10), mk('cur', 20)]
  const back = (first: Seat, health: Record<string, SeatHealth>, scope: 'pane' | 'launch') =>
    preferredOver(on(first), 'claude:cur', health, cfg(), NOW, scope)?.key
  // A: both.
  assert.equal(back(mk('a', 5), {}, 'pane'), 'claude:a')
  assert.equal(back(mk('a', 5), {}, 'launch'), 'claude:a')
  // B+: both.
  assert.equal(back(mk('a'), { 'claude:a': FREED }, 'pane'), 'claude:a')
  assert.equal(back(mk('a'), { 'claude:a': FREED }, 'launch'), 'claude:a')
  // B: new launches only; the pane goes to the first seat ahead that qualifies.
  assert.equal(back(mk('a'), {}, 'pane'), 'claude:mid')
  assert.equal(back(mk('a'), {}, 'launch'), 'claude:a')
  // B with a strike: nobody.
  const struck = { 'claude:a': { strikes: 1, strikeAt: NOW - HOUR } }
  assert.equal(back(mk('a'), struck, 'pane'), 'claude:mid')
  assert.equal(back(mk('a'), struck, 'launch'), 'claude:mid')
  // Nothing ahead qualifies for a pane.
  assert.equal(preferredOver([mk('a'), mk('cur', 20)], 'claude:cur', {}, cfg(), NOW, 'pane'), null)
  // Cooling or over a threshold: out for both.
  assert.equal(back(mk('a'), { 'claude:a': { cooldownUntil: NOW + 1, resetKnown: true } }, 'launch'), 'claude:mid')
  assert.equal(back(mk('a', 100), {}, 'launch'), 'claude:mid')
})

test('guessed cooldown for a seat without numbers doubles per strike, capped at 5 h', () => {
  const minutes = (n: number, base = 60) => blindCooldownMs(cfg({ defaultCooldownMinutes: base }), n) / 60_000
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => minutes(n)), [60, 120, 240, 300, 300, 300])
  assert.deepEqual([1, 2, 3, 6].map((n) => minutes(n, 20)), [20, 40, 80, 300])
  // A default longer than the cap is kept as it is, never shortened or escalated.
  assert.deepEqual([1, 2].map((n) => minutes(n, 480)), [480, 480])
})

test('legacy strategies are unchanged by Smart: its context and its settings mean nothing to them', () => {
  const seat = (id: string, session: number | null, weekly = 10, weeklyReset = NOW + 86_400_000): Seat => ({
    key: `claude:${id}`,
    provider: 'claude',
    accountId: id,
    label: `${id}@example.test`,
    active: false,
    usage: session === null ? { known: false } : { known: true, source: 'live', session: { usedPercent: session, resetsAt: NOW + 3_600_000 }, weekly: { usedPercent: weekly, resetsAt: weeklyReset } }
  })
  // b is nearly full (Low for Smart), c has the most room, d resets soonest, e is unknown.
  const chain = [seat('a', 100), seat('b', 98, 20), seat('c', 5, 5), seat('d', 50, 60, NOW + 3_600_000), seat('e', null)]
  const health: Record<string, SeatHealth> = {}
  const expected = { drain: 'b', priority: 'b', balanced: 'c', 'soonest-reset': 'd' } as const
  // What Smart would be told: b was left as Low, c is crowded.
  const smart = { samples: {}, panes: { 'claude:c': 9 }, avoid: new Set(['claude:b']) }
  for (const [strategy, id] of Object.entries(expected) as [Config['strategy'], string][]) {
    const config = cfg({ strategy })
    for (const mode of ['hard', 'advisory', 'manual'] as const) {
      assert.equal(pickNext(chain, 'claude:a', health, config, NOW, { mode })?.accountId, id, `${strategy} ${mode}`)
      assert.equal(pickNext(chain, 'claude:a', health, config, NOW, { mode, smart })?.accountId, id, `${strategy} ${mode} with context`)
      // The Smart-only settings are not read by a legacy strategy either.
      const looking = { ...config, horizonMinutes: 25, lowFiveHour: 90, lowSevenDay: 97 }
      assert.equal(pickNext(chain, 'claude:a', health, looking, NOW, { mode, smart })?.accountId, id, `${strategy} ${mode} with Smart settings`)
    }
  }
  assert.equal(pickNext(chain, 'claude:a', health, cfg({ strategy: 'manual' }), NOW, { smart }), null)
  // Smart itself reads all of it: d, whose weekly quota is about to expire, and never the nearly full b.
  assert.equal(pickNext(chain, 'claude:a', health, SMART_CONFIG, NOW, { smart })?.accountId, 'd')
  // Switch-back: unchanged without an `avoid` set, which only Smart and my-order ever pass.
  const back = [seat('p', 20), seat('q', 30)]
  assert.equal(preferredOver(back, 'claude:q', {}, cfg(), NOW, 'pane')?.accountId, 'p')
  assert.equal(preferredOver(back, 'claude:q', {}, cfg(), NOW, 'pane', new Set())?.accountId, 'p')
  assert.equal(preferredOver(back, 'claude:q', {}, cfg(), NOW, 'pane', new Set(['claude:p'])), null)
})
