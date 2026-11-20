// Per-pane live usage: the file format, the cache rules for pane readings, and the path through
// the worker (which account a file belongs to, and that reading it is passive).
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { parseAccounts } from './accounts'
import type { Cli, Rotator } from './engine'
import { accountList, likeOrca } from './fixtures'
import { LIVE_KEY, liveFileName, liveKeyOfHome, parseLive } from './live-usage'
import { memoryFiles } from './statusline-files'
import type { Seat } from './types'
import { emptyUsageCache, observe, observeLive, resolve } from './usage-cache'
import { activateWith } from './worker'

const T0 = 1_800_000_000_000
const SEC = Math.floor(T0 / 1000)
const MIN = 60_000
const HOUR = 3_600_000
const WEEK = 7 * 24 * HOUR
const row = (stamp: number | string, s: number | string, sReset: number | string, w: number | string, wReset: number | string, v: number | string = 1) =>
  [v, stamp, s, sReset, w, wReset].join('\t') + '\n'

test('parseLive: a reading with its stamp and both windows, reset times in ms', () => {
  assert.deepEqual(parseLive(row(SEC - 30, 85.2, SEC + 7200, 19.9, SEC + 99999), T0), {
    asOf: T0 - 30_000,
    session: { usedPercent: 85.2, resetsAt: T0 + 7200_000 },
    weekly: { usedPercent: 19.9, resetsAt: T0 + 99_999_000 }
  })
  // One window, or a window without a reset time.
  assert.deepEqual(parseLive(row(SEC, 12, '-', '-', '-'), T0), { asOf: T0, session: { usedPercent: 12, resetsAt: null } })
  assert.deepEqual(parseLive(row(SEC, '-', '-', 0, SEC + 60), T0), { asOf: T0, weekly: { usedPercent: 0, resetsAt: T0 + 60_000 } })
  // A stamp slightly ahead (clock steps) is fine; no trailing newline is fine.
  assert.equal(parseLive(row(SEC + 299, 1, '-', 1, '-').trim(), T0)?.asOf, T0 + 299_000)
})

test('parseLive: rejects another version, bad numbers, percentages outside 0-100 and a stamp from the future', () => {
  const ok = [SEC, 50, SEC + 60, 50, SEC + 600] as const
  assert.ok(parseLive(row(...ok), T0))
  assert.equal(parseLive(row(...ok, 2), T0), null, 'version 2')
  assert.equal(parseLive(row(...ok, ''), T0), null, 'no version')
  assert.equal(parseLive(row(SEC, 100.1, SEC + 60, 50, SEC + 600), T0), null, 'over 100')
  assert.equal(parseLive(row(SEC, 50, SEC + 60, 101, SEC + 600), T0), null, 'weekly over 100')
  assert.equal(parseLive(row(SEC, '-5', SEC + 60, 50, SEC + 600), T0), null, 'negative')
  assert.equal(parseLive(row(SEC, 'NaN', SEC + 60, 50, SEC + 600), T0), null, 'not a number')
  assert.equal(parseLive(row(SEC, 50, 'soon', 50, SEC + 600), T0), null, 'bad reset')
  assert.equal(parseLive(row(SEC, '1e2', SEC + 60, 50, SEC + 600), T0), null, 'exponent')
  assert.equal(parseLive(row(SEC + 301, 50, SEC + 60, 50, SEC + 600), T0), null, 'stamp more than 5 min ahead')
  assert.equal(parseLive(row('-', 50, SEC + 60, 50, SEC + 600), T0), null, 'no stamp')
  assert.equal(parseLive(row(SEC, '-', SEC + 60, '-', SEC + 600), T0), null, 'no percentage at all')
  assert.equal(parseLive(`1\t${SEC}\t50\t${SEC + 60}\t50\n`, T0), null, 'a field short')
  assert.equal(parseLive(`1\t${SEC}\t50\t${SEC + 60}\t50\t${SEC + 600}\textra\n`, T0), null, 'a field too many')
  assert.equal(parseLive('', T0), null)
  assert.equal(parseLive(null, T0), null)
  assert.equal(parseLive('{"session":50}', T0), null)
})

test('parseLive: a window whose reset time has passed counts as reset (0 %)', () => {
  const r = parseLive(row(SEC - 3600, 97, SEC - 60, 40, SEC + 600), T0)
  assert.deepEqual(r?.session, { usedPercent: 0, resetsAt: null, reset: true })
  assert.deepEqual(r?.weekly, { usedPercent: 40, resetsAt: T0 + 600_000 })
})

test('live keys: the profile id of an account home, nothing else', () => {
  assert.equal(liveKeyOfHome('/Users/u/Library/Application Support/orca/claude-profiles/abc-123_x.y/home'), 'abc-123_x.y')
  assert.equal(liveKeyOfHome('C:\\Users\\u\\orca\\claude-profiles\\abc\\home'), 'abc')
  assert.equal(liveKeyOfHome('/home/u/.claude'), undefined)
  assert.equal(liveKeyOfHome('/x/claude-profiles/bad id/home'), undefined)
  assert.equal(liveKeyOfHome('/x/claude-profiles/../home'), undefined)
  assert.equal(liveKeyOfHome('/x/claude-profiles/abc'), undefined)
  assert.equal(liveKeyOfHome(undefined), undefined)
  assert.equal(LIVE_KEY.test('system'), true)
  assert.equal(LIVE_KEY.test('a/b'), false)
  assert.equal(LIVE_KEY.test('..'), false)
  assert.equal(liveFileName('system'), 'claude-system.tsv')
})

test('accounts: each Claude account maps to its profile, the system login to `system`, a twin to both', () => {
  // c3 is the same person as the system login, so it has no system seat and carries both keys.
  const twin = parseAccounts(accountList()).seats
  assert.deepEqual(twin.filter((s) => s.provider === 'claude').map((s) => [s.key, s.liveKeys]), [
    ['claude:c1', ['c1']],
    ['claude:c2', ['c2']],
    ['claude:c3', ['c3', 'system']]
  ])
  assert.ok(twin.filter((s) => s.provider !== 'claude').every((s) => s.liveKeys === undefined), 'Claude only')
  // A system login of its own.
  const own = accountList()
  own.claude.systemDefaultEmail = 'fourth@example.test'
  const seats = parseAccounts(own).seats
  assert.deepEqual(seats.find((s) => s.key === 'claude:system')?.liveKeys, ['system'])
  assert.deepEqual(seats.find((s) => s.key === 'claude:c3')?.liveKeys, ['c3'])
  // No home, or one that is no profile dir: no key. The path itself is on no seat.
  const bare = accountList()
  delete bare.claude.accounts[0].home
  bare.claude.accounts[1].home = '/somewhere/else'
  const none = parseAccounts(bare).seats
  assert.equal(none.find((s) => s.key === 'claude:c1')?.liveKeys, undefined)
  assert.equal(none.find((s) => s.key === 'claude:c2')?.liveKeys, undefined)
  assert.ok(!JSON.stringify(twin).includes('claude-profiles'))
})

// ---- cache rules ------------------------------------------------------------------------------

const KEY = 'claude:c2'
const seat = (usage: Seat['usage'], over: Partial<Seat> = {}): Seat => ({ key: KEY, provider: 'claude', accountId: 'c2', label: 'two', active: false, usage, ...over })
const nothing = () => seat({ known: false, source: 'unknown', reason: 'stale-token' })
const orca = (session: number, weekly: number, at: number, model?: number) =>
  seat({
    known: true,
    source: 'live',
    updatedAt: at,
    session: { usedPercent: session, resetsAt: T0 + HOUR },
    weekly: { usedPercent: weekly, resetsAt: T0 + 24 * HOUR },
    ...(model === undefined ? {} : { model: { name: 'fable', usedPercent: model, resetsAt: T0 + 24 * HOUR } })
  })
const pane = (session: number, weekly: number, at: number, resets = { s: T0 + HOUR, w: T0 + 24 * HOUR }) => ({
  asOf: at,
  session: { usedPercent: session, resetsAt: resets.s },
  weekly: { usedPercent: weekly, resetsAt: resets.w }
})

test('a pane reading fills in an account Orca has nothing for: live for 10 minutes, remembered after', () => {
  const cache = emptyUsageCache()
  assert.equal(observeLive(cache, KEY, pane(40, 20, T0), T0), true)
  assert.equal(cache.seats[KEY]?.origin, 'pane')
  const fresh = resolve(nothing(), cache, T0 + 10 * MIN, WEEK, {})
  assert.equal(fresh.source, 'live')
  assert.equal(fresh.origin, 'pane')
  assert.equal(fresh.known, true)
  assert.equal(fresh.asOf, T0)
  assert.equal(fresh.session?.usedPercent, 40)
  assert.equal(fresh.reason, 'stale-token', "Orca's reason is kept")
  const older = resolve(nothing(), cache, T0 + 10 * MIN + 1, WEEK, {})
  assert.equal(older.source, 'cached')
  assert.equal(older.origin, 'pane')
  // Past its reset the remembered window counts as reset, like any remembered reading.
  assert.equal(resolve(nothing(), cache, T0 + 2 * HOUR, WEEK, {}).source, 'projected')
  // With the cache off, a pane reading still counts while it is live, and not after.
  assert.equal(resolve(nothing(), cache, T0 + 5 * MIN, 0, {}).source, 'live')
  assert.equal(resolve(nothing(), cache, T0 + 11 * MIN, 0, {}).known, false)
})

test('a pane reading replaces session and weekly and keeps Orca\'s model bucket', () => {
  const cache = emptyUsageCache()
  observe(cache, [orca(30, 10, T0, 55)], T0, {})
  assert.equal(observeLive(cache, KEY, pane(45, 12, T0 + MIN), T0 + MIN), true)
  const u = resolve(nothing(), cache, T0 + 2 * MIN, WEEK, {})
  assert.deepEqual([u.session?.usedPercent, u.weekly?.usedPercent], [45, 12])
  assert.deepEqual(u.model, { name: 'fable', usedPercent: 55, resetsAt: T0 + 24 * HOUR })
  // A reading with one window leaves the other as it was.
  observeLive(cache, KEY, { asOf: T0 + 3 * MIN, session: { usedPercent: 50, resetsAt: T0 + HOUR } }, T0 + 3 * MIN)
  assert.deepEqual([cache.seats[KEY]?.session?.usedPercent, cache.seats[KEY]?.weekly?.usedPercent], [50, 12])
})

test('within one window usage never goes down; a new window starts over', () => {
  const cache = emptyUsageCache()
  observeLive(cache, KEY, pane(60, 30, T0), T0)
  // A quieter pane of the same account reports older numbers later (reset time within a minute).
  assert.equal(observeLive(cache, KEY, pane(40, 25, T0 + MIN, { s: T0 + HOUR + 59_000, w: T0 + 24 * HOUR - 59_000 }), T0 + MIN), true)
  assert.deepEqual([cache.seats[KEY]?.session?.usedPercent, cache.seats[KEY]?.weekly?.usedPercent], [60, 30])
  assert.equal(cache.seats[KEY]?.asOf, T0 + MIN)
  // Higher in the same window: taken.
  observeLive(cache, KEY, pane(61, 30, T0 + 2 * MIN), T0 + 2 * MIN)
  assert.equal(cache.seats[KEY]?.session?.usedPercent, 61)
  // The same holds against Orca's own reading of that window.
  const mixed = emptyUsageCache()
  observe(mixed, [orca(70, 30, T0)], T0, {})
  observeLive(mixed, KEY, pane(50, 30, T0 + MIN), T0 + MIN)
  assert.equal(mixed.seats[KEY]?.session?.usedPercent, 70)
  // Another reset time is another window: lower numbers are right.
  observeLive(cache, KEY, pane(3, 31, T0 + 3 * MIN, { s: T0 + 6 * HOUR, w: T0 + 24 * HOUR }), T0 + 3 * MIN)
  assert.deepEqual(cache.seats[KEY]?.session, { usedPercent: 3, resetsAt: T0 + 6 * HOUR })
  // A pane that only knows an ended window does not undo the current one.
  observeLive(cache, KEY, { asOf: T0 + 4 * MIN, session: { usedPercent: 0, resetsAt: null, reset: true } }, T0 + 4 * MIN)
  assert.deepEqual(cache.seats[KEY]?.session, { usedPercent: 3, resetsAt: T0 + 6 * HOUR })
  // …but it does replace a window that has in fact ended.
  observeLive(cache, KEY, { asOf: T0 + 7 * HOUR, session: { usedPercent: 0, resetsAt: null, reset: true } }, T0 + 7 * HOUR)
  assert.deepEqual(cache.seats[KEY]?.session, { usedPercent: 0, resetsAt: null, reset: true })
  // A reading no newer than what is remembered changes nothing.
  assert.equal(observeLive(cache, KEY, pane(99, 99, T0), T0 + 7 * HOUR), false)
})

test('resolve takes the newer of Orca\'s reading and the pane\'s', () => {
  const cache = emptyUsageCache()
  // Orca read at T0; the pane wrote a minute later: the pane's numbers, still live.
  const active = { ...orca(30, 10, T0, 55), active: true }
  observe(cache, [active], T0, {})
  observeLive(cache, KEY, pane(42, 11, T0 + MIN), T0 + MIN)
  const viaPane = resolve(active, cache, T0 + 2 * MIN, WEEK, {})
  assert.deepEqual([viaPane.source, viaPane.origin, viaPane.session?.usedPercent, viaPane.asOf], ['live', 'pane', 42, T0 + MIN])
  assert.equal(viaPane.model?.usedPercent, 55)
  // Orca reads again later: its numbers, the pane's are history.
  const later = { ...orca(48, 12, T0 + 5 * MIN, 56), active: true }
  observe(cache, [later], T0 + 5 * MIN, {})
  const viaOrca = resolve(later, cache, T0 + 5 * MIN, WEEK, {})
  assert.deepEqual([viaOrca.source, viaOrca.origin, viaOrca.session?.usedPercent, viaOrca.asOf], ['live', undefined, 48, T0 + 5 * MIN])
  assert.equal(cache.seats[KEY]?.origin, undefined)
  // Orca repeats the same numbers with a newer stamp than the pane's: Orca's reading stands.
  observeLive(cache, KEY, pane(49, 12, T0 + 6 * MIN), T0 + 6 * MIN)
  const repeat = { ...orca(48, 12, T0 + 7 * MIN, 56), active: true }
  observe(cache, [repeat], T0 + 7 * MIN, {})
  assert.equal(resolve(repeat, cache, T0 + 7 * MIN, WEEK, {}).origin, undefined)
  // An Orca reading taken before the pane's leaves the pane's numbers and refreshes the model bucket.
  const lagging = { ...orca(10, 10, T0 + 5.5 * MIN, 60), active: true }
  observe(cache, [lagging], T0 + 8 * MIN, {})
  assert.deepEqual([cache.seats[KEY]?.origin, cache.seats[KEY]?.session?.usedPercent, cache.seats[KEY]?.model?.usedPercent], ['pane', 49, 60])
  // …and repeating that lagging row never makes it look fresh.
  assert.equal(observe(cache, [lagging], T0 + 9 * MIN, {}), false)
})

test('the active-since guard does not apply to a pane reading', () => {
  const cache = emptyUsageCache()
  const since = { claude: T0 + 5_000 }
  // Orca's active slot still holds the previous account's numbers from before the switch.
  const stale = { ...orca(95, 50, T0), active: true }
  assert.equal(resolve(stale, cache, T0 + 6_000, WEEK, since).source, 'unknown')
  // The account's own pane wrote before the switch: that is this account's reading.
  observeLive(cache, KEY, pane(20, 5, T0 - MIN), T0)
  const u = resolve(stale, cache, T0 + 6_000, WEEK, since)
  assert.deepEqual([u.source, u.origin, u.session?.usedPercent], ['live', 'pane', 20])
})

// ---- through the worker -----------------------------------------------------------------------

type Calls = string[]
function cliFor(result: () => Record<string, any>, calls: Calls): Cli {
  return {
    async listAccounts() {
      calls.push('list')
      return result()
    },
    async select(provider, accountId) {
      calls.push(`select ${provider} ${accountId}`)
    },
    async closeTerminal(id) {
      calls.push(`close ${id}`)
    },
    async sendText(id) {
      calls.push(`send ${id}`)
    },
    async git() {
      return ''
    },
    async draft() {
      return ''
    }
  }
}

async function mount(options: { result: () => Record<string, any>; settings?: Record<string, string | number | boolean>; storage?: Record<string, never>; now?: () => number }) {
  const calls: Calls = []
  const files = memoryFiles('/home/u')
  const host = mockHost({
    settings: options.settings ?? {},
    storage: options.storage ?? {},
    results: { 'agents.list': { agents: [] }, 'workspace.list': { workspaces: [], truncated: false }, 'statusBar.update': { ok: true }, 'notifications.show': { delivered: true } }
  })
  let rotator!: Rotator
  const worker = await mountWorker(
    {
      default: async (orca: OrcaWorkerApi) =>
        void (rotator = await activateWith(likeOrca(orca), { cli: cliFor(options.result, calls), now: options.now ?? (() => T0), sleep: async () => undefined }, { tick: false, files }))
    },
    { host }
  )
  const live = (key: string, text: string) => files.files.set(`/home/u/.orca/account-rotator/live/claude-${key}.tsv`, text)
  return { calls, files, host, worker, live, rotator: () => rotator }
}

const usageOf = (seats: readonly Seat[], key: string) => seats.find((s) => s.key === key)!.usage

test('worker: a pane\'s live file gives an account not in use live numbers; the home path goes nowhere', async () => {
  const m = await mount({ result: () => accountList({ claudeActive: 'c1', updatedAt: T0 }) })
  try {
    // Orca has nothing for c2 (it reports usage only for the account in use).
    assert.equal(usageOf((await m.rotator().accounts(true)).seats, 'claude:c2').known, false)
    m.live('c2', row(SEC - 20, 64.5, SEC + 3600, 22, SEC + 86_400))
    const c2 = usageOf((await m.rotator().accounts(true)).seats, 'claude:c2')
    assert.deepEqual([c2.known, c2.source, c2.origin, c2.session?.usedPercent, c2.weekly?.usedPercent, c2.asOf], [true, 'live', 'pane', 64.5, 22, T0 - 20_000])
    // A file for a key no account has, a malformed one and one from the future are ignored.
    m.live('zzz', row(SEC, 1, SEC + 60, 1, SEC + 600))
    m.live('c1', 'not a reading\n')
    m.live('c3', row(SEC + 3600, 99, SEC + 7200, 99, SEC + 86_400))
    const seats = (await m.rotator().accounts(true)).seats
    assert.equal(usageOf(seats, 'claude:c1').origin, undefined)
    assert.equal(usageOf(seats, 'claude:c3').known, false)
    // The snapshot, the stored cache and the stored state carry no home path and no live key.
    const snap = await m.worker.request('rotator.snapshot', {})
    assert.equal(snap.seats.find((s) => s.key === 'claude:c2')?.usage.origin, 'pane')
    assert.ok(snap.seats.every((s) => !('liveKeys' in s) && !('home' in s)))
    const stored = JSON.stringify([snap, m.host.data().storage])
    assert.ok(!stored.includes('claude-profiles') && !stored.includes('/home/'), stored)
    assert.equal((m.host.data().storage.usage as { seats: Record<string, { origin?: string }> }).seats['claude:c2']?.origin, 'pane')
    // Reading never writes: the only live files are the ones the test put there.
    assert.deepEqual([...m.files.files.keys()].filter((p) => p.includes('/live/')).length, 4)
    assert.ok(m.calls.every((c) => c === 'list'), m.calls.join(','))
  } finally {
    await m.worker.deactivate()
  }
})

test('worker: a managed account that is the system login reads both files and takes the newer', async () => {
  const m = await mount({ result: () => accountList({ claudeActive: 'c1', updatedAt: T0 }) })
  try {
    m.live('c3', row(SEC - 120, 30, SEC + 3600, 10, SEC + 86_400))
    m.live('system', row(SEC - 60, 35, SEC + 3600, 11, SEC + 86_400))
    let c3 = usageOf((await m.rotator().accounts(true)).seats, 'claude:c3')
    assert.deepEqual([c3.session?.usedPercent, c3.weekly?.usedPercent, c3.asOf], [35, 11, T0 - 60_000])
    // The profile's file is newer but lower in the same window: the stamp moves, the numbers hold.
    m.live('c3', row(SEC - 10, 33, SEC + 3600, 11, SEC + 86_400))
    c3 = usageOf((await m.rotator().accounts(true)).seats, 'claude:c3')
    assert.deepEqual([c3.session?.usedPercent, c3.asOf], [35, T0 - 10_000])
  } finally {
    await m.worker.deactivate()
  }
})

test('worker: live files are read while paused and with the service off, and nothing is switched', async () => {
  const m = await mount({ result: () => accountList({ claudeActive: 'c1', updatedAt: T0 }), settings: { service_claude: false } })
  try {
    await m.rotator().setPaused(true)
    m.live('c2', row(SEC - 5, 12, SEC + 3600, 3, SEC + 86_400))
    await m.rotator().accounts(true)
    await m.rotator().tick()
    const snap = m.rotator().snapshot()
    assert.equal(snap.paused, true)
    assert.equal(snap.services.claude, false)
    const c2 = snap.seats.find((s) => s.key === 'claude:c2')!.usage
    assert.deepEqual([c2.source, c2.origin, c2.session?.usedPercent], ['live', 'pane', 12])
    assert.ok(m.calls.every((c) => c === 'list'), m.calls.join(','))
  } finally {
    await m.worker.deactivate()
  }
})

test('worker: a pane reading survives a restart as a remembered one', async () => {
  const first = await mount({ result: () => accountList({ claudeActive: 'c1', updatedAt: T0 }) })
  first.live('c2', row(SEC - 5, 77, SEC + 3600, 40, SEC + 86_400))
  await first.rotator().accounts(true)
  const stored = first.host.data().storage.usage
  await first.worker.deactivate()
  // Half an hour later, no live file any more.
  const second = await mount({ result: () => accountList({ claudeActive: 'c1', updatedAt: T0 + 30 * MIN }), storage: { usage: stored as never }, now: () => T0 + 30 * MIN })
  try {
    const c2 = usageOf((await second.rotator().accounts(true)).seats, 'claude:c2')
    assert.deepEqual([c2.source, c2.origin, c2.session?.usedPercent], ['cached', 'pane', 77])
  } finally {
    await second.worker.deactivate()
  }
})
