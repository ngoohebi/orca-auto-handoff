// Tests for `FileStore` and `OahDaemon` (Unix socket JSON-RPC, subscriptions, host bridge).
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { OahClient } from '../cli/client.ts'
import { Rotator, type Cli, type HostLike } from '../core/engine.ts'
import { memoryFiles } from '../core/statusline-files.ts'
import { DEFAULT_CONFIG } from '../core/types.ts'
import { VERSION } from '../core/version.ts'
import { createLineParser, encodeMessage, type WireMessage } from './ipc.ts'
import { OahDaemon } from './server.ts'
import { FileStore } from './store.ts'

function fakeHost(): HostLike {
  return {
    async call(method: string) {
      if (method === 'agents.list') return { agents: [] }
      if (method === 'workspace.list') return { workspaces: [] }
      if (method === 'workspace.getFocused') return { workspace: null }
      if (method === 'project.list') return { projects: [] }
      return {}
    }
  }
}

function fakeCli(accounts: Record<string, any> = {}): Cli {
  const selected: string[] = []
  return {
    async listAccounts() {
      return {
        claude: {
          activeAccountId: 'a1',
          accounts: [
            { id: 'a1', email: 'work@example.com', rateLimits: { claude: { session: { usedPercent: 20, resetsAt: null }, weekly: { usedPercent: 10, resetsAt: null } } } },
            { id: 'a2', email: 'personal@example.com', rateLimits: { claude: { session: { usedPercent: 5, resetsAt: null }, weekly: { usedPercent: 5, resetsAt: null } } } }
          ]
        },
        ...accounts
      }
    },
    async select(provider, accountId) {
      selected.push(`${provider}:${accountId}`)
    },
    async closeTerminal() {},
    async sendText() {},
    async git() {
      return ''
    },
    async activeTerminals() {
      return []
    },
    async visibleTerminals() {
      return []
    },
    async draft() {
      return ''
    }
  }
}

test('direct quota still updates a known profile while Orca account listing is unavailable', async () => {
  const cli = fakeCli({
    codex: { activeAccountId: 'c1', accounts: [{ id: 'c1' }] },
    rateLimits: { claude: { status: 'ok', session: { usedPercent: 50, resetsAt: null } } }
  })
  const listAccounts = cli.listAccounts
  let lastOrcaOptions: Parameters<Cli['listAccounts']>[1]
  let forceProviderChecks = false
  let offline = false
  let now = 1_790_000_000_000
  cli.listAccounts = async (...args) => {
    lastOrcaOptions = args[1]
    if (offline) throw new Error('offline')
    return listAccounts(...args)
  }
  const rotator = new Rotator({
    cli,
    host: fakeHost(),
    now: () => now,
    sleep: async () => {},
    loadState: async () => null,
    saveState: async () => {},
    config: async () => ({ ...DEFAULT_CONFIG, quotaLinks: ['codex:c1'] }),
    log: () => {},
    notify: async () => {},
    publish: () => {},
    loadUsage: async () => null,
    saveUsage: async () => {},
    readLive: async () => null,
    loadSamples: async () => null,
    saveSamples: async () => {},
    refreshProfileQuota: async (profiles, seats, force) => {
      forceProviderChecks = force
      assert.equal(profiles.codex.accounts[0].id, 'c1')
      assert.deepEqual(seats.map((seat) => seat.key), ['codex:c1'])
      seats.find((seat) => seat.key === 'codex:c1')!.usage = {
        known: true,
        source: 'live',
        origin: 'codex-profile',
        updatedAt: now,
        session: { usedPercent: offline ? 60 : 20, resetsAt: now + 3600_000 }
      }
    }
  })
  await rotator.init()
  await rotator.accounts(true, true, true)
  // Orca first, stale only, within its throttles: never a forced refresh.
  assert.deepEqual(lastOrcaOptions, { refreshStaleUsage: true })
  assert.equal(forceProviderChecks, true)
  offline = true
  now += 60_000
  await rotator.accounts(true, true)
  assert.deepEqual(lastOrcaOptions, { refreshStaleUsage: true })
  assert.equal(forceProviderChecks, false)
  // Direct checks run in the background: their answer arrives after the read.
  await rotator.directChecksSettled()
  const snapshot = rotator.snapshot()
  assert.equal(snapshot.error, 'orca account list failed: offline')
  const direct = snapshot.seats.find((seat) => seat.key === 'codex:c1')!.usage
  assert.deepEqual([direct.source, direct.origin, direct.session?.usedPercent], ['live', 'codex-profile', 60])
  assert.equal(snapshot.seats.find((seat) => seat.key === 'claude:a1')?.usage.source, 'cached')
})

test('FileStore persists config, state, and enforces 0700/0600 permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oah-store-'))
  try {
    const store = new FileStore(join(dir, 'oah'))
    const initial = store.loadConfig()
    assert.equal(initial.mode, 'smart')
    assert.equal(initial.services.claude, true)

    store.setSetting('timing', 'at-limit')
    store.setSetting('service_codex', false)
    store.setQuotaLink('codex:test-account', true)

    // Re-read from disk with a fresh FileStore instance
    const reloaded = new FileStore(join(dir, 'oah'))
    const cfg = reloaded.loadConfig()
    assert.equal(cfg.runningSessions, 'limit')
    assert.equal(cfg.services.codex, false)
    assert.deepEqual(cfg.quotaLinks, ['codex:test-account'])
    reloaded.setQuotaLink('codex:test-account', false)
    assert.deepEqual(new FileStore(join(dir, 'oah')).loadConfig().quotaLinks, [])
    // Automatic linking links what is new, and never an account unlinked by hand...
    assert.deepEqual(reloaded.autoLinkQuota(['codex:test-account', 'claude:a1']), ['claude:a1'])
    assert.deepEqual(reloaded.autoLinkQuota(['claude:a1']), [])
    assert.deepEqual(new FileStore(join(dir, 'oah')).loadConfig().quotaLinks, ['claude:a1'])
    // ...until it is linked by hand again.
    reloaded.setQuotaLink('codex:test-account', true)
    assert.deepEqual(reloaded.getQuotaUnlinks(), [])
    assert.equal(cfg.services.claude, true)
    assert.equal(statSync(reloaded.home).mode & 0o777, 0o700)
    assert.equal(statSync(reloaded.configPath).mode & 0o777, 0o600)

    assert.throws(() => reloaded.setSetting('nonexistent_key', 1), /Unknown setting/)
    assert.throws(() => reloaded.setSetting('timing', 'invalid'), /Invalid value/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('OahDaemon serves ping, snapshot, pause, settings, service toggles, and subscriptions over Unix socket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oah-daemon-'))
  const daemon = new OahDaemon({
    home: dir,
    host: fakeHost(),
    cli: fakeCli(),
    files: memoryFiles('/home/test'),
    background: false
  })
  try {
    await daemon.start()
    const client = new OahClient(dir, daemon.sockPath)

    const ping = await client.ping()
    assert.ok(ping)
    assert.equal(ping!.version, VERSION)
    assert.equal(ping!.bridgeConnected, false)

    const snap = await client.call('snapshot', { refresh: true })
    assert.equal(snap.paused, false)
    assert.equal(snap.seats.length, 2)
    assert.equal(snap.seats[0].label, 'work@example.com')

    // Subscribe to push events on a separate socket
    const received: WireMessage[] = []
    const sub = createConnection(daemon.sockPath)
    sub.setEncoding('utf8')
    const parse = createLineParser((m) => received.push(m))
    sub.on('data', (c) => parse(c.toString('utf8')))
    await new Promise<void>((resolve) => sub.on('connect', () => resolve()))
    sub.write(encodeMessage({ type: 'req', id: 's1', method: 'subscribe', params: {} }))
    await new Promise((r) => setTimeout(r, 40))

    // Pause -> triggers snapshot push event
    await client.call('pause', { paused: true })
    await new Promise((r) => setTimeout(r, 40))
    const pausedSnap = await client.call('snapshot', {})
    assert.equal(pausedSnap.paused, true)
    assert.ok(received.some((m) => m.type === 'event' && m.event === 'snapshot'))

    // Settings update
    const updated = await client.call('settings', { key: 'timing', value: 'at-limit' })
    assert.equal(updated.timing, 'at-limit')
    assert.ok(received.some((m) => m.type === 'event' && m.event === 'settings'))

    // Service toggle
    const svc = await client.call('setService', { provider: 'claude', enabled: false })
    assert.equal(svc.services.claude, false)

    sub.destroy()
  } finally {
    await daemon.stop()
    assert.equal(existsSync(daemon.sockPath), false)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('OahDaemon routes host.call requests to a registered Orca plugin bridge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oah-bridge-'))
  const daemon = new OahDaemon({
    home: dir,
    cli: fakeCli(),
    files: memoryFiles('/home/test'),
    background: false
  })
  try {
    await daemon.start()
    const client = new OahClient(dir, daemon.sockPath)

    // Register a mock plugin bridge over Unix socket
    const bridge = createConnection(daemon.sockPath)
    bridge.setEncoding('utf8')
    const bridgeCalls: string[] = []
    const parse = createLineParser((msg: WireMessage) => {
      if (msg.type === 'req' && msg.method === 'host.call') {
        const p = msg.params as { method: string; params?: unknown }
        bridgeCalls.push(p.method)
        bridge.write(encodeMessage({ type: 'res', id: msg.id, ok: true, result: { bridged: true, method: p.method } }))
      }
    })
    bridge.on('data', (c) => parse(c.toString('utf8')))
    await new Promise<void>((resolve) => bridge.on('connect', () => resolve()))
    bridge.write(encodeMessage({ type: 'req', id: 'reg1', method: 'bridge.register', params: {} }))
    await new Promise((r) => setTimeout(r, 50))

    const ping = await client.ping()
    assert.equal(ping?.bridgeConnected, true)

    const res = await daemon.transport.call('agent.resume', { sessionId: 'sess-1' })
    assert.deepEqual(res, { bridged: true, method: 'agent.resume' })
    assert.deepEqual(bridgeCalls, ['agent.resume'])

    bridge.destroy()
    await new Promise((r) => setTimeout(r, 50))
    const pingAfter = await client.ping()
    assert.equal(pingAfter?.bridgeConnected, false)
  } finally {
    await daemon.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('accounts a direct check can serve are turned on automatically and checked in the same read; the others say why, or that they were turned off', async () => {
  const cli = fakeCli({
    codex: { activeAccountId: 'c1', accounts: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] },
    rateLimits: { claude: { status: 'ok', session: { usedPercent: 50, resetsAt: null } } }
  })
  let links: string[] = []
  const checked: string[][] = []
  const rotator = new Rotator({
    cli,
    host: fakeHost(),
    now: () => 1_790_000_000_000,
    sleep: async () => {},
    loadState: async () => null,
    saveState: async () => {},
    config: async () => ({ ...DEFAULT_CONFIG, quotaLinks: links }),
    log: () => {},
    notify: async () => {},
    publish: () => {},
    loadUsage: async () => null,
    saveUsage: async () => {},
    readLive: async () => null,
    loadSamples: async () => null,
    saveSamples: async () => {},
    // Only c1 and c3 have a sign-in a check can use; c3 was turned off by hand.
    quotaStatus: (_accounts, seats) => {
      const added = seats.filter((s) => s.key === 'codex:c1' && !links.includes(s.key)).map((s) => s.key)
      links = [...links, ...added]
      return { added, off: ['codex:c3'], unavailable: { 'codex:c2': 'no saved sign-in on this computer' } }
    },
    refreshProfileQuota: async (_profiles, seats) => {
      checked.push(seats.map((s) => s.key))
    }
  })
  await rotator.init()
  await rotator.accounts(true)
  assert.deepEqual(links, ['codex:c1'])
  assert.deepEqual(checked.at(-1), ['codex:c1'])
  const snap = rotator.snapshot()
  assert.equal(snap.seats.find((s) => s.key === 'codex:c1')?.quotaLinked, true)
  assert.equal(snap.seats.find((s) => s.key === 'codex:c2')?.quotaLinked, undefined)
  assert.equal(snap.seats.find((s) => s.key === 'codex:c2')?.quotaUnavailable, 'no saved sign-in on this computer')
  assert.equal(snap.seats.find((s) => s.key === 'codex:c3')?.quotaOff, true)
  assert.equal(snap.seats.find((s) => s.key === 'codex:c1')?.quotaOff, undefined)
})

test('with Live quota off no direct check is made and nothing is turned on; Check now says why', async () => {
  const cli = fakeCli({
    codex: { activeAccountId: 'c1', accounts: [{ id: 'c1' }] },
    rateLimits: { claude: { status: 'ok', session: { usedPercent: 50, resetsAt: null } } }
  })
  const calls: string[] = []
  const rotator = new Rotator({
    cli,
    host: fakeHost(),
    now: () => 1_790_000_000_000,
    sleep: async () => {},
    loadState: async () => null,
    saveState: async () => {},
    config: async () => ({ ...DEFAULT_CONFIG, quotaLinks: ['codex:c1'], directQuota: false }),
    log: () => {},
    notify: async () => {},
    publish: () => {},
    loadUsage: async () => null,
    saveUsage: async () => {},
    readLive: async () => null,
    loadSamples: async () => null,
    saveSamples: async () => {},
    quotaStatus: () => {
      calls.push('status')
      return { added: [], off: [], unavailable: {} }
    },
    refreshProfileQuota: async () => {
      calls.push('check')
    }
  })
  await rotator.init()
  await rotator.accounts(true, true)
  assert.deepEqual(calls, [])
  assert.equal(rotator.snapshot().seats.find((s) => s.key === 'codex:c1')?.quotaLinked, undefined)
  const refused = await rotator.accounts(true, true, true).then(() => '', (error: Error) => error.message)
  assert.match(refused, /Live quota is off in Settings/)
})

test('Live quota fills the gaps: an account Orca read recently is not asked directly; one Orca has no recent reading of is', async () => {
  let now = 1_790_000_000_000
  const cli = fakeCli({
    codex: { activeAccountId: 'c1', accounts: [{ id: 'c1' }, { id: 'c2' }] },
    rateLimits: { codex: { status: 'ok', updatedAt: now - 60_000, session: { usedPercent: 10, resetsAt: null } } }
  })
  const asked: string[][] = []
  const rotator = new Rotator({
    cli,
    host: fakeHost(),
    now: () => now,
    sleep: async () => {},
    loadState: async () => null,
    saveState: async () => {},
    config: async () => ({ ...DEFAULT_CONFIG, quotaLinks: ['codex:c1', 'codex:c2'] }),
    log: () => {},
    notify: async () => {},
    publish: () => {},
    loadUsage: async () => null,
    saveUsage: async () => {},
    readLive: async () => null,
    loadSamples: async () => null,
    saveSamples: async () => {},
    refreshProfileQuota: async (_profiles, seats) => {
      asked.push(seats.map((s) => s.key))
    }
  })
  await rotator.init()
  await rotator.accounts(true)
  // c1 is in use and Orca read it a minute ago; c2 is not in use and Orca has nothing for it.
  assert.deepEqual(asked.at(-1), ['codex:c2'])
  // Eleven minutes on, Orca's reading of c1 is older than the check interval: both are gaps.
  now += 11 * 60_000
  await rotator.accounts(true)
  assert.deepEqual(asked.at(-1), ['codex:c1', 'codex:c2'])
})

test('Live quota checks run beside the account read: a slow provider never holds the read up, and its answer shows when it comes', async () => {
  let now = 1_790_000_000_000
  const cli = fakeCli({ codex: { activeAccountId: 'c1', accounts: [{ id: 'c1' }, { id: 'c2' }] }, rateLimits: {} })
  let release!: () => void
  const slow = new Promise<void>((resolve) => (release = resolve))
  const published: unknown[] = []
  const rotator = new Rotator({
    cli,
    host: fakeHost(),
    now: () => now,
    sleep: async () => {},
    loadState: async () => null,
    saveState: async () => {},
    config: async () => ({ ...DEFAULT_CONFIG, quotaLinks: ['codex:c2'] }),
    log: () => {},
    notify: async () => {},
    publish: (snap) => published.push(snap),
    loadUsage: async () => null,
    saveUsage: async () => {},
    readLive: async () => null,
    loadSamples: async () => null,
    saveSamples: async () => {},
    refreshProfileQuota: async (_profiles, seats) => {
      await slow
      const seat = seats.find((s) => s.key === 'codex:c2')!
      seat.usage = { known: true, source: 'live', origin: 'codex-profile', updatedAt: now, session: { usedPercent: 30, resetsAt: null } }
    }
  })
  await rotator.init()
  // The read answers while the check still waits on the provider.
  await rotator.accounts(true)
  assert.equal(rotator.snapshot().seats.find((s) => s.key === 'codex:c2')?.usage.known, false)
  const before = published.length
  release()
  await rotator.directChecksSettled()
  const c2 = rotator.snapshot().seats.find((s) => s.key === 'codex:c2')!.usage
  assert.deepEqual([c2.known, c2.source, c2.session?.usedPercent], [true, 'live', 30])
  assert.ok(published.length > before, 'the answer is published')
})

test('an account read that fails is not taken for a fresh one: the next read asks Orca again', async () => {
  let now = 1_790_000_000_000
  let offline = false
  let asked = 0
  const cli = fakeCli({ codex: { activeAccountId: 'c1', accounts: [{ id: 'c1' }] }, rateLimits: {} })
  const listAccounts = cli.listAccounts
  cli.listAccounts = async (...args) => {
    asked++
    if (offline) throw new Error('offline')
    return listAccounts(...args)
  }
  const rotator = new Rotator({
    cli,
    host: fakeHost(),
    now: () => now,
    sleep: async () => {},
    loadState: async () => null,
    saveState: async () => {},
    config: async () => ({ ...DEFAULT_CONFIG, quotaLinks: ['codex:c1'] }),
    log: () => {},
    notify: async () => {},
    publish: () => {},
    loadUsage: async () => null,
    saveUsage: async () => {},
    readLive: async () => null,
    loadSamples: async () => null,
    saveSamples: async () => {},
    refreshProfileQuota: async () => {}
  })
  await rotator.init()
  await rotator.accounts(true)
  offline = true
  now += 1000
  await rotator.accounts(true)
  assert.equal(rotator.snapshot().error, 'orca account list failed: offline')
  // A read within the poll interval, not forced: it asks Orca again rather than keep the failure.
  offline = false
  const before = asked
  now += 1000
  await rotator.accounts()
  assert.equal(asked, before + 1)
  assert.equal(rotator.snapshot().error, undefined)
})
