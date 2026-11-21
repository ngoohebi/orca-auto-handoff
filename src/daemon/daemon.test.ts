// Tests for `FileStore` and `OahDaemon` (Unix socket JSON-RPC, subscriptions, host bridge).
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { OahClient } from '../cli/client.ts'
import type { Cli, HostLike } from '../core/engine.ts'
import { memoryFiles } from '../core/statusline-files.ts'
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

test('FileStore persists config, state, and enforces 0700/0600 permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oah-store-'))
  try {
    const store = new FileStore(join(dir, 'oah'))
    const initial = store.loadConfig()
    assert.equal(initial.mode, 'smart')
    assert.equal(initial.services.claude, true)

    store.setSetting('timing', 'at-limit')
    store.setSetting('service_codex', false)

    // Re-read from disk with a fresh FileStore instance
    const reloaded = new FileStore(join(dir, 'oah'))
    const cfg = reloaded.loadConfig()
    assert.equal(cfg.runningSessions, 'limit')
    assert.equal(cfg.services.codex, false)
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
