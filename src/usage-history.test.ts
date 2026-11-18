// The usage history: samples, the pace they give, the runway, and its bounds.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import type { Cli, Rotator } from './engine'
import { accountList } from './fixtures'
import { levelWords, runwayWords, whyMove } from './labels'
import { memoryFiles } from './statusline-files'
import type { RotatorState, Seat } from './types'
import {
  DAILY_CAP,
  RECENT_CAP,
  addSample,
  emptyUsageSamples,
  loadedUsageSamples,
  pruneSamples,
  rateOf,
  runwayMs,
  sampleOf,
  type Sample,
  type UsageSamples
} from './usage-history'
import { activateWith } from './worker'

const T0 = 1_800_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const KEY = 'claude:c1'
const S_RESET = T0 + 4 * HOUR
const W_RESET = T0 + 3 * DAY

type Reading = { s?: number; w?: number; m?: number; sReset?: number | null; wReset?: number | null; source?: Seat['usage']['source']; origin?: 'pane' }
function seatAt(at: number | undefined, r: Reading): Pick<Seat, 'key' | 'usage'> {
  const usage: Seat['usage'] = { known: true, source: r.source ?? 'live' }
  if (at !== undefined) usage.asOf = at
  if (r.origin) usage.origin = r.origin
  if (r.s !== undefined) usage.session = { usedPercent: r.s, resetsAt: r.sReset === undefined ? S_RESET : r.sReset }
  if (r.w !== undefined) usage.weekly = { usedPercent: r.w, resetsAt: r.wReset === undefined ? W_RESET : r.wReset }
  if (r.m !== undefined) usage.model = { name: 'fable', usedPercent: r.m, resetsAt: W_RESET }
  return { key: KEY, usage }
}
/** Feeds readings `[minutes after T0, reading]` and returns the account's samples. */
function fed(readings: [number, Reading][], history: UsageSamples = emptyUsageSamples()): Sample[] {
  for (const [minute, r] of readings) addSample(history, seatAt(T0 + minute * MIN, r), T0 + minute * MIN)
  return history.seats[KEY]?.recent ?? []
}
const near = (actual: number | null, expected: number, tolerance = 1e-9) =>
  assert.ok(actual !== null && Math.abs(actual - expected) <= tolerance, `${actual} is not ${expected}`)

test('a sample is the reading as taken: its time, both windows, the model bucket, who took it', () => {
  assert.deepEqual(sampleOf(seatAt(T0 - 5_000, { s: 40, w: 20, m: 30 }), T0), { t: T0 - 5_000, s: 40, w: 20, sReset: S_RESET, wReset: W_RESET, m: 30, mReset: W_RESET, src: 'orca' })
  assert.equal(sampleOf(seatAt(T0, { s: 40, w: 20, origin: 'pane' }), T0)?.src, 'pane')
  // No stamp: taken now. A stamp ahead of the clock is not kept ahead.
  assert.equal(sampleOf(seatAt(undefined, { s: 40 }), T0)?.t, T0)
  assert.equal(sampleOf(seatAt(T0 + MIN, { s: 40 }), T0)?.t, T0)
  // Remembered, projected and unknown numbers are not readings.
  assert.equal(sampleOf(seatAt(T0, { s: 40, source: 'cached' }), T0), null)
  assert.equal(sampleOf(seatAt(T0, { s: 0, source: 'projected' }), T0), null)
  assert.equal(sampleOf({ usage: { known: false, source: 'unknown' } }, T0), null)
  assert.equal(sampleOf({ usage: { known: true, source: 'live' } }, T0), null)
})

test('a sample is added when a value changes, or every 5 minutes otherwise', () => {
  const history = emptyUsageSamples()
  const add = (minute: number, r: Reading) => addSample(history, seatAt(T0 + minute * MIN, r), T0 + minute * MIN)
  assert.equal(add(0, { s: 40, w: 20 }), true)
  assert.equal(add(1, { s: 40, w: 20 }), false, 'unchanged a minute later')
  assert.equal(add(4.9, { s: 40, w: 20 }), false)
  assert.equal(add(5, { s: 40, w: 20 }), true, 'unchanged, 5 minutes on')
  assert.equal(add(6, { s: 41, w: 20 }), true, 'a value changed')
  assert.equal(add(6, { s: 42, w: 20 }), false, 'no newer than the last sample')
  assert.equal(add(5.5, { s: 43, w: 20 }), false, 'older than the last sample')
  assert.deepEqual(history.seats[KEY]!.recent.map((x) => [(x.t - T0) / MIN, x.s]), [[0, 40], [5, 40], [6, 41]])
  // Numbers that are not a reading add nothing, and make no entry.
  const other = emptyUsageSamples()
  assert.equal(addSample(other, seatAt(T0, { s: 40, source: 'cached' }), T0), false)
  assert.deepEqual(other.seats, {})
})

test('rate: the slope of the current window over the last 30 minutes, in points per minute', () => {
  const samples = fed([[0, { s: 40, w: 20 }], [5, { s: 45, w: 20 }], [10, { s: 50, w: 21 }]])
  near(rateOf(samples, 's', T0 + 10 * MIN), 1)
  near(rateOf(samples, 'w', T0 + 10 * MIN), 0.1)
  // Only the last 30 minutes count: 20 min later the first sample is out.
  const long = fed([[0, { s: 10 }], [20, { s: 50 }], [40, { s: 52 }], [45, { s: 53 }]])
  near(rateOf(long, 's', T0 + 45 * MIN), 3 / 25)
  // Long after the last sample there is nothing recent to go by.
  assert.equal(rateOf(samples, 's', T0 + 45 * MIN), null)
  // The model bucket has a pace of its own.
  const model = fed([[0, { s: 1, m: 60 }], [6, { s: 1, m: 63 }]])
  near(rateOf(model, 'm', T0 + 6 * MIN), 0.5)
  assert.equal(rateOf(model, 's', T0 + 6 * MIN), null)
})

test('rate: too few samples, too close together, or no rise give null', () => {
  assert.equal(rateOf([], 's', T0), null)
  assert.equal(rateOf(fed([[0, { s: 40 }]]), 's', T0), null, 'one sample')
  assert.equal(rateOf(fed([[0, { s: 40 }], [2.9, { s: 45 }]]), 's', T0 + 3 * MIN), null, 'under 3 minutes apart')
  near(rateOf(fed([[0, { s: 40 }], [3, { s: 41 }]]), 's', T0 + 3 * MIN), 1 / 3)
  assert.equal(rateOf(fed([[0, { s: 40 }], [5, { s: 40.9 }]]), 's', T0 + 5 * MIN), null, 'under a point')
  assert.equal(rateOf(fed([[0, { s: 40 }], [5, { s: 40 }], [10, { s: 40 }]]), 's', T0 + 10 * MIN), null, 'flat')
  assert.equal(rateOf(fed([[0, { w: 40 }], [5, { w: 45 }]]), 's', T0 + 5 * MIN), null, 'no such window')
})

test('when a window\'s reset time changes its samples are dropped; the other window keeps its own', () => {
  const history = emptyUsageSamples()
  fed([[0, { s: 90, w: 20 }], [5, { s: 95, w: 21 }], [10, { s: 99, w: 22 }]], history)
  near(rateOf(history.seats[KEY]!.recent, 's', T0 + 10 * MIN), 0.9)
  // A new 5-hour window: usage starts over with another reset time.
  const samples = fed([[15, { s: 2, w: 23, sReset: S_RESET + 5 * HOUR }]], history)
  assert.deepEqual(samples.map((x) => x.s), [null, null, null, 2])
  assert.deepEqual(samples.map((x) => x.sReset), [null, null, null, S_RESET + 5 * HOUR])
  assert.deepEqual(samples.map((x) => x.w), [20, 21, 22, 23])
  assert.equal(rateOf(samples, 's', T0 + 15 * MIN), null, 'the old window says nothing about the new one')
  near(rateOf(samples, 'w', T0 + 15 * MIN), 0.2)
  // The pace of the new window builds up from its own samples.
  near(rateOf(fed([[20, { s: 7, w: 23, sReset: S_RESET + 5 * HOUR }]], history), 's', T0 + 20 * MIN), 1)
  // A reset time that moves by under a minute is the same window (Orca and Claude round differently).
  const jitter = fed([[0, { s: 10 }], [5, { s: 15, sReset: S_RESET + 30_000 }]])
  assert.deepEqual(jitter.map((x) => x.s), [10, 15])
  near(rateOf(jitter, 's', T0 + 5 * MIN), 1)
  // Usage that falls is a new window even when the reset time is unknown; a point of rounding is not.
  assert.deepEqual(fed([[0, { s: 80, sReset: null }], [5, { s: 3, sReset: null }]]).map((x) => x.s), [3])
  assert.deepEqual(fed([[0, { s: 80.4 }], [5, { s: 80 }]]).map((x) => x.s), [80.4, 80])
  // Samples left with no window at all go; the model bucket is dropped the same way.
  assert.deepEqual(fed([[0, { s: 80 }], [5, { s: 1, sReset: S_RESET + 5 * HOUR }]]).map((x) => x.s), [1])
  const model = fed([[0, { s: 5, m: 90 }], [5, { s: 6, m: 2 }]])
  assert.deepEqual(model.map((x) => [x.s, x.m]), [[5, undefined], [6, 2]])
  // The daily weekly levels are kept across a weekly reset, each with its window's reset time.
  const weekly = emptyUsageSamples()
  fed([[0, { w: 90 }], [24 * 60, { w: 4, wReset: W_RESET + 7 * DAY }]], weekly)
  assert.deepEqual(weekly.seats[KEY]!.recent.map((x) => x.w), [4])
  assert.deepEqual(weekly.seats[KEY]!.daily.map((d) => [d.w, d.wReset]), [[90, W_RESET], [4, W_RESET + 7 * DAY]])
})

test('storage limits: 48 recent samples, 14 daily levels, and samples never closer than the rate needs', () => {
  const history = emptyUsageSamples()
  // A reading every 5 minutes for 6 hours.
  for (let i = 0; i <= 72; i++) addSample(history, seatAt(T0 + i * 5 * MIN, { s: Math.min(100, i), w: 10, sReset: T0 + 9 * HOUR }), T0 + i * 5 * MIN)
  const recent = history.seats[KEY]!.recent
  assert.equal(recent.length, RECENT_CAP)
  assert.equal(RECENT_CAP, 48)
  assert.equal(recent[recent.length - 1]!.s, 72)
  assert.equal(recent[0]!.s, 72 - 47, 'the oldest go first')
  // A value that changes every 20 seconds does not crowd the history: the kept samples still span
  // far more than the 30 minutes a rate looks back.
  const busy = emptyUsageSamples()
  for (let i = 0; i < 600; i++) addSample(busy, seatAt(T0 + i * 20_000, { s: i / 10, w: 10 }), T0 + i * 20_000)
  const kept = busy.seats[KEY]!.recent
  assert.equal(kept.length, RECENT_CAP)
  assert.equal(kept[kept.length - 1]!.s, 59.9, 'the newest reading is always there')
  assert.ok(kept[kept.length - 1]!.t - kept[0]!.t >= 60 * MIN, `${(kept[kept.length - 1]!.t - kept[0]!.t) / MIN} min`)
  near(rateOf(kept, 's', T0 + 599 * 20_000), 0.3, 0.01)
  // One weekly level per UTC day, the day's last; 14 days at most.
  const days = emptyUsageSamples()
  for (let d = 0; d < 20; d++) {
    for (const hour of [1, 13]) addSample(days, seatAt(T0 + d * DAY + hour * HOUR, { w: Math.min(100, d * 5 + hour / 13), wReset: T0 + 30 * DAY }), T0 + d * DAY + hour * HOUR)
  }
  const daily = days.seats[KEY]!.daily
  assert.equal(daily.length, DAILY_CAP)
  assert.equal(DAILY_CAP, 14)
  assert.deepEqual(daily.map((x) => x.w), Array.from({ length: 14 }, (_, i) => Math.min(100, (i + 6) * 5 + 1)))
  assert.equal(new Set(daily.map((x) => x.day)).size, 14)
  // About 4 KB per account, as planned.
  assert.ok(JSON.stringify(history.seats[KEY]).length < 6_000, String(JSON.stringify(history.seats[KEY]).length))
})

test('accounts that are no longer listed are pruned; a stored history of another shape starts empty', () => {
  const history = emptyUsageSamples()
  addSample(history, seatAt(T0, { s: 1 }), T0)
  addSample(history, { ...seatAt(T0, { s: 1 }), key: 'claude:gone' }, T0)
  assert.equal(pruneSamples(history, [KEY, 'claude:new']), true)
  assert.deepEqual(Object.keys(history.seats), [KEY])
  assert.equal(pruneSamples(history, [KEY]), false)
  assert.deepEqual(loadedUsageSamples(JSON.parse(JSON.stringify(history))), history)
  assert.deepEqual(loadedUsageSamples(null), emptyUsageSamples())
  assert.deepEqual(loadedUsageSamples({ v: 2, seats: { x: {} } }), emptyUsageSamples())
  assert.deepEqual(loadedUsageSamples({ v: 1, seats: { a: [1, 2], b: { recent: 'x', daily: [] }, c: { recent: [{ t: 1, s: 1 }, null, 'x'], daily: [{ day: 1 }] } } }).seats, { c: { recent: [{ t: 1, s: 1 }], daily: [] } })
  // A longer stored list than the caps is cut on load.
  const long = { v: 1, seats: { a: { recent: Array.from({ length: 80 }, (_, i) => ({ t: i, s: 1, w: 1, sReset: null, wReset: null, src: 'orca' })), daily: [] } } }
  assert.equal(loadedUsageSamples(long).seats.a!.recent.length, RECENT_CAP)
})

test('runway: the first window to run out at the current pace', () => {
  // 5h: 90 % and rising 1 point a minute → 10 minutes. Weekly rises too, far slower.
  const samples = fed([[0, { s: 80, w: 50 }], [5, { s: 85, w: 50.5 }], [10, { s: 90, w: 51 }]])
  near(runwayMs(samples, T0 + 10 * MIN), 10 * MIN, 1)
  // Time passed since the reading comes off.
  near(runwayMs(samples, T0 + 14 * MIN), 6 * MIN, 1)
  // The weekly window is the tighter one here.
  const weekly = fed([[0, { s: 10, w: 95 }], [10, { s: 11, w: 97 }]])
  near(runwayMs(weekly, T0 + 10 * MIN), 15 * MIN, 1)
  // Already at 100 %: nothing left.
  assert.equal(runwayMs(fed([[0, { s: 95 }], [5, { s: 100 }]]), T0 + 5 * MIN), 0)
})

test('runway: a window that resets before it runs out does not count; no pace or an old reading give null', () => {
  // 5h would run out in 50 min but resets in 20: only the weekly window counts (490 min).
  const resets = fed([[0, { s: 40, w: 50, sReset: T0 + 30 * MIN }], [10, { s: 50, w: 51, sReset: T0 + 30 * MIN }]])
  near(runwayMs(resets, T0 + 10 * MIN), 490 * MIN, 1)
  // …and with no weekly pace either there is no runway.
  assert.equal(runwayMs(fed([[0, { s: 40, sReset: T0 + 30 * MIN }], [10, { s: 50, sReset: T0 + 30 * MIN }]]), T0 + 10 * MIN), null)
  // A reset time that is not known cannot rule the window out.
  near(runwayMs(fed([[0, { s: 40, sReset: null }], [10, { s: 50, sReset: null }]]), T0 + 10 * MIN), 50 * MIN, 1)
  assert.equal(runwayMs([], T0), null)
  assert.equal(runwayMs(fed([[0, { s: 90 }]]), T0), null, 'one sample')
  assert.equal(runwayMs(fed([[0, { s: 90 }], [5, { s: 90 }]]), T0 + 5 * MIN), null, 'flat')
  // A reading more than 10 minutes old gives no runway.
  const old = fed([[0, { s: 80 }], [10, { s: 90 }]])
  near(runwayMs(old, T0 + 20 * MIN), 0, 1)
  assert.equal(runwayMs(old, T0 + 20 * MIN + 1), null)
})

test('runway: a window whose reset time has passed since the last reading does not count', () => {
  // 95 % and a point a minute: used up at minute 10, two minutes before the window resets.
  const samples = fed([[0, { s: 90, sReset: T0 + 12 * MIN }], [5, { s: 95, sReset: T0 + 12 * MIN }]])
  near(runwayMs(samples, T0 + 8 * MIN), 2 * MIN, 1)
  near(runwayMs(samples, T0 + 11 * MIN), 0, 1)
  // Once the reset has passed the window is a new one: the old pace says nothing about it, and
  // the account is not "out of room" for the minutes until its next reading.
  assert.equal(runwayMs(samples, T0 + 12 * MIN), null)
  assert.equal(runwayMs(samples, T0 + 14 * MIN), null)
  // The other window still counts.
  const both = fed([[0, { s: 90, w: 50, sReset: T0 + 12 * MIN }], [5, { s: 95, w: 51, sReset: T0 + 12 * MIN }]])
  near(runwayMs(both, T0 + 14 * MIN), (49 / 0.2 - 9) * MIN, 1)
})

test('wording: the runway, an account\'s level, and the reason for a move', () => {
  assert.equal(runwayWords(8.4 * MIN), 'about 8 min left at this pace')
  assert.equal(runwayWords(90 * MIN), 'about 90 min left at this pace')
  assert.equal(runwayWords(200 * MIN), 'about 3 h left at this pace')
  assert.equal(runwayWords(20_000), 'under a minute left at this pace')
  const work = { label: 'work', usage: { known: true, session: { usedPercent: 96.6, resetsAt: null }, weekly: { usedPercent: 40, resetsAt: null } } }
  const personal = { label: 'personal', usage: { known: true, session: { usedPercent: 12, resetsAt: null } } }
  const blank = { label: 'spare', usage: { known: false } }
  assert.equal(levelWords(work), 'used 97 % of 5h, 40 % of the week')
  assert.equal(levelWords(blank), '')
  assert.equal(whyMove('threshold', work, personal), 'work is over its usage threshold (used 97 % of 5h, 40 % of the week); moved to personal (used 12 % of 5h)')
  assert.equal(whyMove('rate_limit', work, blank), 'work hit a usage limit; moved to spare')
  assert.equal(whyMove('rate_limit', undefined, personal), 'another account hit a usage limit; moved to personal (used 12 % of 5h)')
  assert.equal(whyMove('model_cap', work, personal, { model: 'fable' }), 'work hit its fable limit; moved to personal (used 12 % of 5h)')
  assert.equal(whyMove('idle', work, personal), 'idle session on work, which is over its usage threshold (used 97 % of 5h, 40 % of the week); moved to personal (used 12 % of 5h)')
  assert.equal(whyMove('switch_back', personal, work), 'work is available again (used 97 % of 5h, 40 % of the week); moved back from personal')
  assert.equal(whyMove('switch_back', personal, blank, { selectionOnly: true }), 'spare is available again; new launches use it')
  assert.equal(whyMove('reset', work, personal), 'a limit has reset; resumed on personal (used 12 % of 5h)')
  assert.equal(whyMove('manual', work, personal, { selectionOnly: true }), 'chosen by hand; new launches use personal (used 12 % of 5h)')
  assert.equal(whyMove('auth', work, personal, { selectionOnly: true }), 'work needs sign-in; new launches use personal (used 12 % of 5h)')
})

// ---- through the worker -----------------------------------------------------------------------

async function mount(options: { usage: () => { session: number; weekly: number }; now: () => number; storage?: Record<string, never>; settings?: Record<string, string | number | boolean> }) {
  const calls: string[] = []
  const cli: Cli = {
    async listAccounts() {
      calls.push('list')
      return accountList({ claudeActive: 'c1', claudeUsage: { ...options.usage(), sessionReset: S_RESET, weeklyReset: W_RESET }, updatedAt: options.now() })
    },
    async select(provider, accountId) {
      calls.push(`select ${provider} ${accountId}`)
    },
    async closeTerminal() {},
    async sendText() {},
    async git() {
      return ''
    },
    async draft() {
      return ''
    }
  }
  const host = mockHost({
    settings: options.settings ?? {},
    storage: options.storage ?? {},
    results: { 'agents.list': { agents: [] }, 'workspace.list': { workspaces: [], truncated: false }, 'statusBar.update': { ok: true }, 'notifications.show': { delivered: true } }
  })
  const files = memoryFiles('/home/u')
  let rotator!: Rotator
  const worker = await mountWorker(
    { default: async (orca: OrcaWorkerApi) => void (rotator = await activateWith(orca, { cli, now: options.now, sleep: async () => undefined }, { tick: false, files })) },
    { host }
  )
  return { calls, files, host, worker, rotator: () => rotator }
}

test('worker: every usage read adds to the history, kept under its own storage key, and the snapshot carries the runway', async () => {
  let clock = T0
  let used = 80
  const m = await mount({ usage: () => ({ session: used, weekly: 30 }), now: () => clock })
  try {
    await m.rotator().accounts(true)
    assert.equal(m.rotator().snapshot().seats.find((s) => s.key === KEY)?.runwayMs, undefined, 'one reading is no pace')
    for (const next of [85, 90]) {
      clock += 5 * MIN
      used = next
      await m.rotator().accounts(true)
    }
    const stored = m.host.data().storage['usage-samples'] as unknown as UsageSamples
    assert.equal(stored.v, 1)
    assert.deepEqual(stored.seats[KEY]!.recent.map((x) => [x.s, x.w, x.src]), [[80, 30, 'orca'], [85, 30, 'orca'], [90, 30, 'orca']])
    assert.equal(stored.seats[KEY]!.daily.length, 1)
    // Accounts without a reading have no history; nothing of it is in the rotator's state.
    assert.equal(stored.seats['claude:c2'], undefined)
    assert.ok(!JSON.stringify(m.host.data().storage.state ?? {}).includes('recent'))
    assert.ok(!('samples' in ((m.host.data().storage.state ?? {}) as RotatorState)))
    // 90 % and a point a minute: about 10 minutes, in the snapshot the panel gets.
    const snap = await m.worker.request('rotator.snapshot', {})
    near(snap.seats.find((s) => s.key === KEY)?.runwayMs ?? null, 10 * MIN, 1)
    assert.equal(snap.seats.find((s) => s.key === 'claude:c2')?.runwayMs, undefined)
    // Observe only: no switch came of it.
    assert.ok(m.calls.every((c) => c === 'list'), m.calls.join(','))
  } finally {
    await m.worker.deactivate()
  }
})

test('worker: the history survives a restart, is read while paused, and is fed by a pane\'s own reading', async () => {
  let clock = T0
  const first = await mount({ usage: () => ({ session: 50, weekly: 30 }), now: () => clock })
  await first.rotator().accounts(true)
  const stored = first.host.data().storage['usage-samples']
  await first.worker.deactivate()

  clock = T0 + 5 * MIN
  const second = await mount({ usage: () => ({ session: 60, weekly: 30 }), now: () => clock, storage: { 'usage-samples': stored as never }, settings: { service_claude: false } })
  try {
    await second.rotator().setPaused(true)
    await second.rotator().accounts(true)
    near(second.rotator().snapshot().seats.find((s) => s.key === KEY)?.runwayMs ?? null, 20 * MIN, 1)
    // c2 is not in use: only its panes report it.
    const sec = (ms: number) => Math.floor(ms / 1000)
    const live = (at: number, s: number) =>
      second.files.files.set('/home/u/.orca/account-rotator/live/claude-c2.tsv', `1\t${sec(at)}\t${s}\t${sec(S_RESET)}\t10\t${sec(W_RESET)}\n`)
    live(clock, 70)
    await second.rotator().accounts(true)
    clock += 5 * MIN
    live(clock, 80)
    await second.rotator().accounts(true)
    const history = second.host.data().storage['usage-samples'] as unknown as UsageSamples
    assert.deepEqual(history.seats['claude:c2']!.recent.map((x) => [x.s, x.src]), [[70, 'pane'], [80, 'pane']])
    near(second.rotator().snapshot().seats.find((s) => s.key === 'claude:c2')?.runwayMs ?? null, 10 * MIN, 1)
    assert.ok(second.calls.every((c) => c === 'list'), second.calls.join(','))
  } finally {
    await second.worker.deactivate()
  }
})
