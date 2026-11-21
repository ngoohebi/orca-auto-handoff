// End-to-end integration test for the thin Orca plugin worker connected to a live `OahDaemon`.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { OrcaWorkerApi } from 'orca/worker'
import type { Cli } from '../core/engine.ts'
import { memoryFiles } from '../core/statusline-files.ts'
import { OahDaemon } from '../daemon/server.ts'
import { activateThin } from './worker.ts'

function fakeCli(): Cli {
  return {
    async listAccounts() {
      return {
        claude: {
          activeAccountId: 'a1',
          accounts: [
            { id: 'a1', email: 'work@example.com', rateLimits: { claude: { session: { usedPercent: 25, resetsAt: null }, weekly: { usedPercent: 10, resetsAt: null } } } },
            { id: 'a2', email: 'personal@example.com', rateLimits: { claude: { session: { usedPercent: 5, resetsAt: null }, weekly: { usedPercent: 5, resetsAt: null } } } }
          ]
        }
      }
    },
    async select() {},
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

function makeMockOrca(hostImpl: (method: string, params?: unknown) => Promise<any>) {
  const panelHandlers = new Map<string, (input: any) => Promise<any>>()
  const posted: { event: string; payload: unknown }[] = []
  const api = {
    log: () => undefined,
    host: { call: hostImpl },
    events: { on: () => undefined },
    hooks: { on: () => undefined },
    commands: { register: () => undefined },
    panels: {
      handle: (name: string, fn: (input: any) => Promise<any>) => {
        panelHandlers.set(name, fn)
      },
      post: (event: string, payload: unknown) => {
        posted.push({ event, payload })
      }
    }
  } as unknown as OrcaWorkerApi

  return {
    api,
    posted,
    request: (name: string, input: unknown) => {
      const h = panelHandlers.get(name)
      if (!h) throw new Error(`No handler for ${name}`)
      return h(input)
    }
  }
}

test('thin Orca plugin worker bridges host calls, relays panel RPCs, and receives daemon push events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oah-thin-worker-'))
  const daemon = new OahDaemon({
    home: dir,
    cli: fakeCli(),
    files: memoryFiles('/home/test'),
    background: false
  })

  const hostCalls: string[] = []
  const mock = makeMockOrca(async (method: string) => {
    hostCalls.push(method)
    if (method === 'agents.list') return { agents: [] }
    if (method === 'workspace.list') return { workspaces: [] }
    if (method === 'workspace.getFocused') return { workspace: null }
    if (method === 'project.list') return { projects: [] }
    if (method === 'agent.resume') return { terminalId: 't-resumed' }
    return {}
  })

  let bridge: { stop(): void } | undefined
  try {
    await daemon.start()
    bridge = await activateThin(mock.api, { home: dir, sockPath: daemon.sockPath, autoStart: false })
    await new Promise((r) => setTimeout(r, 60))

    assert.equal(daemon.transport.bridgeConnected, true)

    // Panel RPC relays to oahd and returns live accounts
    const snap = await mock.request('rotator.snapshot', { refresh: true })
    assert.equal(snap.seats.length, 2)
    assert.equal(snap.seats[0].label, 'work@example.com')

    // Pause via panel RPC -> oahd broadcasts snapshot back to panel
    await mock.request('rotator.pause', { paused: true })
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(mock.posted.some((p) => p.event === 'rotator.changed' && (p.payload as any)?.paused === true))

    // Settings update via panel RPC -> oahd persists & broadcasts settings
    const settings = await mock.request('rotator.settings', { key: 'timing', value: 'at-limit' })
    assert.equal(settings.timing, 'at-limit')
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(mock.posted.some((p) => p.event === 'rotator.settings' && (p.payload as any)?.timing === 'at-limit'))

    // oahd can invoke Orca host methods (like agent.resume) through the thin bridge
    const resumed = await daemon.transport.call('agent.resume', { sessionId: 's1' })
    assert.deepEqual(resumed, { terminalId: 't-resumed' })
    assert.ok(hostCalls.includes('agent.resume'))
  } finally {
    bridge?.stop()
    await daemon.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
