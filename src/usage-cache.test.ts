import { assert, test } from 'orca/testing'
import { parseAccounts } from './accounts'
import { accountList } from './fixtures'
import { buildChain, pickNext } from './selector'
import { DEFAULT_CONFIG, type Seat } from './types'
import { emptyUsageCache, isLive, loadedUsageCache, observe, resolve } from './usage-cache'
import { statusText, tickMs } from './worker'

const T0 = 1_000_000
const HOUR = 3_600_000
const WEEK = 7 * 24 * HOUR

function seat(over: Partial<Seat> & { usage: Seat['usage'] }): Seat {
  return { key: 'claude:c2', provider: 'claude', accountId: 'c2', label: 'two', active: false, ...over }
}

const live = (session: number, weekly: number, at = T0, resets = { s: T0 + HOUR, w: T0 + 24 * HOUR }) =>
  seat({
    usage: {
      known: true,
      source: 'live',
      updatedAt: at,
      session: { usedPercent: session, resetsAt: resets.s },
      weekly: { usedPercent: weekly, resetsAt: resets.w }
    }
  })
const gone = (reason: Seat['usage']['reason'] = 'stale-token') =>
  seat({ usage: { known: false, source: 'unknown', reason, detail: 'Claude usage updates the next time Claude runs.' } })

test('a live reading is remembered and used when Orca later has nothing, keeping Orca\'s reason', () => {
  const cache = emptyUsageCache()
  assert.equal(observe(cache, [live(40, 20)], T0, {}), true)
  const u = resolve(gone(), cache, T0 + 10 * 60_000, WEEK, {})
  assert.equal(u.source, 'cached')
  assert.equal(u.known, true)
  assert.equal(u.asOf, T0)
  assert.equal(u.session?.usedPercent, 40)
  assert.equal(u.reason, 'stale-token')
})

test('a remembered window whose reset time has passed counts as reset (0 %)', () => {
  const cache = emptyUsageCache()
  observe(cache, [live(100, 30)], T0, {})
  const u = resolve(gone(), cache, T0 + 2 * HOUR, WEEK, {})
  assert.equal(u.source, 'projected')
  assert.deepEqual(u.session, { usedPercent: 0, resetsAt: null, reset: true })
  assert.equal(u.weekly?.usedPercent, 30) // weekly has not reset yet
})

test('a window with no reset time expires after its length; past the max age the seat is unknown', () => {
  const cache = emptyUsageCache()
  observe(cache, [live(60, 60, T0, { s: null as unknown as number, w: T0 + 3 * 24 * HOUR })], T0, {})
  const u = resolve(gone(), cache, T0 + 6 * HOUR, WEEK, {})
  assert.equal(u.session, undefined)
  assert.equal(u.weekly?.usedPercent, 60)
  assert.equal(resolve(gone(), cache, T0 + 8 * 24 * HOUR, WEEK, {}).source, 'unknown')
  assert.equal(resolve(gone(), cache, T0 + 60_000, 0, {}).known, false) // max age 0 = cache off
})

test('asOf does not move when Orca repeats the same reading; prunes removed accounts', () => {
  const cache = emptyUsageCache()
  observe(cache, [live(40, 20, T0)], T0, {})
  const noTimestamp = live(40, 20)
  delete noTimestamp.usage.updatedAt
  assert.equal(observe(cache, [noTimestamp], T0 + HOUR, {}), false)
  assert.equal(cache.seats['claude:c2']?.asOf, T0)
  assert.equal(observe(cache, [], T0 + HOUR, {}), true)
  assert.deepEqual(cache.seats, {})
})

test('right after a switch, an older reading in the active slot is not credited to the new account', () => {
  const cache = emptyUsageCache()
  const stale = { ...live(95, 50, T0), active: true }
  const since = { claude: T0 + 5_000 }
  assert.equal(isLive(stale, since), false)
  assert.equal(observe(cache, [stale], T0 + 6_000, since), false)
  assert.equal(resolve(stale, cache, T0 + 6_000, WEEK, since).source, 'unknown')
  assert.equal(isLive({ ...live(10, 5, T0 + 9_000), active: true }, since), true)
})

test('stored caches of another version start empty', () => {
  assert.deepEqual(loadedUsageCache({ v: 2, seats: { x: 1 } }), emptyUsageCache())
  assert.deepEqual(loadedUsageCache(null), emptyUsageCache())
})

test('Orca\'s reasons are parsed from the account list', () => {
  const result = accountList({ claudeActive: 'c1' })
  result.rateLimits.inactiveClaudeAccounts = [
    {
      accountId: 'c2',
      isFetching: false,
      rateLimits: { provider: 'claude', status: 'error', error: 'Claude usage is rate limited right now.', retryAtMs: T0 + 60_000, usageMetadata: { failureKind: 'rate-limited' } }
    },
    { accountId: 'c3', rateLimits: { provider: 'claude', status: 'error', error: 'Sign in again to use this account.', usageMetadata: { failureKind: 'missing-credentials' } } }
  ]
  const seats = parseAccounts(result).seats
  const c2 = seats.find((s) => s.key === 'claude:c2')!.usage
  assert.equal(c2.reason, 'rate-limited')
  assert.equal(c2.retryAt, T0 + 60_000)
  assert.equal(c2.detail, 'Claude usage is rate limited right now.')
  assert.equal(seats.find((s) => s.key === 'claude:c3')!.usage.reason, 'sign-in')
  assert.equal(seats.find((s) => s.key === 'claude:c1')!.usage.source, 'live')
})

test('the selector skips a remembered over-threshold seat, and takes it once its window has reset', () => {
  const cfg = { ...DEFAULT_CONFIG, thresholdFiveHour: 80, strategy: 'priority' as const }
  const cache = emptyUsageCache()
  observe(cache, [live(90, 10, T0)], T0, {})
  const view = parseAccounts(accountList({ claudeActive: 'c1', claudeUsage: { session: 10, weekly: 10 } }))
  const now = T0 + 10 * 60_000
  const resolved = (at: number) =>
    view.seats.map((s) => ({ ...s, usage: s.key === 'claude:c2' ? resolve(s, cache, at, WEEK, {}) : s.usage }))
  const chain = buildChain(resolved(now), 'claude', cfg)
  assert.equal(pickNext(chain, 'claude:c1', {}, cfg, now)?.key, 'claude:c3')
  const later = T0 + 2 * HOUR
  assert.equal(pickNext(buildChain(resolved(later), 'claude', cfg), 'claude:c1', {}, cfg, later)?.key, 'claude:c2')
})

test('the status bar marks remembered numbers with ~ and gives their age in the tooltip', () => {
  const s = statusText({
    paused: false,
    updatedAt: 0,
    services: { claude: true, codex: true, antigravity: true, opencode: true, devin: true },
    waiting: [],
    history: [],
    seats: [
      { key: 'claude:a', provider: 'claude', accountId: 'a', label: 'a', active: false, usage: { known: false } },
      { key: 'claude:b', provider: 'claude', accountId: 'b', label: 'b', active: true, usage: { known: true, source: 'cached', asOf: T0, session: { usedPercent: 40, resetsAt: null }, weekly: { usedPercent: 20, resetsAt: null } } }
    ]
  } as never)
  assert.equal(s.text, 'claude 2/2 · ~40%·20%')
  assert.match(s.tooltip, /last reading/)
})

test('the tick follows the read period, between 15 and 30 s', () => {
  assert.equal(tickMs(15), 15_000)
  assert.equal(tickMs(60), 30_000)
  assert.equal(tickMs(3600), 30_000)
  assert.equal(tickMs(1), 15_000)
})

// ---- through the worker ---------------------------------------------------------------------
import { mockHost, mountWorker } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import type { Cli, Rotator } from './engine'
import { activateWith } from './worker'

function cliFor(result: () => Record<string, any>, calls: string[], gate?: Promise<void>): Cli {
  return {
    async listAccounts() {
      calls.push('list')
      if (gate) await gate
      return result()
    },
    async select(provider, accountId) {
      calls.push(`select ${provider} ${accountId}`)
    },
    async closeTerminal() {},
    async sendText() {},
    async git() {
      return ''
    }
  }
}

async function mountWith(cli: Cli, storage: Record<string, never> = {}, now = () => T0) {
  const host = mockHost({ storage, results: { 'statusBar.update': { ok: true }, 'notifications.show': { delivered: true } } })
  let rotator!: Rotator
  const worker = await mountWorker(
    { default: async (orca: OrcaWorkerApi) => void (rotator = await activateWith(orca, { cli, now, sleep: async () => undefined }, { tick: false })) },
    { host }
  )
  return { host, worker, rotator: () => rotator }
}

test('remembered usage survives a worker restart and fills in an account Orca no longer reports', async () => {
  const calls: string[] = []
  const first = await mountWith(cliFor(() => accountList({ claudeActive: 'c1', claudeUsage: { session: 33, weekly: 12 }, updatedAt: T0 }), calls))
  await first.rotator().accounts(true)
  const stored = first.host.data().storage.usage as { seats: Record<string, { asOf: number }> }
  assert.equal(stored.seats['claude:c1']?.asOf, T0)
  await first.worker.deactivate()

  // Later c2 is in use; Orca has nothing for c1 (expired token).
  const later = () => {
    const r = accountList({ claudeActive: 'c2', updatedAt: T0 + HOUR / 2 })
    r.rateLimits.inactiveClaudeAccounts = [
      { accountId: 'c1', rateLimits: { provider: 'claude', status: 'error', error: 'Claude usage updates the next time Claude runs.', usageMetadata: { failureKind: 'stale-token' } } }
    ]
    return r
  }
  const second = await mountWith(cliFor(later, calls), { usage: stored as never }, () => T0 + HOUR / 2)
  const c1 = (await second.rotator().accounts(true)).seats.find((s) => s.key === 'claude:c1')!
  assert.equal(c1.usage.source, 'cached')
  assert.equal(c1.usage.session?.usedPercent, 33)
  assert.equal(c1.usage.reason, 'stale-token')
  const snap = await second.worker.request('rotator.snapshot', {})
  assert.equal(snap.seats.find((s) => s.key === 'claude:c1')?.usage.source, 'cached')
  await second.worker.deactivate()
})

test('concurrent refreshes share one orca account list call', async () => {
  const calls: string[] = []
  let open!: () => void
  const gate = new Promise<void>((resolve) => (open = resolve))
  const { rotator, worker } = await mountWith(cliFor(() => accountList(), calls, gate))
  const before = calls.length
  const reads = [rotator().accounts(true), rotator().accounts(true), rotator().accounts(true)]
  open()
  await Promise.all(reads)
  assert.equal(calls.length - before <= 1, true)
  await worker.deactivate()
})

test('after the plugin switches accounts it reads usage again (Orca refreshes inactive accounts then)', async () => {
  const calls: string[] = []
  const { rotator, worker } = await mountWith(cliFor(() => accountList({ claudeActive: 'c1' }), calls))
  await rotator().accounts(true)
  const before = calls.filter((c) => c === 'list').length
  await rotator().selectSeat('claude:c2')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(calls.includes('select claude c2'))
  assert.ok(calls.filter((c) => c === 'list').length >= before + 2, calls.join(','))
  await worker.deactivate()
})
