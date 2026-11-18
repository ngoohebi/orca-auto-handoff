// The Smart strategy's pure parts: the state of an account, the order of targets, and the words.
import { assert, test } from 'orca/testing'
import {
  NO_CONTEXT,
  assess,
  betterExpiring,
  candidateOf,
  expiring,
  explain,
  lastsLongEnough,
  projectedRunwayMs,
  rank,
  shortWait,
  shouldLeave,
  type Candidate,
  type SmartContext
} from './smart'
import { pickNext } from './selector'
import { DEFAULT_CONFIG, SMART_CONFIG, type Config, type Seat, type SeatHealth } from './types'
import type { DailySample, Sample } from './usage-history'

const T0 = 1_800_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const S_RESET = T0 + 4 * HOUR
const W_RESET = T0 + 5 * DAY

const cfg = (over: Partial<Config> = {}): Config => ({ ...SMART_CONFIG, ...over })

type Reading = { s?: number; w?: number; m?: number; sReset?: number | null; wReset?: number | null; source?: Seat['usage']['source'] }
function seat(id: string, r: Reading | null): Seat {
  const usage: Seat['usage'] = r ? { known: true, source: r.source ?? 'live' } : { known: false }
  if (r?.s !== undefined) usage.session = { usedPercent: r.s, resetsAt: r.sReset === undefined ? S_RESET : r.sReset }
  if (r?.w !== undefined) usage.weekly = { usedPercent: r.w, resetsAt: r.wReset === undefined ? W_RESET : r.wReset }
  if (r?.m !== undefined) usage.model = { name: 'fable', usedPercent: r.m, resetsAt: W_RESET }
  return { key: `claude:${id}`, provider: 'claude', accountId: id, label: `${id}@example.test`, active: false, usage }
}

/** Readings of the 5-hour window, `everyMin` apart, the last one at `now`. */
function rising(levels: number[], now: number, everyMin = 4, w = 20): Sample[] {
  return levels.map((s, i) => ({ t: now - (levels.length - 1 - i) * everyMin * MIN, s, w, sReset: S_RESET, wReset: W_RESET, src: 'orca' as const }))
}

function candidate(s: Seat, over: Partial<Candidate> = {}, config = cfg(), context: SmartContext = NO_CONTEXT): Candidate {
  return { ...candidateOf(s, 'A', 0, undefined, context, config, T0, { chainIndex: 0, turn: 0 }), ...over }
}
const order = (cands: Candidate[], config = cfg()) => rank(cands, config).map((c) => c.seat.accountId)

test('assess: Out when cooling down or at 100 %; Unknown without numbers; OK with room', () => {
  assert.equal(assess(seat('a', { s: 100, w: 20 }), undefined, [], cfg(), T0).state, 'out')
  assert.equal(assess(seat('a', { s: 20, w: 100 }), undefined, [], cfg(), T0).state, 'out')
  const cooling: SeatHealth = { cooldownUntil: T0 + MIN }
  const cooled = assess(seat('a', { s: 20, w: 20 }), cooling, [], cfg(), T0)
  assert.equal(cooled.state, 'out')
  // Cooling down, but not at a limit by its own numbers.
  assert.equal(cooled.over, false)
  assert.equal(assess(seat('a', { s: 20, w: 20 }), { cooldownUntil: T0 - 1 }, [], cfg(), T0).state, 'ok')
  assert.equal(assess(seat('a', null), undefined, [], cfg(), T0).state, 'unknown')
  assert.equal(assess(seat('a', null), cooling, [], cfg(), T0).state, 'out')
  const ok = assess(seat('a', { s: 30, w: 40, m: 10 }), undefined, [], cfg(), T0)
  assert.equal(ok.state, 'ok')
  assert.deepEqual(ok.left, { s: 70, w: 60, m: 90 })
  assert.equal(ok.runwayMs, null)
  // A window whose reset time has passed no longer counts as full.
  assert.equal(assess(seat('a', { s: 100, w: 20, sReset: T0 - 1 }), undefined, [], cfg(), T0).state, 'ok')
  // A configured cap below 100 (a legacy threshold kept by `auto`) also means Out.
  assert.equal(assess(seat('a', { s: 60, w: 20 }), undefined, [], cfg({ thresholdFiveHour: 50 }), T0).state, 'out')
})

test('assess: Low when the pace runs out within the horizon, from a reading at most 10 minutes old', () => {
  // 1 point a minute, 8 points left: about 8 minutes.
  const samples = rising([80, 84, 88, 92], T0)
  const low = assess(seat('a', { s: 92, w: 20 }), undefined, samples, cfg(), T0)
  assert.equal(low.state, 'low')
  assert.deepEqual(low.low, { window: 's', by: 'pace' })
  assert.equal(Math.round(low.runwayMs! / MIN), 8)
  assert.equal(low.rate.s, 1)
  // 20 points left at that pace is 20 minutes: beyond "just before" (10), within "earlier" (25).
  const mid = rising([68, 72, 76, 80], T0)
  assert.equal(assess(seat('a', { s: 80, w: 20 }), undefined, mid, cfg(), T0).state, 'ok')
  assert.equal(assess(seat('a', { s: 80, w: 20 }), undefined, mid, cfg({ horizonMinutes: 25, lowFiveHour: 90, lowSevenDay: 97 }), T0).state, 'low')
  // The same samples 11 minutes later say nothing any more.
  assert.equal(assess(seat('a', { s: 92, w: 20 }), undefined, samples, cfg(), T0 + 11 * MIN).state, 'ok')
  // A window that resets before it would run out does not count.
  const resetting = samples.map((x) => ({ ...x, sReset: T0 + 5 * MIN }))
  assert.equal(assess(seat('a', { s: 92, w: 20, sReset: T0 + 5 * MIN }), undefined, resetting, cfg(), T0).state, 'ok')
})

test('assess: with no pace, Low is 5h at 97 % or weekly at 99 %; "only at the limit" is never Low', () => {
  const at = (r: Reading, config = cfg()) => assess(seat('a', r), undefined, [], config, T0)
  assert.equal(at({ s: 96, w: 20 }).state, 'ok')
  assert.deepEqual(at({ s: 97, w: 20 }).low, { window: 's', by: 'level' })
  assert.equal(at({ s: 20, w: 98 }).state, 'ok')
  assert.deepEqual(at({ s: 20, w: 99 }).low, { window: 'w', by: 'level' })
  // "Earlier": 90 % and 97 %.
  const earlier = cfg({ horizonMinutes: 25, lowFiveHour: 90, lowSevenDay: 97 })
  assert.equal(at({ s: 90, w: 20 }, earlier).state, 'low')
  assert.equal(at({ s: 20, w: 97 }, earlier).state, 'low')
  // "Only at the limit": no forecast and no floor.
  const atLimit = cfg({ horizonMinutes: 0, lowFiveHour: 100, lowSevenDay: 100 })
  assert.equal(at({ s: 99, w: 99 }, atLimit).state, 'ok')
  assert.equal(assess(seat('a', { s: 92, w: 20 }), undefined, rising([80, 84, 88, 92], T0), atLimit, T0).state, 'ok')
  // A slow, measured pace wins over the level: 97 % rising 1 point in 12 minutes lasts 36 minutes.
  const slow = rising([96, 96, 96, 97], T0)
  assert.equal(assess(seat('a', { s: 97, w: 20 }), undefined, slow, cfg(), T0).state, 'ok')
})

test('rank 1: more known first (A, then presumed reset, then unknown with the fewest strikes)', () => {
  const a = candidate(seat('a', { s: 90, w: 90 }))
  const bPlus = candidate(seat('p', null), { tier: 'B+' })
  const b = candidate(seat('b', null), { tier: 'B' })
  const struck = candidate(seat('x', null), { tier: 'B', strikes: 2 })
  assert.deepEqual(order([struck, b, bPlus, a]), ['a', 'p', 'b', 'x'])
})

test('rank 2: a projected runway of at least three horizons comes first', () => {
  // Both known; `short` would last 20 minutes at its pace, `long` has less room but no pace against it.
  const short = candidate(seat('short', { s: 60, w: 10 }), { projectedMs: 20 * MIN })
  const long = candidate(seat('long', { s: 70, w: 30 }))
  assert.deepEqual(order([short, long]), ['long', 'short'])
  // 30 minutes is three 10-minute horizons: enough. With "earlier" (25 min) it is not.
  const enough = candidate(seat('short', { s: 60, w: 10 }), { projectedMs: 30 * MIN })
  assert.equal(lastsLongEnough(enough, cfg()), true)
  assert.equal(lastsLongEnough(enough, cfg({ horizonMinutes: 25 })), false)
  // An account that is Low, or was left as Low, never counts as lasting.
  assert.equal(lastsLongEnough(candidate(seat('a', { s: 98, w: 10 })), cfg()), false)
  assert.equal(lastsLongEnough(candidate(seat('a', { s: 10, w: 10 }), { avoided: true }), cfg()), false)
  assert.deepEqual(order([candidate(seat('low', { s: 98, w: 1 })), long]), ['long', 'low'])
})

test('rank 3: the user’s own order, when one is set, comes before quota and headroom', () => {
  const first = candidate(seat('first', { s: 60, w: 60 }), { chainIndex: 0 })
  const second = candidate(seat('second', { s: 5, w: 5, wReset: T0 + 20 * HOUR }), { chainIndex: 1 })
  assert.equal(second.expiring, true)
  assert.deepEqual(order([second, first]), ['first', 'second'])
  // Without an order (every index equal) the expiring one wins.
  assert.deepEqual(order([{ ...first, chainIndex: 0 }, { ...second, chainIndex: 0 }]), ['second', 'first'])
  // The order never outranks rule 2.
  assert.deepEqual(order([{ ...first, projectedMs: 5 * MIN }, second]), ['second', 'first'])
})

test('rank 4: weekly quota that would expire unused is spent first', () => {
  // 60 % left, reset in 20 h, used 40 % in the 148 h so far: it cannot be used up.
  const leaving = seat('leaving', { s: 10, w: 40, wReset: T0 + 20 * HOUR })
  assert.equal(expiring(leaving, undefined, T0), true)
  const fresh = candidate(seat('fresh', { s: 0, w: 0, wReset: T0 + 19 * HOUR + 6 * DAY }))
  assert.deepEqual(order([fresh, candidate(leaving)]), ['leaving', 'fresh'])
  // Not expiring: the reset is 48 h or more away; 15 % or less is left; or the week's own pace uses it up.
  assert.equal(expiring(seat('a', { s: 10, w: 40, wReset: T0 + 48 * HOUR }), undefined, T0), false)
  assert.equal(expiring(seat('a', { s: 10, w: 85, wReset: T0 + 20 * HOUR }), undefined, T0), false)
  assert.equal(expiring(seat('a', { s: 10, w: 84, wReset: T0 + 20 * HOUR }), undefined, T0), true)
  const reset = T0 + 20 * HOUR
  const daily = (levels: number[]): DailySample[] => levels.map((w, i) => ({ day: i, t: T0 - (levels.length - 1 - i) * DAY, w, wReset: reset }))
  // 80 % used, all of it since yesterday: at that pace the 20 % left go well within 20 h.
  const busy = seat('a', { s: 10, w: 80, wReset: reset })
  assert.equal(expiring(busy, { recent: [], daily: daily([0, 80]) }, T0), false)
  // The same level reached at 5 points a day: they do not. Nor by the week's average, with no days recorded.
  assert.equal(expiring(busy, { recent: [], daily: daily([70, 75, 80]) }, T0), true)
  assert.equal(expiring(busy, undefined, T0), true)
  // Nothing known, or a window already reset: nothing to say.
  assert.equal(expiring(seat('a', null), undefined, T0), false)
  assert.equal(expiring(seat('a', { s: 10, w: 40, wReset: T0 - 1 }), undefined, T0), false)
})

test('rank 5 and 6: the sooner weekly reset, then more headroom, then the next account in turn', () => {
  const sooner = candidate(seat('sooner', { s: 50, w: 90, wReset: T0 + 3 * DAY }))
  const later = candidate(seat('later', { s: 5, w: 5, wReset: T0 + 6 * DAY }))
  assert.equal(sooner.expiring || later.expiring, false)
  assert.deepEqual(order([later, sooner]), ['sooner', 'later'])
  const roomy = candidate(seat('roomy', { s: 10, w: 20 }))
  const tight = candidate(seat('tight', { s: 70, w: 20 }))
  assert.deepEqual(order([tight, roomy]), ['roomy', 'tight'])
  // Equal in everything: the one that comes next after the current account.
  const one = candidate(seat('one', { s: 10, w: 20 }), { turn: 1 })
  const two = candidate(seat('two', { s: 10, w: 20 }), { turn: 0 })
  assert.deepEqual(order([one, two]), ['two', 'one'])
})

test('pane scaling: a target’s pace counts once more for each session already on it', () => {
  // 0.5 points a minute, 60 points left: two hours alone.
  const samples = rising([34, 36, 38, 40], T0)
  assert.equal(Math.round(projectedRunwayMs(samples, 0, T0)! / MIN), 120)
  assert.equal(Math.round(projectedRunwayMs(samples, 1, T0)! / MIN), 60)
  assert.equal(Math.round(projectedRunwayMs(samples, 5, T0)! / MIN), 20)
  assert.equal(projectedRunwayMs([], 3, T0), null)
  // With five sessions already there it would not last three horizons, and a quieter account wins.
  const busy = seat('busy', { s: 40, w: 10 })
  const quiet = seat('quiet', { s: 55, w: 30 })
  const chain = [seat('from', { s: 100, w: 10 }), busy, quiet]
  const history = { [busy.key]: { recent: samples, daily: [] } }
  const pick = (panes: number) =>
    pickNext(chain, 'claude:from', {}, cfg(), T0, { smart: { samples: history, panes: { [busy.key]: panes }, avoid: new Set() } })?.accountId
  assert.equal(pick(0), 'busy')
  assert.equal(pick(5), 'quiet')
})

test('pickNext smart: ranks within the best tier; advice never goes to a Low or set-aside account', () => {
  const from = seat('from', { s: 98, w: 10 })
  const low = seat('low', { s: 97, w: 5 })
  const ok = seat('ok', { s: 60, w: 60 })
  const unknown = seat('unknown', null)
  const chain = [from, low, ok, unknown]
  const smart = (avoid: string[] = []): SmartContext => ({ samples: {}, panes: {}, avoid: new Set(avoid) })
  // A limit: the known account that lasts, before the Low one, before the unknown one.
  assert.equal(pickNext(chain, from.key, {}, cfg(), T0, { smart: smart() })?.accountId, 'ok')
  assert.equal(pickNext([from, low, unknown], from.key, {}, cfg(), T0, { smart: smart() })?.accountId, 'low')
  // Advice: a Low account is no target, and an unknown one only when the source is at 100 %.
  assert.equal(pickNext([from, low, unknown], from.key, {}, cfg(), T0, { mode: 'advisory', smart: smart() }), null)
  assert.equal(pickNext(chain, from.key, {}, cfg(), T0, { mode: 'advisory', smart: smart() })?.accountId, 'ok')
  // Left as Low a moment ago: no target for advice; a last resort at a limit.
  assert.equal(pickNext(chain, from.key, {}, cfg(), T0, { mode: 'advisory', smart: smart([ok.key]) }), null)
  assert.equal(pickNext([from, ok, seat('other', { s: 80, w: 80 })], from.key, {}, cfg(), T0, { smart: smart([ok.key]) })?.accountId, 'other')
  assert.equal(pickNext([from, ok], from.key, {}, cfg(), T0, { smart: smart([ok.key]) })?.accountId, 'ok')
  // Without any context Smart still ranks on the numbers alone.
  assert.equal(pickNext(chain, from.key, {}, cfg(), T0)?.accountId, 'ok')
  // `only` (a model cap) limits the pick to the accounts named.
  assert.equal(pickNext(chain, from.key, {}, cfg(), T0, { only: new Set([low.key]) })?.accountId, 'low')
  assert.equal(pickNext(chain, from.key, {}, cfg(), T0, { only: new Set() }), null)
})

test('explain: one line with the reason, the levels and the reset when it is near', () => {
  const work = { label: 'work', usage: seat('w', { s: 94, w: 30 }).usage, assessment: assess(seat('w', { s: 94, w: 30 }), undefined, rising([82, 86, 90, 94], T0), cfg(), T0) }
  const personal = { label: 'personal', usage: seat('p', { s: 12, w: 40, wReset: T0 + 9 * HOUR }).usage }
  assert.equal(
    explain('low', work, personal, T0),
    'work had about 6 min left at this pace (5h 94 %, week 30 %); moved to personal (5h 12 %, week 40 %, weekly resets in 9 h)'
  )
  const level = { label: 'work', usage: seat('w', { s: 98, w: 30 }).usage, assessment: assess(seat('w', { s: 98, w: 30 }), undefined, [], cfg(), T0) }
  assert.equal(
    explain('low', level, personal, T0, { selectionOnly: true }),
    'work is nearly at the end of its 5h window (5h 98 %, week 30 %); new launches use personal (5h 12 %, week 40 %, weekly resets in 9 h)'
  )
  assert.equal(
    explain('expiring', work, personal, T0, { idle: true }),
    'idle session; personal has weekly quota that would expire unused (5h 12 %, week 40 %, weekly resets in 9 h); moved there from work'
  )
  const out = { label: 'work', usage: seat('w', { s: 100, w: 30 }).usage, assessment: assess(seat('w', { s: 100, w: 30 }), undefined, [], cfg(), T0) }
  assert.equal(explain('out', out, { label: 'spare', usage: { known: false } }, T0, { selectionOnly: true }), 'work is used up (5h 100 %, week 30 %); new launches use spare (no usage numbers yet)')
  const cooling = { label: 'work', usage: seat('w', { s: 40, w: 30 }).usage, assessment: assess(seat('w', { s: 40, w: 30 }), { cooldownUntil: T0 + MIN }, [], cfg(), T0) }
  assert.match(explain('out', cooling, personal, T0), /^work is cooling down after a limit \(5h 40 %, week 30 %\); moved to personal/)
})

test('shouldLeave: at a limit or Low; the legacy settings leave exactly when over the threshold', () => {
  const leave = (r: Reading, config: Config, samples: Sample[] = [], health?: SeatHealth) => shouldLeave(seat('a', r), health, samples, config, T0).leave
  assert.equal(leave({ s: 100, w: 20 }, cfg()), true)
  assert.equal(leave({ s: 97, w: 20 }, cfg()), true)
  assert.equal(leave({ s: 92, w: 20 }, cfg(), rising([80, 84, 88, 92], T0)), true)
  assert.equal(leave({ s: 60, w: 20 }, cfg()), false)
  // A cooldown alone is no reason: the turn that just ended there shows the account works.
  assert.equal(leave({ s: 60, w: 20 }, cfg(), [], { cooldownUntil: T0 + MIN }), false)
  // "Only at a limit" / "New launches only": never, for a running session.
  assert.equal(leave({ s: 100, w: 20 }, cfg({ autoSwitchOnThreshold: false })), false)
  // Legacy (custom): the threshold, and nothing else, whatever the pace.
  const legacy = DEFAULT_CONFIG
  assert.equal(leave({ s: 99, w: 99 }, legacy, rising([87, 91, 95, 99], T0)), false)
  assert.equal(leave({ s: 100, w: 20 }, legacy), true)
  assert.equal(leave({ s: 20, w: 100 }, legacy), true)
  assert.equal(leave({ s: 100, w: 20, sReset: T0 - 1 }, legacy), false)
  assert.equal(leave({ s: 60, w: 20 }, { ...legacy, thresholdFiveHour: 50 }), true)
  assert.equal(leave({ s: 60, w: 20 }, { ...legacy, thresholdFiveHour: 50, autoSwitchOnThreshold: false }), false)
})

test('shortWait: within 5 minutes; or sooner than a short-lived target would last', () => {
  assert.equal(shortWait(T0 + 5 * MIN, null, cfg(), T0), T0 + 5 * MIN)
  assert.equal(shortWait(T0 + 5 * MIN + 1, null, cfg(), T0), null)
  // No reset time known, or one already past: move.
  assert.equal(shortWait(null, null, cfg(), T0), null)
  assert.equal(shortWait(T0 - 1, 10 * MIN, cfg(), T0), null)
  // The target lasts 20 minutes (under three horizons) and the source is back in 15: wait.
  assert.equal(shortWait(T0 + 15 * MIN, 20 * MIN, cfg(), T0), T0 + 15 * MIN)
  // The source takes longer than the target lasts: moving at least buys that time.
  assert.equal(shortWait(T0 + 25 * MIN, 20 * MIN, cfg(), T0), null)
  // A target that lasts (three horizons or more) is always worth moving to.
  assert.equal(shortWait(T0 + 15 * MIN, 30 * MIN, cfg(), T0), null)
  assert.equal(shortWait(T0 + 60 * MIN, 3 * HOUR, cfg(), T0), null)
})

test('betterExpiring: only from an account that is fine, to one whose quota expires (sooner)', () => {
  const steady = candidate(seat('steady', { s: 20, w: 30 }))
  const leaving = candidate(seat('leaving', { s: 10, w: 40, wReset: T0 + 20 * HOUR }))
  const sooner = candidate(seat('sooner', { s: 10, w: 40, wReset: T0 + 10 * HOUR }))
  assert.equal(betterExpiring(steady, [leaving], cfg())?.seat.accountId, 'leaving')
  assert.equal(betterExpiring(steady, [leaving, sooner], cfg())?.seat.accountId, 'sooner')
  // Already on expiring quota: only a sooner one is better.
  assert.equal(betterExpiring(leaving, [steady], cfg()), null)
  assert.equal(betterExpiring(leaving, [sooner], cfg())?.seat.accountId, 'sooner')
  assert.equal(betterExpiring(sooner, [leaving], cfg()), null)
  // Never to an account that is unknown, Low, set aside, or would not last.
  assert.equal(betterExpiring(steady, [{ ...leaving, tier: 'B+' }], cfg()), null)
  assert.equal(betterExpiring(steady, [candidate(seat('low', { s: 98, w: 40, wReset: T0 + 20 * HOUR }))], cfg()), null)
  assert.equal(betterExpiring(steady, [{ ...leaving, avoided: true }], cfg()), null)
  assert.equal(betterExpiring(steady, [{ ...leaving, projectedMs: 10 * MIN }], cfg()), null)
  // A Low or Out account has its own rules.
  assert.equal(betterExpiring(candidate(seat('low', { s: 98, w: 30 })), [leaving], cfg()), null)
  // With an order set, never to an account further down it.
  assert.equal(betterExpiring({ ...steady, chainIndex: 0 }, [{ ...leaving, chainIndex: 1 }], cfg()), null)
  assert.equal(betterExpiring({ ...steady, chainIndex: 1 }, [{ ...leaving, chainIndex: 0 }], cfg())?.seat.accountId, 'leaving')
})

test('assess: a pace from readings too old to forecast with does not hide a nearly full window', () => {
  // The readings stopped 11 minutes ago (the pane went quiet): no runway, yet the last half
  // hour still shows a pace. The level then decides, as it does with no pace at all.
  const stale = rising([80, 84, 88, 92], T0)
  const now = T0 + 11 * MIN
  const full = seat('a', { s: 98, w: 20, source: 'cached' })
  const a = assess(full, undefined, stale, cfg(), now)
  assert.equal(a.runwayMs, null)
  assert.ok(a.rate.s !== null)
  assert.equal(a.state, 'low')
  assert.deepEqual(a.low, { window: 's', by: 'level' })
  assert.equal(shouldLeave(full, undefined, stale, cfg(), now).leave, true)
  // The week likewise.
  const week = assess(seat('a', { s: 30, w: 99.5, source: 'cached' }), undefined, stale.map((x, i) => ({ ...x, s: 30, w: 96 + i })), cfg(), now)
  assert.deepEqual(week.low, { window: 'w', by: 'level' })
  // With room it stays OK, and a fresh pace still decides by itself: 97 % at a crawl is not Low.
  assert.equal(assess(seat('a', { s: 60, w: 20, source: 'cached' }), undefined, stale, cfg(), now).state, 'ok')
  const slow = rising([95, 96, 97], T0, 10).map((x) => ({ ...x, sReset: T0 + 20 * MIN }))
  assert.equal(assess(seat('a', { s: 97, w: 20, sReset: T0 + 20 * MIN }), undefined, slow, cfg(), T0).state, 'ok')
})
