// End-to-end through the real worker: Orca events in, host calls and CLI calls out.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import type { Cli, Rotator } from './engine'
import * as fx from './fixtures'
import { activateWith, statusText } from './worker'
import type { RotatorState } from './types'

type Pane = { terminalId: string; agent: string; state: 'working' | 'waiting' | 'done' | 'blocked'; sessionId?: string; title?: string }

function world(options: {
  panes: Pane[]
  tails: Record<string, string[]>
  /** Orca's numbers for the active accounts; by default they are exhausted, as they are when a
   *  pane on them hits a limit. */
  claudeUsage?: { session: number; weekly: number }
  codexUsage?: { session: number; weekly: number }
  settings?: Record<string, string | number | boolean>
  state?: Partial<RotatorState>
  /** Resumed sessions redraw their transcript, as live Claude does; `late` = only after the
   *  first message arrives (live: the redraw raced the plugin's first read). */
  redraw?: boolean | 'late'
  /** Live Orca refuses plugin sends outside the focused workspace. */
  refuseHostSend?: boolean
}) {
  let clock = 1_000_000
  let claudeActive: string | null = 'c1'
  let codexActive: string | null = 'x1'
  let next = 2
  const panes = [...options.panes]
  const cliCalls: string[] = []
  const lateFrom: Record<string, string> = {}
  const deliver = (terminalId: string, text: string) => {
    const from = lateFrom[terminalId]
    if (from) {
      options.tails[terminalId] = [...(options.tails[from] ?? []), `❯ ${text}`]
      delete lateFrom[terminalId]
    }
  }
  const typed: { terminalId: string; text: string }[] = []
  const cli: Cli = {
    async listAccounts() {
      cliCalls.push('list')
      const result = accountListFor()
      return result
    },
    async select(provider, accountId) {
      cliCalls.push(`select ${provider} ${accountId}`)
      if (provider === 'claude') claudeActive = accountId === 'system' ? null : accountId
      if (provider === 'codex') codexActive = accountId === 'system' ? null : accountId
    },
    async closeTerminal(id) {
      cliCalls.push(`close ${id}`)
    },
    async sendText(terminalId, text) {
      cliCalls.push(`send ${terminalId}`)
      typed.push({ terminalId, text })
      deliver(terminalId, text)
    },
    async git(_cwd, args) {
      return args[0] === 'status' ? ' M src/parser.ts' : ' src/parser.ts | 4 ++--'
    }
  }
  const accountListFor = () =>
    fx.accountList({
      claudeActive,
      codexActive,
      // The given (or exhausted) numbers belong to the first active account; an account
      // switched to later has room.
      claudeUsage: claudeActive === 'c1' ? options.claudeUsage ?? { session: 100, weekly: 40 } : { session: 5, weekly: 5 },
      codexUsage: codexActive === 'x1' ? options.codexUsage ?? { session: 100, weekly: 40 } : { session: 5, weekly: 5 }
    })
  const spawn = (agent: string, sessionId?: string, from?: string) => {
    const terminalId = `t${next++}`
    if (options.redraw === true && from) options.tails[terminalId] = [...(options.tails[from] ?? [])]
    if (options.redraw === 'late' && from) {
      options.tails[terminalId] = []
      lateFrom[terminalId] = from
    }
    panes.push({ terminalId, agent, state: 'waiting', ...(sessionId ? { sessionId } : {}) })
    return terminalId
  }
  const host = mockHost({
    settings: options.settings ?? {},
    storage: options.state ? { state: { paused: false, health: {}, paneSeat: {}, seen: {}, apiRetries: {}, modelStep: {}, waiting: [], history: [], ...options.state } as never } : {},
    results: {
      'agents.list': () => ({ agents: panes.map((p) => ({ title: null, task: null, stateStartedAt: 1, sessionId: null, ...p })) }),
      'terminal.read': ({ terminalId }: { terminalId: string }) => ({ lines: options.tails[terminalId] ?? [], truncated: false }),
      'terminal.close': ({ terminalId }: { terminalId: string }) => {
        const i = panes.findIndex((p) => p.terminalId === terminalId)
        if (i >= 0) panes.splice(i, 1)
        return { closed: true }
      },
      'agent.resume': ({ agent, sessionId }: { agent: string; sessionId: string }) => {
        const from = Object.keys(options.tails).find((t) => panes.every((p) => p.terminalId !== t) && options.tails[t]?.length)
        return { terminalId: spawn(agent, sessionId, from), started: true }
      },
      'agent.launch': ({ agent }: { agent: string }) => ({ terminalId: spawn(agent) }),
      'terminal.sendText': ({ terminalId, text }: { terminalId: string; text: string }) => {
        if (options.refuseHostSend) throw Object.assign(new Error('terminal is outside the active worktree'), { code: 'action_failed' })
        typed.push({ terminalId, text })
        deliver(terminalId, text)
        return { accepted: true }
      },
      'workspace.list': { workspaces: [{ id: 'w1', kind: 'worktree', name: 'w1', path: '/repo', branch: 'feat/x', hostId: 'local' }], truncated: false },
      'workspace.readContext': { workspaceId: 'w1', branch: 'feat/x', displayName: 'w1', terminals: [] },
      'notifications.show': { delivered: true },
      'statusBar.update': { ok: true }
    }
  })
  let rotator!: Rotator
  const mod = {
    default: async (orca: OrcaWorkerApi) => {
      rotator = await activateWith(
        orca,
        { cli, now: () => clock, sleep: async () => undefined },
        { tick: false }
      )
    }
  }
  return {
    host,
    tails: options.tails,
    cliCalls,
    typed,
    panes,
    get rotator() {
      return rotator
    },
    advance(ms: number) {
      clock += ms
    },
    async mount() {
      const worker = await mountWorker(mod, { host })
      await rotator.accounts(true)
      return worker
    }
  }
}

const statusEvent = (terminalId: string, state: 'done' | 'waiting' = 'done', stamp = 1) => ({
  workspaceId: 'w1',
  paneKey: `pane-${terminalId}`,
  terminalId,
  state,
  receivedAt: stamp,
  mainAgent: { state, stateStartedAt: stamp }
})

test('Claude rate limit: select next account, close, resume, send "Go continue."', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1', title: 'fix parser' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.ok(w.cliCalls.includes('select claude c2'), w.cliCalls.join(','))
  assert.deepEqual(w.host.callsOf('terminal.close'), [{ terminalId: 't1' }])
  assert.deepEqual(w.host.callsOf('agent.resume'), [{ workspaceId: 'w1', agent: 'claude', sessionId: 's1' }])
  assert.deepEqual(w.typed, [{ terminalId: 't2', text: 'Go continue.' }])
  const state = w.host.data().storage.state as RotatorState
  assert.equal(state.paneSeat.t2, 'claude:c2')
  assert.ok(state.health['claude:c1']?.cooldownUntil! > 1_000_000)
  assert.equal(state.history.at(-1)?.result, 'resumed')
  assert.deepEqual(worker.refusals, [])
  // The same event again changes nothing: t1 is gone.
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.cliCalls.filter((c) => c.startsWith('select')).length, 1)
  await worker.deactivate()
})

test('two panes limited on the same seat at once: one select, both resumed on the new seat', async () => {
  const w = world({
    panes: [
      { terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' },
      { terminalId: 'tB', agent: 'claude', state: 'done', sessionId: 'sB' }
    ],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT, tB: fx.CLAUDE_SESSION_LIMIT }
  })
  const worker = await w.mount()
  // Both launched on c1, as the launch hook records.
  await worker.hooks.fire('agent.launch.before', { agent: 'claude', workspaceId: 'w1', workspaceKind: 'worktree', terminalId: 't1', command: 'claude', env: {} })
  await worker.hooks.fire('agent.launch.before', { agent: 'claude', workspaceId: 'w1', workspaceKind: 'worktree', terminalId: 'tB', command: 'claude', env: {} })
  await Promise.all([worker.emit('agent.status.changed', statusEvent('t1')), worker.emit('agent.status.changed', statusEvent('tB'))])
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2'])
  assert.equal(w.host.callsOf('agent.resume').length, 2)
  const state = w.host.data().storage.state as RotatorState
  assert.deepEqual(Object.values(state.paneSeat).sort(), ['claude:c2', 'claude:c2'])
  await worker.deactivate()
})

test('unknown pane right after a swap is treated as still on the old seat', async () => {
  const w = world({
    panes: [
      { terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' },
      { terminalId: 'tB', agent: 'claude', state: 'done', sessionId: 'sB' }
    ],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT, tB: fx.CLAUDE_SESSION_LIMIT }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  await worker.emit('agent.status.changed', statusEvent('tB'))
  // tB is moved to c2 (already active), not pushed on to c3.
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2'])
  await worker.deactivate()
})

test('every seat exhausted: park, then resume when a seat frees up', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    state: {
      health: {
        'claude:c2': { cooldownUntil: 1_000_000 + 10 * 60_000 },
        'claude:c3': { cooldownUntil: 1_000_000 + 20 * 60_000 }
      }
    }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  let state = w.host.data().storage.state as RotatorState
  assert.equal(state.waiting.length, 1)
  assert.equal(state.waiting[0]!.wakeAt, 1_000_000 + 10 * 60_000)
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  w.advance(5 * 60_000)
  await w.rotator.tick()
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  w.advance(6 * 60_000)
  await w.rotator.tick()
  assert.ok(w.cliCalls.includes('select claude c2'))
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  state = w.host.data().storage.state as RotatorState
  assert.equal(state.waiting.length, 0)
  assert.equal(state.history.at(-1)?.reason, 'reset')
  await worker.deactivate()
})

test('API error: retry in place with backoff, no account change', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_API_ERROR }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 1))
  assert.deepEqual(w.typed, [{ terminalId: 't1', text: 'Go continue.' }])
  // A repeated event with no new output does nothing.
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 1))
  assert.equal(w.typed.length, 1)
  // The same error printed again after the retry (a new copy): retried again.
  w.tails.t1!.push('❯ Go continue.', ...fx.CLAUDE_API_ERROR)
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 2))
  assert.equal(w.typed.length, 2)
  assert.equal(w.cliCalls.filter((c) => c.startsWith('select')).length, 0)
  assert.equal((w.host.data().storage.state as RotatorState).apiRetries.t1, 2)
  await worker.deactivate()
})

test('model cap: switch model in place before rotating accounts', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_MODEL_CAP },
    settings: { model_fallback: 'claude=fable,sonnet' }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(w.typed.map((t) => t.text), ['/model sonnet', 'Go continue.'])
  assert.equal(w.cliCalls.filter((c) => c.startsWith('select')).length, 0)
  await worker.deactivate()
})

test('same service only: every Claude account limited parks the session, never hands to Codex', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    settings: { chain: 'claude:*, codex:*' },
    state: {
      health: {
        'claude:c2': { cooldownUntil: 1_000_000 + 60 * 60_000 },
        'claude:c3': { cooldownUntil: 1_000_000 + 60 * 60_000 }
      }
    }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.host.callsOf('agent.launch').length, 0)
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  assert.equal(w.cliCalls.filter((c) => c.startsWith('select')).length, 0)
  const state = w.host.data().storage.state as RotatorState
  assert.equal(state.waiting.length, 1)
  assert.equal(state.history.at(-1)?.result, 'waiting')
  await worker.deactivate()
})

test('Codex limit: next Codex account, continued by a same-service handoff with git context', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'codex', state: 'done', sessionId: 'cs1', title: 'fix parser' }],
    tails: { t1: fx.CODEX_USAGE_LIMIT }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  // x2 is at 100 % usage, so the next healthy Codex seat is the system login.
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select codex system'])
  const launches = w.host.callsOf('agent.launch') as { agent: string; prompt: string }[]
  assert.equal(launches.length, 1)
  assert.equal(launches[0]!.agent, 'codex')
  assert.match(launches[0]!.prompt, /git status --short:\n M src\/parser.ts/)
  assert.match(launches[0]!.prompt, /Session title: fix parser/)
  assert.match(launches[0]!.prompt, /usage limit/)
  const state = w.host.data().storage.state as RotatorState
  assert.equal(state.history.at(-1)?.result, 'handoff')
  assert.equal(state.paneSeat.t2, 'codex:system')
  await worker.deactivate()
})

test('threshold: a finished turn on a busy seat moves on; normal output never triggers', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'waiting', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_TALKING_ABOUT_LIMITS },
    claudeUsage: { session: 60, weekly: 10 },
    settings: { thresholds_five_hour: 50 }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1', 'waiting'))
  assert.ok(w.cliCalls.includes('select claude c2'))
  assert.equal((w.host.data().storage.state as RotatorState).history.at(-1)?.reason, 'threshold')

  const quiet = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_TALKING_ABOUT_LIMITS },
    claudeUsage: { session: 7, weekly: 18 }
  })
  const w2 = await quiet.mount()
  await w2.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(quiet.cliCalls.filter((c) => c.startsWith('select')).length, 0)
  assert.equal(quiet.host.callsOf('terminal.close').length, 0)
  await worker.deactivate()
  await w2.deactivate()
})

test('paused: nothing happens; panel requests and commands work', async () => {
  const w = world({ panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }], tails: { t1: fx.CLAUDE_SESSION_LIMIT } })
  const worker = await w.mount()
  assert.deepEqual(await worker.request('rotator.pause', { paused: true }), { paused: true })
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  const snap = await worker.request('rotator.snapshot', { refresh: true })
  assert.equal(snap.paused, true)
  assert.equal(snap.seats.length, 6)
  assert.match(await worker.command('rotator.togglePause') as string, /resumed/)
  assert.match(await worker.command('rotator.nextCodex') as string, /codex: new launches use/)
  assert.ok(w.cliCalls.includes('select codex system'), w.cliCalls.join(','))
  assert.deepEqual(await worker.request('rotator.select', { seatKey: 'claude:c3' }), { message: 'claude: new launches use me@example.test' })
  assert.ok(worker.posts.some((p) => p.event === 'rotator.changed'))
  assert.ok(w.host.callsOf('statusBar.update').length > 0)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('live bug: a resumed session redrawing the old banner does not cascade through every account', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    redraw: true
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(w.tails.t2, fx.CLAUDE_SESSION_LIMIT) // the new pane shows the old banner
  await worker.emit('agent.status.changed', statusEvent('t2', 'waiting'))
  await worker.emit('agent.status.changed', statusEvent('t2', 'done', 2))
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2'])
  // A real new limit on the new account (a new copy of a banner) still switches.
  w.tails.t2!.push('❯ Go continue.', '⏺ Continuing.', '  ⎿  5-hour limit reached ∙ resets 3pm')
  await worker.emit('agent.status.changed', statusEvent('t2', 'done', 3))
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2', 'select claude c3'])
  await worker.deactivate()
})

test('live bug: the redraw arrives after the plugin first reads the new pane — still no cascade', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    redraw: 'late'
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.match(w.tails.t2!.join('\n'), /5-hour limit reached[\s\S]*❯ Go continue\./)
  await worker.emit('agent.status.changed', statusEvent('t2', 'done', 2))
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2'])
  await worker.deactivate()
})

test('live bug: host send refused outside the focused workspace falls back to the CLI', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    refuseHostSend: true
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.ok(w.cliCalls.includes('send t2'), w.cliCalls.join(','))
  assert.deepEqual(w.typed, [{ terminalId: 't2', text: 'Go continue.' }])
  const state = w.host.data().storage.state as RotatorState
  assert.equal(state.history.at(-1)?.result, 'resumed')
  assert.equal(state.history.filter((h) => h.result === 'failed').length, 0)
  await worker.deactivate()
})

test('a service switched off is left alone; the others still switch', async () => {
  const w = world({
    panes: [
      { terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' },
      { terminalId: 'k1', agent: 'codex', state: 'done', sessionId: 'cs1' }
    ],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT, k1: fx.CODEX_USAGE_LIMIT },
    settings: { service_claude: false }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(w.cliCalls.filter((c) => c.startsWith('select claude')).length, 0)
  await worker.emit('agent.status.changed', statusEvent('k1'))
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select codex system'])
  // Turned back on from the panel: the next Claude limit switches.
  const out = await worker.request('rotator.setService', { provider: 'claude', enabled: true })
  assert.equal(out.services.claude, true)
  assert.equal(w.host.data().settings.service_claude, true)
  w.tails.t1!.push('❯ Go continue.', '  ⎿  5-hour limit reached ∙ resets 3pm')
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 2))
  assert.ok(w.cliCalls.includes('select claude c2'), w.cliCalls.join(','))
  const snap = await worker.request('rotator.snapshot', {})
  assert.equal(snap.services.claude, true)
  await assert.rejects(worker.request('rotator.setService', { provider: 'gpt', enabled: true }))
  await worker.deactivate()
})

test('live bug: Orca restores a handled session in a new pane — its redrawn banner is not new', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2'])
  // Orca reopens session s1 in a pane the plugin has never seen (restores are not hooked).
  w.panes.push({ terminalId: 'tR', agent: 'claude', state: 'waiting', sessionId: 's1' })
  w.tails.tR = [...fx.CLAUDE_SESSION_LIMIT]
  await worker.emit('agent.status.changed', statusEvent('tR', 'waiting'))
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2'])
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  await worker.deactivate()
})

test('banners seen while paused are not acted on after resuming switching', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT }
  })
  const worker = await w.mount()
  await worker.request('rotator.pause', { paused: true })
  await worker.emit('agent.status.changed', statusEvent('t1'))
  await worker.request('rotator.pause', { paused: false })
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 2))
  assert.equal(w.cliCalls.filter((c) => c.startsWith('select')).length, 0)
  // A new limit after resuming does switch.
  w.tails.t1!.push('❯ go on', '  ⎿  5-hour limit reached ∙ resets 3pm')
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 3))
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2'])
  await worker.deactivate()
})

test('review: an unknown pane hits a limit while the active account has room → resume it there, cool nothing', async () => {
  const w = world({
    panes: [{ terminalId: 'old', agent: 'claude', state: 'done', sessionId: 's9' }],
    tails: { old: fx.CLAUDE_SESSION_LIMIT },
    claudeUsage: { session: 7, weekly: 18 }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('old'))
  assert.equal(w.cliCalls.filter((c) => c.startsWith('select')).length, 0)
  assert.deepEqual(w.host.callsOf('agent.resume'), [{ workspaceId: 'w1', agent: 'claude', sessionId: 's9' }])
  const state = w.host.data().storage.state as RotatorState
  assert.deepEqual(state.health, {})
  assert.equal(state.paneSeat.t2, 'claude:c1') // known from now on: a second limit there rotates
  await worker.deactivate()
})

test('status bar text', () => {
  const s = statusText({
    paused: false,
    updatedAt: 0,
    services: { claude: true, codex: true, antigravity: true, opencode: true, devin: true },
    waiting: [],
    history: [],
    seats: [
      { key: 'claude:a', provider: 'claude', accountId: 'a', label: 'a', active: false, usage: { known: false } },
      { key: 'claude:b', provider: 'claude', accountId: 'b', label: 'b', active: true, usage: { known: true, session: { usedPercent: 85, resetsAt: null }, weekly: { usedPercent: 18.4, resetsAt: null } } }
    ]
  })
  assert.equal(s.text, 'claude 2/2 · 85%·18%')
  assert.equal(s.tone, 'warning')
  const off = statusText({
    paused: false,
    updatedAt: 0,
    services: { claude: false, codex: true, antigravity: true, opencode: true, devin: true },
    waiting: [],
    history: [],
    seats: [
      { key: 'claude:a', provider: 'claude', accountId: 'a', label: 'a', active: true, usage: { known: false } },
      { key: 'claude:b', provider: 'claude', accountId: 'b', label: 'b', active: false, usage: { known: false } }
    ]
  })
  assert.equal(off.text, 'claude off')
})
