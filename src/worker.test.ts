// End-to-end through the real worker: Orca events in, host calls and CLI calls out.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { Rotator, type Cli } from './engine'
import * as fx from './fixtures'
import { activateWith, readConfig, resolveMode, statusText } from './worker'
import { DEFAULT_CONFIG, SMART_CONFIG, type Config, type RotatorState } from './types'

type Pane = { terminalId: string; agent: string; state: 'working' | 'waiting' | 'done' | 'blocked'; sessionId?: string; title?: string; stateStartedAt?: number }

function world(options: {
  panes: Pane[]
  tails: Record<string, string[]>
  /** Orca's numbers for the active accounts; by default they are exhausted, as they are when a
   *  pane on them hits a limit. */
  claudeUsage?: { session: number; weekly: number; sessionReset?: number; weeklyReset?: number }
  codexUsage?: { session: number; weekly: number }
  /** Orca's numbers for a Claude account switched to later (default: plenty of room). */
  laterClaudeUsage?: { session: number; weekly: number }
  /** Claude accounts not in use that Orca has numbers for (read on every list, so a test can
   *  change it); by default Orca reports nothing for them. */
  inactiveClaude?: Record<string, { session: number; weekly: number; fable?: number }>
  settings?: Record<string, string | number | boolean>
  state?: Partial<RotatorState>
  /** Resumed sessions redraw their transcript, as live Claude does; `late` = only after the
   *  first message arrives (live: the redraw raced the plugin's first read). */
  redraw?: boolean | 'late'
  /** Live Orca refuses plugin sends outside the focused workspace. */
  refuseHostSend?: boolean
  /** `orca account select` fails for these account ids. */
  failSelect?: string[]
  /** Terminals in the active tab of each workspace (`orca terminal list --include-visual-layouts`). */
  activeTerminals?: string[]
  /** Called when the plugin waits (a backoff, a settle delay), with the wait in ms. */
  onSleep?: (ms: number) => void
  /** While it returns true, Orca cannot list agents (`agents.list` fails). */
  agentsListFails?: () => boolean
  /** Unsent text Orca reports apart from the screen lines (`orca terminal read` → `draft`), by
   *  terminal; read on every look, so a test can change it. `'!'` makes that read fail. */
  drafts?: Record<string, string>
  /** Called while the CLI lists the active terminals (live: a process that takes a moment). */
  onActiveTerminals?: () => Promise<void>
  /** Called while the CLI lists the accounts (live: about 3 s). */
  onListAccounts?: () => Promise<void>
  /** While it returns true, `orca terminal send` fails (live: the pane is gone, or the CLI is). */
  failSend?: () => boolean
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
      await options.onListAccounts?.()
      const result = accountListFor()
      return result
    },
    async select(provider, accountId) {
      cliCalls.push(`select ${provider} ${accountId}`)
      if (options.failSelect?.includes(accountId)) throw new Error(`account ${accountId} needs sign-in`)
      if (provider === 'claude') claudeActive = accountId === 'system' ? null : accountId
      if (provider === 'codex') codexActive = accountId === 'system' ? null : accountId
    },
    async closeTerminal(id) {
      cliCalls.push(`close ${id}`)
    },
    async activeTerminals() {
      await options.onActiveTerminals?.()
      return options.activeTerminals ?? []
    },
    async draft(terminalId) {
      const text = options.drafts?.[terminalId]
      if (text === '!') throw new Error('orca terminal read: runtime_unavailable')
      return text
    },
    async sendText(terminalId, text) {
      cliCalls.push(`send ${terminalId}`)
      if (options.failSend?.()) throw new Error('orca terminal send: terminal_not_found')
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
      // Orca stamps each reading when it takes it.
      updatedAt: clock,
      ...(options.inactiveClaude ? { inactiveClaude: options.inactiveClaude } : {}),
      // The given (or exhausted) numbers belong to the first active account; an account
      // switched to later has room.
      claudeUsage: claudeActive === 'c1' ? options.claudeUsage ?? { session: 100, weekly: 40 } : options.laterClaudeUsage ?? { session: 5, weekly: 5 },
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
      'agents.list': () => {
        if (options.agentsListFails?.()) throw Object.assign(new Error('selector_not_found'), { code: 'action_failed' })
        return { agents: panes.map((p) => ({ title: null, task: null, stateStartedAt: 1, sessionId: null, ...p })) }
      },
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
        { cli, now: () => clock, sleep: async (ms: number) => options.onSleep?.(ms) },
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
    /** The pane's state changed now (live: `stateStartedAt` moves with every turn). */
    touch(terminalId: string) {
      const p = panes.find((x) => x.terminalId === terminalId)
      if (p) p.stateStartedAt = clock
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
  // It is recorded as leaving c1, the seat that was limited, not the one just selected.
  const moves = (w.host.data().storage.state as RotatorState).history.filter((h) => h.result === 'resumed')
  assert.deepEqual(moves.map((h) => [h.from, h.to]), [['claude:c1', 'claude:c2'], ['claude:c1', 'claude:c2']])
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

const DRAFT_BOX = ['╭──────────────╮', '│ > also update the docs', '╰──────────────╯']

test('API error: the retry never types into a pane that holds unsent text, or that works again', async () => {
  // Unsent text already in the input box when the error shows.
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [...fx.CLAUDE_API_ERROR, ...DRAFT_BOX] }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(w.typed, [])
  assert.equal(w.cliCalls.filter((c) => c.startsWith('send')).length, 0)
  const last = (w.host.data().storage.state as RotatorState).history.at(-1)
  assert.equal(last?.reason, 'api_error')
  assert.equal(last?.result, 'failed')
  assert.match(last?.detail ?? '', /unsent text/)
  assert.match((w.host.callsOf('notifications.show') as { body?: string }[]).at(-1)?.body ?? '', /unsent text/)
  await worker.deactivate()

  // The user starts typing during the backoff.
  const tails: Record<string, string[]> = { t1: [...fx.CLAUDE_API_ERROR] }
  const during = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails,
    onSleep: () => {
      tails.t1 = [...fx.CLAUDE_API_ERROR, ...DRAFT_BOX]
    }
  })
  const dw = await during.mount()
  await dw.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(during.typed, [])
  assert.match((during.host.data().storage.state as RotatorState).history.at(-1)?.detail ?? '', /unsent text/)
  await dw.deactivate()

  // The user sent a message during the backoff: the agent is in the middle of a turn.
  const busy = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [...fx.CLAUDE_API_ERROR] },
    onSleep: () => {
      busy.panes[0]!.state = 'working'
    }
  })
  const bw = await busy.mount()
  await bw.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(busy.typed, [])
  await bw.deactivate()
})

test('model cap: the fallback model is never typed into a pane that holds unsent text', async () => {
  for (const mode of ['smart', 'custom']) {
    const w = world({
      panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
      tails: { t1: [...fx.CLAUDE_MODEL_CAP, ...DRAFT_BOX] },
      settings: { mode, model_fallback: 'claude=fable,sonnet' }
    })
    const worker = await w.mount()
    await worker.emit('agent.status.changed', statusEvent('t1'))
    // Neither `/model sonnet` nor the first message: both would send the user's text.
    assert.deepEqual(w.typed, [], mode)
    assert.equal(w.cliCalls.filter((c) => c.startsWith('send')).length, 0)
    assert.equal(w.host.callsOf('terminal.close').length, 0)
    const state = w.host.data().storage.state as RotatorState
    const last = state.history.at(-1)
    assert.equal(last?.reason, 'model_cap')
    assert.equal(last?.result, 'failed')
    assert.match(last?.detail ?? '', /unsent text/)
    // The fallback model is still there for the next time.
    assert.equal(state.modelStep.t1 ?? 0, 0)
    assert.match((w.host.callsOf('notifications.show') as { body?: string }[]).at(-1)?.body ?? '', /unsent text/)
    await worker.deactivate()
  }
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
    // A threshold move needs a target with known room.
    inactiveClaude: { c2: { session: 5, weekly: 5 } },
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
  assert.match(await worker.command('rotator.nextCodex') as string, /Codex: new launches use/)
  assert.ok(w.cliCalls.includes('select codex system'), w.cliCalls.join(','))
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

test('review: a resumed pane read before its transcript is redrawn does not forget the handled banner', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2'])
  // The new pane reports ready while it is still empty (live: the redraw raced the first read)…
  w.tails.t2 = []
  await worker.emit('agent.status.changed', statusEvent('t2', 'waiting'))
  // …then draws the old transcript, and the agent answers briefly.
  w.tails.t2 = [...fx.CLAUDE_SESSION_LIMIT, '❯ Go continue.', '⏺ Continuing.']
  await worker.emit('agent.status.changed', statusEvent('t2', 'done', 2))
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2'])
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  await worker.deactivate()
})

test('review: a handled banner that scrolled out of a full read window counts again', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    settings: { auto_resume: false }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2'])
  // The user goes on in the same pane; 80 lines later the old banner is out of the read window.
  w.tails.t1 = Array.from({ length: 80 }, (_, i) => `  line ${i}`)
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 2))
  w.tails.t1 = [...Array.from({ length: 77 }, (_, i) => `  line ${i}`), ...fx.CLAUDE_SESSION_LIMIT.slice(2, 4)]
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 3))
  // Handled as a new limit (c2 is already selected, so there is no second select).
  const state = w.host.data().storage.state as RotatorState
  assert.equal(state.history.filter((h) => h.reason === 'rate_limit').length, 2)
  await worker.deactivate()
})

test('review: a parked session the user went on with is not closed and resumed at wake time', async () => {
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
  assert.equal((w.host.data().storage.state as RotatorState).waiting.length, 1)
  // The limit lifted early; the user typed in the parked pane and the agent finished a turn.
  w.tails.t1!.push('❯ carry on', '⏺ Done.', '  All 12 tests pass.', '  Nothing else is left to do.', '  The branch is ready for review.', '  See the summary above.')
  w.touch('t1')
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 2))
  assert.equal((w.host.data().storage.state as RotatorState).waiting.length, 0)
  w.advance(11 * 60_000)
  await w.rotator.tick()
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  assert.deepEqual(w.typed, [])
  await worker.deactivate()
})

test('review: every account over a threshold does not rotate (and type) forever', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'waiting', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_TALKING_ABOUT_LIMITS },
    claudeUsage: { session: 60, weekly: 10 },
    laterClaudeUsage: { session: 70, weekly: 10 },
    // Orca's (older) numbers for the accounts not in use show room: a threshold move needs that.
    inactiveClaude: { c2: { session: 5, weekly: 5 }, c3: { session: 5, weekly: 5 } },
    settings: { thresholds_five_hour: 50 },
    redraw: true
  })
  const worker = await w.mount()
  // Each resumed pane ends its turn on an account that is over the threshold too.
  for (const id of ['t1', 't2', 't3', 't4', 't5']) {
    w.advance(6 * 60_000) // past the usage poll interval and the selection cooldown
    if (w.panes.some((p) => p.terminalId === id)) await worker.emit('agent.status.changed', statusEvent(id, 'waiting'))
  }
  // c1 → c2 → c3, then it stays: c1 and c2 are still over until their windows reset.
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2', 'select claude c3'])
  assert.equal(w.host.callsOf('agent.resume').length, 2)
  const state = w.host.data().storage.state as RotatorState
  assert.equal(state.health['claude:c1']?.cooldownUntil, 1_000_000 + 3_600_000)
  assert.equal(state.waiting.length, 0)
  await worker.deactivate()
})

test('switch back: once the first account resets, new launches use it and a pane moves back at turn end', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    settings: { auto_swap_idle_after_seconds: 0 }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2'])
  // Still limited: nothing moves back.
  w.advance(2 * 60_000)
  await w.rotator.tick()
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2'])
  // Two days later every window has reset: c1 is preferred again.
  w.advance(48 * 3_600_000)
  await w.rotator.tick()
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2', 'select claude c1'])
  let state = w.host.data().storage.state as RotatorState
  assert.deepEqual(state.history.at(-1), { ...state.history.at(-1), reason: 'switch_back', result: 'selected', from: 'claude:c2', to: 'claude:c1' })
  // Idle moves are off: the pane stays on c2 until it ends a turn.
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  await worker.emit('agent.status.changed', statusEvent('t2', 'done', 2))
  assert.equal(w.host.callsOf('agent.resume').length, 2)
  assert.deepEqual(w.host.callsOf('terminal.close').map((c: any) => c.terminalId), ['t1', 't2'])
  assert.deepEqual(w.typed.at(-1), { terminalId: 't3', text: 'Go continue.' })
  state = w.host.data().storage.state as RotatorState
  assert.equal(state.paneSeat.t3, 'claude:c1')
  assert.equal(state.history.at(-1)?.reason, 'switch_back')
  assert.equal(state.history.at(-1)?.result, 'resumed')
  // Nothing further to do on the next tick.
  await w.rotator.tick()
  assert.equal(w.host.callsOf('agent.resume').length, 2)
  await worker.deactivate()
})

test('switch back: an idle pane on the backup account moves without waiting for a turn', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    // Switch-back belongs to the legacy strategies; the default mode (Smart) has no preferred account.
    settings: { mode: 'custom' }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  w.advance(48 * 3_600_000)
  await w.rotator.tick()
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2', 'select claude c1'])
  assert.equal(w.host.callsOf('agent.resume').length, 2)
  assert.deepEqual(w.typed.at(-1), { terminalId: 't3', text: 'Go continue.' })
  assert.equal((w.host.data().storage.state as RotatorState).paneSeat.t3, 'claude:c1')
  await worker.deactivate()
})

test('switch back is off for balanced, and never closes a pane with unsent text', async () => {
  const balanced = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    settings: { strategy: 'balanced' }
  })
  let worker = await balanced.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  balanced.advance(48 * 3_600_000)
  await balanced.rotator.tick()
  assert.equal(balanced.cliCalls.filter((c) => c.startsWith('select')).length, 1)
  await worker.deactivate()

  const draft = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    settings: { mode: 'custom' }
  })
  worker = await draft.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  draft.tails.t2 = ['⏺ Done.', '╭──────────────╮', '│ > also update the docs', '╰──────────────╯']
  draft.advance(48 * 3_600_000)
  await draft.rotator.tick()
  // The selection moved back, the pane with the draft did not.
  assert.deepEqual(draft.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2', 'select claude c1'])
  assert.equal(draft.host.callsOf('agent.resume').length, 1)
  await worker.emit('agent.status.changed', statusEvent('t2', 'done', 2))
  assert.equal(draft.host.callsOf('agent.resume').length, 1)
  // Draft sent: the next turn end moves it.
  draft.tails.t2 = ['❯ also update the docs', '⏺ Updated README.md.', '╭──────────────╮', '│ >', '╰──────────────╯']
  await worker.emit('agent.status.changed', statusEvent('t2', 'done', 3))
  assert.equal(draft.host.callsOf('agent.resume').length, 2)
  await worker.deactivate()
})

test('a seat that fails to switch is skipped for ten minutes; the rotation moves on', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    failSelect: ['c2']
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  let state = w.host.data().storage.state as RotatorState
  assert.equal(state.history.at(-1)?.result, 'failed')
  assert.equal(state.health['claude:c2']?.cooldownUntil, 1_000_000 + 10 * 60_000)
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  // The banner is printed again: c2 is skipped, c3 taken.
  w.tails.t1!.push('❯ Go continue.', '  ⎿  5-hour limit reached ∙ resets 3pm')
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 2))
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2', 'select claude c3'])
  state = w.host.data().storage.state as RotatorState
  assert.equal(state.history.at(-1)?.result, 'resumed')
  await worker.deactivate()
})

// ---- deciding with no data ----------------------------------------------------------------------

const MIN = 60_000
const selects = (w: { cliCalls: string[] }) => w.cliCalls.filter((c) => c.startsWith('select'))
const stored = (w: { host: { data(): { storage: Record<string, unknown> } } }) => w.host.data().storage.state as RotatorState

test('no data: a limit takes an account with known room before one Orca has no numbers for', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    inactiveClaude: { c3: { session: 5, weekly: 5 } }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  // Chain order says c2, but nothing is known about c2.
  assert.deepEqual(selects(w), ['select claude c3'])
  // The landing was not blind: no probation.
  assert.deepEqual(stored(w).probation, {})
  await worker.deactivate()
})

test('no data: each banner without a reset time on an unknown account is a strike; the cooldown doubles up to 5 h', async () => {
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5']
  const w = world({
    panes: ids.map((terminalId) => ({ terminalId, agent: 'claude', state: 'done' as const, sessionId: `s-${terminalId}` })),
    tails: Object.fromEntries(ids.map((id) => [id, fx.CLAUDE_LIMIT_NO_RESET])),
    claudeUsage: { session: 5, weekly: 5 },
    settings: { auto_resume: false },
    // Every pane runs on c2, which Orca reports nothing for.
    state: { paneSeat: Object.fromEntries(ids.map((id) => [id, 'claude:c2'])) }
  })
  const worker = await w.mount()
  let now = 1_000_000
  const expected = [60, 120, 240, 300, 300]
  for (const [i, id] of ids.entries()) {
    await worker.emit('agent.status.changed', statusEvent(id))
    const h = stored(w).health['claude:c2']!
    assert.equal(h.strikes, i + 1)
    assert.equal(h.strikeAt, now)
    assert.equal(h.cooldownUntil, now + expected[i]! * MIN)
    // A guessed cooldown: nothing but the cooldown and the strike is noted, no known reset.
    assert.deepEqual(Object.keys(h).sort(), ['cooldownUntil', 'reason', 'strikeAt', 'strikes'])
    // While it cools it is not a target.
    assert.equal(selects(w).length, 0)
    w.advance(expected[i]! * MIN + MIN)
    now += expected[i]! * MIN + MIN
    await w.rotator.tick()
    // The cooldown is over; the strikes are not.
    const after = stored(w).health['claude:c2']!
    assert.equal(after.cooldownUntil, undefined)
    assert.equal(after.reason, undefined)
    assert.equal(after.freedAt, now)
    assert.equal(after.strikes, i + 1)
  }
  // 24 h after the last strike they lapse, and the entry goes.
  w.advance(24 * 60 * MIN)
  await w.rotator.tick()
  assert.equal(stored(w).health['claude:c2'], undefined)
  await worker.deactivate()
})

test('no data: two panes showing the same limit on an unknown account are one strike', async () => {
  const w = world({
    panes: [
      { terminalId: 'p1', agent: 'claude', state: 'done', sessionId: 'sa' },
      { terminalId: 'p2', agent: 'claude', state: 'done', sessionId: 'sb' }
    ],
    tails: { p1: fx.CLAUDE_LIMIT_NO_RESET, p2: fx.CLAUDE_LIMIT_NO_RESET },
    claudeUsage: { session: 5, weekly: 5 },
    state: { paneSeat: { p1: 'claude:c2', p2: 'claude:c2' } }
  })
  const worker = await w.mount()
  await Promise.all([worker.emit('agent.status.changed', statusEvent('p1')), worker.emit('agent.status.changed', statusEvent('p2'))])
  assert.equal(stored(w).health['claude:c2']?.strikes, 1)
  assert.equal(stored(w).health['claude:c2']?.cooldownUntil, 1_000_000 + 60 * MIN)
  assert.equal(w.host.callsOf('agent.resume').length, 2)
  await worker.deactivate()
})

test('no data: strikes are cleared by a current reading with room, not by a remembered or an exhausted one', async () => {
  const inactiveClaude: Record<string, { session: number; weekly: number }> = { c2: { session: 20, weekly: 10 } }
  const w = world({ panes: [], tails: {}, claudeUsage: { session: 5, weekly: 5 }, inactiveClaude })
  const worker = await w.mount()
  // Orca stops reporting c2; then c2 is struck.
  delete inactiveClaude.c2
  w.rotator.state.health['claude:c2'] = { strikes: 2, strikeAt: 1_000_000 + MIN }
  w.advance(2 * MIN)
  let view = await w.rotator.accounts(true)
  assert.equal(view.seats.find((s) => s.key === 'claude:c2')!.usage.source, 'cached')
  assert.equal(w.rotator.state.health['claude:c2']?.strikes, 2)
  // A current reading, but at the limit.
  inactiveClaude.c2 = { session: 100, weekly: 10 }
  w.advance(2 * MIN)
  await w.rotator.accounts(true)
  assert.equal(w.rotator.state.health['claude:c2']?.strikes, 2)
  // A current reading with room.
  inactiveClaude.c2 = { session: 30, weekly: 10 }
  w.advance(2 * MIN)
  view = await w.rotator.accounts(true)
  assert.equal(view.seats.find((s) => s.key === 'claude:c2')!.usage.source, 'live')
  assert.equal(w.rotator.state.health['claude:c2'], undefined)
  assert.equal(stored(w).health['claude:c2'], undefined)
  await worker.deactivate()
})

test('no data: a finished turn without a banner clears the strikes of the account it ran on', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_TALKING_ABOUT_LIMITS },
    claudeUsage: { session: 5, weekly: 5 },
    settings: { switch_back: false },
    state: {
      paneSeat: { t1: 'claude:c2' },
      health: { 'claude:c2': { strikes: 2, strikeAt: 1_000_000 - 5 * MIN }, 'claude:c3': { strikes: 1, strikeAt: 1_000_000 - 5 * MIN } }
    }
  })
  const worker = await w.mount()
  // Waiting for input is not a finished turn.
  await worker.emit('agent.status.changed', statusEvent('t1', 'waiting'))
  assert.equal(stored(w).health['claude:c2']?.strikes, 2)
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 2))
  assert.equal(stored(w).health['claude:c2'], undefined)
  // Another account's strikes stay.
  assert.equal(stored(w).health['claude:c3']?.strikes, 1)
  assert.equal(selects(w).length, 0)
  await worker.deactivate()
})

test('no data: a threshold move needs a known target, unless the account is at 100 % and none is known', async () => {
  // 60 % of a 50 % threshold, and nothing known about the other accounts: stay.
  const stay = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'waiting', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_TALKING_ABOUT_LIMITS },
    claudeUsage: { session: 60, weekly: 10 },
    settings: { thresholds_five_hour: 50 }
  })
  let worker = await stay.mount()
  await worker.emit('agent.status.changed', statusEvent('t1', 'waiting'))
  assert.equal(selects(stay).length, 0)
  assert.equal(stay.host.callsOf('terminal.close').length, 0)
  assert.equal(stored(stay).waiting.length, 0)
  await worker.deactivate()

  // Known to be at 100 % (no banner yet): an unknown account is better than a certain failure.
  const leave = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'waiting', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_TALKING_ABOUT_LIMITS }
  })
  worker = await leave.mount()
  await worker.emit('agent.status.changed', statusEvent('t1', 'waiting'))
  assert.deepEqual(selects(leave), ['select claude c2'])
  assert.equal(stored(leave).history.at(-1)?.reason, 'threshold')
  assert.equal(stored(leave).probation?.claude?.key, 'claude:c2')
  await worker.deactivate()
})

test('no data: after landing on an unknown account, advisory moves wait out the probation', async () => {
  const inactiveClaude: Record<string, { session: number; weekly: number }> = {}
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    laterClaudeUsage: { session: 60, weekly: 10 },
    inactiveClaude,
    settings: { thresholds_five_hour: 50 }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(w), ['select claude c2'])
  // max(10 min, 2 × the 5-minute selection cooldown).
  assert.deepEqual(stored(w).probation?.claude, { key: 'claude:c2', until: 1_000_000 + 10 * MIN })
  // c2 turns out to be over the threshold, and c3 is now known to have room.
  inactiveClaude.c3 = { session: 5, weekly: 5 }
  w.tails.t2 = [...fx.CLAUDE_TALKING_ABOUT_LIMITS]
  w.advance(6 * MIN)
  await worker.emit('agent.status.changed', statusEvent('t2', 'waiting', 2))
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  // Probation over: the same turn end now moves on.
  w.advance(5 * MIN)
  await worker.emit('agent.status.changed', statusEvent('t2', 'waiting', 3))
  assert.deepEqual(selects(w), ['select claude c2', 'select claude c3'])
  assert.equal(stored(w).history.at(-1)?.reason, 'threshold')
  await worker.deactivate()
})

test('no data: a banner on the account under probation is a strike; after probation it is not', async () => {
  const run = async (waitMs: number) => {
    const w = world({
      panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
      tails: { t1: fx.CLAUDE_SESSION_LIMIT }
    })
    const worker = await w.mount()
    await worker.emit('agent.status.changed', statusEvent('t1'))
    assert.deepEqual(selects(w), ['select claude c2'])
    w.advance(waitMs)
    await w.rotator.tick()
    // c2 is in use now, so Orca has numbers for it; the banner names a reset time.
    w.tails.t2 = ['⏺ Continuing.', '  ⎿  Weekly limit reached ∙ resets 3pm']
    await worker.emit('agent.status.changed', statusEvent('t2', 'done', 2))
    assert.deepEqual(selects(w), ['select claude c2', 'select claude c3'])
    const h = stored(w).health['claude:c2']!
    await worker.deactivate()
    return h
  }
  const during = await run(2 * MIN)
  assert.equal(during.strikes, 1)
  assert.equal(during.resetKnown, true)
  assert.ok(during.cooldownUntil! > 1_000_000)
  const after = await run(11 * MIN)
  assert.equal(after.strikes, undefined)
  assert.equal(after.resetKnown, true)
})

/** c2 is ahead of the selected c1 in the chain; a pane runs on c1. */
const behind = (state: Partial<RotatorState> = {}, known?: { c1: number; c2: number }) =>
  world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_TALKING_ABOUT_LIMITS },
    claudeUsage: { session: 5, weekly: known?.c1 ?? 5 },
    ...(known ? { inactiveClaude: { c2: { session: 5, weekly: known.c2 } } } : {}),
    settings: { chain: 'claude:c2, claude:c1, claude:c3', auto_swap_idle_after_seconds: 0 },
    state: { paneSeat: { t1: 'claude:c1' }, ...state }
  })

test('no data, switch back: an unknown account is selected for new launches once; running panes wait until it is known', async () => {
  const w = behind()
  const worker = await w.mount()
  // A running session is not closed and resumed on an account nothing is known about.
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(selects(w).length, 0)
  // New launches: the selection moves, which is also what makes Orca fetch that account.
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.deepEqual(stored(w).history.at(-1), { ...stored(w).history.at(-1), reason: 'switch_back', result: 'selected', from: 'claude:c1', to: 'claude:c2' })
  assert.equal(stored(w).probation?.claude?.key, 'claude:c2')
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  // Once: nothing more on later ticks, and the pane stays during probation.
  w.advance(2 * MIN)
  await w.rotator.tick()
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 2))
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  // After probation c2 is in use and known: the pane follows.
  w.advance(9 * MIN)
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 3))
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  assert.equal(stored(w).paneSeat.t2, 'claude:c2')
  assert.deepEqual(selects(w), ['select claude c2'])
  await worker.deactivate()
})

test('no data, switch back: an unknown account with a strike is not selected, even for new launches', async () => {
  const w = behind({ health: { 'claude:c2': { strikes: 1, strikeAt: 1_000_000 - 60 * MIN } } })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  await w.rotator.tick()
  w.advance(20 * MIN)
  await w.rotator.tick()
  assert.equal(selects(w).length, 0)
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  await worker.deactivate()
})

test('no data, switch back: a presumed-reset account takes a running pane once; a banner there ends the presumption', async () => {
  const w = behind({ health: { 'claude:c2': { resetKnown: true, freedAt: 1_000_000 - 1000 } } })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  assert.equal(stored(w).paneSeat.t2, 'claude:c2')
  assert.equal(stored(w).history.at(-1)?.reason, 'switch_back')
  assert.equal(stored(w).probation?.claude?.key, 'claude:c2')
  // The presumption was wrong: the session hits a limit there.
  w.tails.t2 = ['⏺ Continuing.', '  ⎿  Weekly limit reached ∙ resets 3pm']
  await worker.emit('agent.status.changed', statusEvent('t2', 'done', 2))
  assert.deepEqual(selects(w), ['select claude c2', 'select claude c1'])
  assert.equal(stored(w).health['claude:c2']?.strikes, 1)
  await worker.deactivate()
})

test('no data, switch back: a known account takes a running pane at once, without probation', async () => {
  // Both known, and c2 has clearly more room (the headroom gap applies to known numbers, as before).
  const w = behind({}, { c1: 40, c2: 5 })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  assert.deepEqual(stored(w).probation, {})
  await worker.deactivate()
})

test('no data: paused, or the service off, means no move at all', async () => {
  for (const off of ['paused', 'service'] as const) {
    const w = world({
      panes: [
        { terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' },
        { terminalId: 't9', agent: 'claude', state: 'done', sessionId: 's9', stateStartedAt: 1 }
      ],
      tails: { t1: fx.CLAUDE_LIMIT_NO_RESET, t9: fx.CLAUDE_TALKING_ABOUT_LIMITS },
      // c2 is ahead of the selected c1 and presumed reset: a switch-back target for panes and launches.
      settings: { chain: 'claude:c2, claude:c1, claude:c3', ...(off === 'service' ? { service_claude: false } : {}) },
      state: { paneSeat: { t1: 'claude:c1', t9: 'claude:c1' }, health: { 'claude:c2': { resetKnown: true, freedAt: 1_000_000 - 1000 } } }
    })
    const worker = await w.mount()
    if (off === 'paused') await worker.request('rotator.pause', { paused: true })
    await worker.emit('agent.status.changed', statusEvent('t1'))
    await worker.emit('agent.status.changed', statusEvent('t9'))
    w.advance(20 * MIN)
    await w.rotator.tick()
    w.advance(20 * MIN)
    await w.rotator.tick()
    assert.equal(selects(w).length, 0, off)
    assert.equal(w.host.callsOf('terminal.close').length, 0, off)
    assert.equal(w.host.callsOf('agent.resume').length, 0, off)
    assert.deepEqual(w.typed, [], off)
    const state = stored(w)
    assert.equal(state.health['claude:c1'], undefined, off)
    assert.equal(state.probation?.claude, undefined, off)
    assert.equal(state.history.length, 0, off)
    await worker.deactivate()
  }
})

test('no data: state stored by an older version (cooldowns only, no strikes or probation) loads and works', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    state: {
      health: {
        'claude:c2': { cooldownUntil: 1_000_000 - 1, reason: 'rate_limit: old banner' },
        'claude:c3': { cooldownUntil: 1_000_000 + 60 * MIN, reason: 'rate_limit: old banner' }
      }
    }
  })
  assert.equal('probation' in (w.host.data().storage.state as object), false)
  const worker = await w.mount()
  assert.deepEqual(w.rotator.state.probation, {})
  await w.rotator.tick()
  // The expired old cooldown says nothing about a reset: the entry simply goes. The running one stays.
  assert.equal(stored(w).health['claude:c2'], undefined)
  assert.deepEqual(stored(w).health['claude:c3'], { cooldownUntil: 1_000_000 + 60 * MIN, reason: 'rate_limit: old banner' })
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.equal(stored(w).history.at(-1)?.result, 'resumed')
  assert.equal(stored(w).health['claude:c1']?.resetKnown, true)
  assert.equal(stored(w).probation?.claude?.key, 'claude:c2')
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
  assert.equal(s.text, 'Claude 2/2 · 85%·18%')
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
  assert.equal(off.text, 'Claude off')
})

test('swap history keeps 7 days and cleans itself up', async () => {
  const DAY = 86_400_000
  const w = world({
    panes: [],
    tails: {},
    state: {
      history: [
        { at: 1_000_000 - 8 * DAY, provider: 'claude', reason: 'rate_limit', result: 'resumed', from: 'claude:c1', to: 'claude:c2' },
        { at: 1_000_000 - 6 * DAY, provider: 'claude', reason: 'rate_limit', result: 'resumed', from: 'claude:c2', to: 'claude:c3' },
        { at: 1_000_000 - 60_000, provider: 'codex', reason: 'manual', result: 'selected', from: 'codex:x1', to: 'codex:x2' }
      ]
    }
  })
  const worker = await w.mount()
  // Loading drops what is older than 7 days.
  let state = w.host.data().storage.state as RotatorState
  assert.deepEqual(state.history.map((h) => h.to), ['claude:c3', 'codex:x2'])
  // Time passes: the tick cleans up on its own.
  w.advance(2 * DAY)
  await w.rotator.tick()
  state = w.host.data().storage.state as RotatorState
  assert.deepEqual(state.history.map((h) => h.to), ['codex:x2'])
  assert.deepEqual((await worker.request('rotator.snapshot', {})).history.map((h) => h.to), ['codex:x2'])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('the snapshot names the service of the agent the user is working with', async () => {
  const w = world({
    panes: [
      { terminalId: 't1', agent: 'claude', state: 'working', stateStartedAt: 10 },
      { terminalId: 't2', agent: 'codex', state: 'working', stateStartedAt: 20 }
    ],
    tails: {}
  })
  const worker = await w.mount()
  // Without a layout listing, the agent whose state changed last stands in for the focused pane.
  assert.equal((await worker.request('rotator.snapshot', {})).focused, 'codex')
})

test('the agent in the active terminal tab wins over the most recently changed one', async () => {
  const options: Parameters<typeof world>[0] = {
    panes: [
      { terminalId: 't1', agent: 'claude', state: 'working', stateStartedAt: 10 },
      { terminalId: 't2', agent: 'codex', state: 'working', stateStartedAt: 20 }
    ],
    tails: {},
    activeTerminals: ['t1']
  }
  const w = world(options)
  const worker = await w.mount()
  assert.deepEqual(await worker.request('rotator.focus', {}), { focused: 'claude' })
  // The user switches tabs: the panel's next poll sees it.
  options.activeTerminals = ['t2']
  assert.deepEqual(await worker.request('rotator.focus', {}), { focused: 'codex' })
  assert.equal((await worker.request('rotator.snapshot', {})).focused, 'codex')
})

test('focus reads never overlap: the panel poll, the tick and an event share one terminal listing, and a read asked for meanwhile runs after it', async () => {
  let running = 0
  let most = 0
  let listings = 0
  let slow = false
  const gates: (() => void)[] = []
  const options: Parameters<typeof world>[0] = {
    panes: [
      { terminalId: 't1', agent: 'claude', state: 'working', stateStartedAt: 10 },
      { terminalId: 't2', agent: 'codex', state: 'working', stateStartedAt: 20 }
    ],
    tails: {},
    activeTerminals: ['t1'],
    onActiveTerminals: async () => {
      if (!slow) return
      listings++
      most = Math.max(most, ++running)
      await new Promise<void>((resolve) => gates.push(resolve))
      running--
    }
  }
  const w = world(options)
  const worker = await w.mount()
  const settle = async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve()
  }
  const open = async () => {
    await settle()
    gates.shift()?.()
    await settle()
  }
  await settle()
  slow = true
  // The CLI is slow (live: a process per call): three polls, an event and a tick arrive meanwhile.
  const first = worker.request('rotator.focus', {})
  await settle()
  assert.equal(listings, 1)
  options.activeTerminals = ['t2']
  const later = [worker.request('rotator.focus', {}), worker.request('rotator.focus', {}), worker.emit('workspace.changed', { context: null }), w.rotator.refreshFocus()]
  await settle()
  // Nothing new starts while the first listing runs.
  assert.equal(listings, 1)
  await open()
  await first
  // One more listing serves everyone who asked meanwhile, and it sees the tab as it is now.
  assert.equal(listings, 2)
  await open()
  await open()
  const answers = await Promise.all(later)
  assert.deepEqual(answers[0], { focused: 'codex' })
  assert.deepEqual(answers[1], { focused: 'codex' })
  assert.equal(most, 1)
  // Two listings in all: the first, and the one shared by everyone who asked during it.
  assert.equal(listings, 2)
  assert.equal(w.rotator.focused, 'codex')
  await worker.deactivate()
})

test('manual switch: selects the account, turns the service\u2019s automatic hand-off off, and says so', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [] },
    claudeUsage: { session: 5, weekly: 5 },
    settings: { auto_swap_idle_after_seconds: 0 }
  })
  const worker = await w.mount()
  // c1 is healthy and first in the chain; the user still wants another account.
  const { message } = await worker.request('rotator.switchTo', { seatKey: 'claude:c2' })
  assert.match(message, /new launches use/)
  assert.match(message, /Automatic hand-off for Claude is now off/)
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2'])
  let snap = await worker.request('rotator.snapshot', {})
  assert.equal(snap.services.claude, false)
  assert.equal(snap.history.at(-1)?.reason, 'manual')
  assert.equal(w.host.data().settings.service_claude, false)
  assert.ok(w.host.callsOf('notifications.show').some((c: any) => /automatic hand-off is off/.test(c.body)))
  // Switch-back would return to c1 at once; with the service off nothing moves, tick after tick,
  // and a turn ending on c1 stays put too.
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 2))
  w.advance(48 * 3_600_000)
  await w.rotator.tick()
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2'])
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  // Turning the service on again hands the decision back: c1 is preferred.
  await worker.request('rotator.setService', { provider: 'claude', enabled: true })
  await w.rotator.tick()
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2', 'select claude c1'])
  assert.equal((w.host.data().storage.state as RotatorState).history.at(-1)?.reason, 'switch_back')
  await worker.deactivate()
})

test('manual switch: the pane in the current tab moves at once when it is between turns', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [] },
    claudeUsage: { session: 5, weekly: 5 },
    activeTerminals: ['t1']
  })
  const worker = await w.mount()
  const { message } = await worker.request('rotator.switchTo', { seatKey: 'claude:c2' })
  assert.match(message, /this pane moved \(resumed\)/)
  assert.deepEqual(w.host.callsOf('terminal.close').map((c: any) => c.terminalId), ['t1'])
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  const state = w.host.data().storage.state as RotatorState
  assert.equal(state.paneSeat.t2, 'claude:c2')
  assert.deepEqual(state.history.at(-1), { ...state.history.at(-1), reason: 'manual', result: 'resumed', from: 'claude:c1', to: 'claude:c2' })
  await worker.deactivate()
})

test('manual switch: a working pane is left alone; an already selected or limited account is refused', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'working', sessionId: 's1' }],
    tails: { t1: [] },
    claudeUsage: { session: 5, weekly: 5 },
    activeTerminals: ['t1']
  })
  const worker = await w.mount()
  const { message } = await worker.request('rotator.switchTo', { seatKey: 'claude:c2' })
  assert.match(message, /keeps its account while it works/)
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.match((await worker.request('rotator.switchTo', { seatKey: 'claude:c2' })).message, /already use/)
  w.rotator.state.health['claude:c3'] = { cooldownUntil: w.rotator['deps'].now() + 3_600_000, reason: 'rate_limit' }
  assert.match((await worker.request('rotator.switchTo', { seatKey: 'claude:c3' })).message, /limited until/)
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2'])
  await worker.deactivate()
})

test('manual switch: the chosen account takes the pane in the tab whatever its headroom or the selection cooldown', async () => {
  // c2 has far less room than c1, both by Orca's live numbers, and the selection changed a moment
  // ago: an automatic move would not go there. The user chose it, so the pane moves.
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: ['⏺ Done.'] },
    claudeUsage: { session: 5, weekly: 5 },
    laterClaudeUsage: { session: 60, weekly: 60 },
    inactiveClaude: { c1: { session: 5, weekly: 5 }, c2: { session: 60, weekly: 60 } },
    activeTerminals: ['t1'],
    state: { paneSeat: { t1: 'claude:c1' }, lastAutoSwitchAt: { claude: 1_000_000 - 1000 }, probation: { claude: { key: 'claude:c1', until: 1_000_000 + 10 * MIN } } }
  })
  const worker = await w.mount()
  const { message } = await worker.request('rotator.switchTo', { seatKey: 'claude:c2' })
  assert.match(message, /this pane moved \(resumed\)/)
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.deepEqual(w.host.callsOf('terminal.close'), [{ terminalId: 't1' }])
  assert.deepEqual(w.host.callsOf('agent.resume'), [{ workspaceId: 'w1', agent: 'claude', sessionId: 's1' }])
  const state = stored(w)
  assert.equal(state.paneSeat.t2, 'claude:c2')
  assert.deepEqual(state.history.at(-1), { ...state.history.at(-1), reason: 'manual', result: 'resumed', from: 'claude:c1', to: 'claude:c2' })
  await worker.deactivate()
})

test('manual switch: the pane in the tab moves as the confirmation says, also when running sessions are otherwise left alone', async () => {
  // "Running sessions: new launches only" and (custom) "Resume the session after a switch: off"
  // are about what the plugin does by itself. Here the user asked, and was told the session moves.
  const cases: Record<string, string | number | boolean>[] = [{ running_sessions: 'launches' }, { mode: 'custom', auto_resume: false }, { mode: 'manual' }]
  for (const settings of cases) {
    const label = JSON.stringify(settings)
    const w = world({
      panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
      tails: { t1: ['⏺ Done.'] },
      claudeUsage: { session: 5, weekly: 5 },
      activeTerminals: ['t1'],
      settings,
      state: { paneSeat: { t1: 'claude:c1' } }
    })
    const worker = await w.mount()
    const { message } = await worker.request('rotator.switchTo', { seatKey: 'claude:c2' })
    assert.match(message, /this pane moved \(resumed\)/, label)
    assert.deepEqual(selects(w), ['select claude c2'], label)
    assert.deepEqual(w.host.callsOf('terminal.close'), [{ terminalId: 't1' }], label)
    assert.equal(stored(w).paneSeat.t2, 'claude:c2', label)
    assert.deepEqual(stored(w).history.map((h) => [h.reason, h.result]), [['manual', 'selected'], ['manual', 'resumed']], label)
    await worker.deactivate()
  }
})

/** A Claude pane between turns on c1, in the current tab. */
const idleInTab = (extra: Partial<Parameters<typeof world>[0]> = {}) =>
  world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: ['⏺ Done.', '╭──────────────╮', '│ >', '╰──────────────╯'] },
    claudeUsage: { session: 5, weekly: 5 },
    activeTerminals: ['t1'],
    state: { paneSeat: { t1: 'claude:c1' } },
    ...extra
  })

test('manual switch: unsent text in the pane is asked about; without the answer nothing is switched, and the text comes back', async () => {
  // Unsent text, on screen or as Orca reports it apart from the screen.
  for (const how of ['screen', 'orca'] as const) {
    const w = idleInTab(how === 'screen' ? { tails: { t1: ['⏺ Done.', ...DRAFT_BOX] } } : { drafts: { t1: '  also update the docs ' } })
    const worker = await w.mount()
    const answer = await worker.request('rotator.switchTo', { seatKey: 'claude:c2' })
    assert.deepEqual(answer.draft, { terminalId: 't1', text: 'also update the docs' }, how)
    assert.match(answer.message, /nothing was switched/, how)
    // Nothing changed: no account selected, the service still on, the pane as it was.
    assert.deepEqual(selects(w), [], how)
    assert.notEqual(w.host.data().settings.service_claude, false, how)
    assert.equal((await worker.request('rotator.snapshot', {})).services.claude, true, how)
    assert.equal(w.host.callsOf('terminal.close').length, 0, how)
    assert.equal(w.host.callsOf('agent.resume').length, 0, how)
    assert.deepEqual(w.typed, [], how)
    assert.deepEqual(stored(w)?.history ?? [], [], how)
    // `acceptDraft` alone, or anything but `true`, or the text without it, accepts nothing.
    for (const input of [{ acceptDraft: true }, { acceptDraft: 'yes' as never, draft: answer.draft! }, { draft: answer.draft! }, { acceptDraft: true, draft: 'also update the docs' as never }]) {
      const again = await worker.request('rotator.switchTo', { seatKey: 'claude:c2', ...input })
      assert.deepEqual(again.draft, answer.draft, `${how} ${JSON.stringify(input)}`)
      assert.deepEqual(selects(w), [], how)
      assert.equal(w.host.callsOf('terminal.close').length, 0, how)
    }
    await worker.deactivate()
  }
})

test('manual switch: with the text accepted by the second confirmation the pane moves, and the service\u2019s hand-off goes off as before', async () => {
  const w = idleInTab({ drafts: { t1: 'also update the docs' } })
  const worker = await w.mount()
  const asked = await worker.request('rotator.switchTo', { seatKey: 'claude:c2' })
  const { message, draft } = await worker.request('rotator.switchTo', { seatKey: 'claude:c2', acceptDraft: true, draft: asked.draft! })
  assert.equal(draft, undefined)
  assert.match(message, /new launches use two@example\.test; this pane moved \(resumed\)/)
  assert.match(message, /Automatic hand-off for Claude is now off/)
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.deepEqual(w.host.callsOf('terminal.close'), [{ terminalId: 't1' }])
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  assert.equal(stored(w).paneSeat.t2, 'claude:c2')
  assert.equal(w.host.data().settings.service_claude, false)
  await worker.deactivate()
})

test('manual switch: text that changed since it was shown, or another pane\u2019s, is asked about again, never moved over', async () => {
  const drafts: Record<string, string> = { t1: 'also update the docs' }
  const w = idleInTab({ drafts })
  const worker = await w.mount()
  const first = await worker.request('rotator.switchTo', { seatKey: 'claude:c2' })
  // The user typed on before pressing *Hand off anyway*.
  drafts.t1 = 'also update the docs and the changelog'
  const second = await worker.request('rotator.switchTo', { seatKey: 'claude:c2', acceptDraft: true, draft: first.draft! })
  assert.deepEqual(second.draft, { terminalId: 't1', text: 'also update the docs and the changelog' })
  assert.deepEqual(selects(w), [])
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  // The same words accepted for another pane do not cover this one.
  const other = await worker.request('rotator.switchTo', { seatKey: 'claude:c2', acceptDraft: true, draft: { terminalId: 't9', text: drafts.t1 } })
  assert.deepEqual(other.draft, second.draft)
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  // Asked again and accepted as it is now: the pane moves.
  const third = await worker.request('rotator.switchTo', { seatKey: 'claude:c2', acceptDraft: true, draft: second.draft! })
  assert.match(third.message, /this pane moved \(resumed\)/)
  assert.deepEqual(w.host.callsOf('terminal.close'), [{ terminalId: 't1' }])
  await worker.deactivate()

  // The text changes after the account was selected, just before the pane would be closed: the
  // pane stays, and the message says so.
  let reads = 0
  const late: Record<string, string> = {}
  Object.defineProperty(late, 't1', { enumerable: true, get: () => (reads++ === 0 ? 'also update the docs' : 'also update the docs, and then') })
  const race = idleInTab({ drafts: late })
  const worker2 = await race.mount()
  const { message, draft } = await worker2.request('rotator.switchTo', { seatKey: 'claude:c2', acceptDraft: true, draft: { terminalId: 't1', text: 'also update the docs' } })
  assert.equal(draft, undefined)
  assert.match(message, /new launches use two@example\.test; this pane has unsent text in its input box and keeps its account/)
  assert.deepEqual(selects(race), ['select claude c2'])
  assert.equal(race.host.callsOf('terminal.close').length, 0)
  assert.equal(race.host.callsOf('agent.resume').length, 0)
  assert.deepEqual(race.typed, [])
  await worker2.deactivate()
})

test('manual switch: accepting the text lifts no other guard: never in the middle of a turn, never onto a limited account', async () => {
  const accepted = { acceptDraft: true, draft: { terminalId: 't1', text: 'also update the docs' } }
  for (const busy of ['working', 'blocked'] as const) {
    const w = idleInTab({ panes: [{ terminalId: 't1', agent: 'claude', state: busy, sessionId: 's1' }], drafts: { t1: 'also update the docs' } })
    const worker = await w.mount()
    const { message, draft } = await worker.request('rotator.switchTo', { seatKey: 'claude:c2', ...accepted })
    assert.equal(draft, undefined, busy)
    assert.match(message, /keeps its account while it works/, busy)
    assert.equal(w.host.callsOf('terminal.close').length, 0, busy)
    assert.equal(w.host.callsOf('agent.resume').length, 0, busy)
    assert.ok(w.panes.some((p) => p.terminalId === 't1'), busy)
    await worker.deactivate()
  }
  // A turn that starts while the account is being selected (the pane was idle when asked).
  const started = idleInTab({
    drafts: { t1: 'also update the docs' },
    onListAccounts: async () => {
      if (selects(started).length > 0) started.panes[0]!.state = 'working'
    }
  })
  let worker = await started.mount()
  const late = await worker.request('rotator.switchTo', { seatKey: 'claude:c2', ...accepted })
  assert.match(late.message, /keeps its account while it works/)
  assert.equal(started.host.callsOf('terminal.close').length, 0)
  await worker.deactivate()
  // A limited account is refused whatever was accepted.
  const cooled = idleInTab({ drafts: { t1: 'also update the docs' } })
  worker = await cooled.mount()
  cooled.rotator.state.health['claude:c2'] = { cooldownUntil: cooled.rotator['deps'].now() + 3_600_000, reason: 'rate_limit' }
  const refused = await worker.request('rotator.switchTo', { seatKey: 'claude:c2', ...accepted })
  assert.match(refused.message, /limited until/)
  assert.deepEqual(selects(cooled), [])
  assert.equal(cooled.host.callsOf('terminal.close').length, 0)
  // Another service's account never takes the Claude pane.
  const codex = await worker.request('rotator.switchTo', { seatKey: 'codex:x2', ...accepted })
  assert.equal(codex.draft, undefined)
  assert.equal(cooled.host.callsOf('terminal.close').length, 0)
  await worker.deactivate()
})

test('queued messages ("Press up to edit queued messages") count as unsent input: asked about by hand, never closed automatically', async () => {
  const HINT = 'Press up to edit queued messages'
  // The manual switch asks first, as for typed text.
  for (const extra of [{ drafts: { t1: HINT } }, { drafts: { t1: `  ${HINT}\n` } }]) {
    const w = idleInTab(extra)
    const worker = await w.mount()
    const { draft } = await worker.request('rotator.switchTo', { seatKey: 'claude:c2' })
    assert.equal(draft?.terminalId, 't1', JSON.stringify(extra))
    assert.equal(w.host.callsOf('terminal.close').length, 0, JSON.stringify(extra))
    await worker.deactivate()
  }
  // Automatic moves: a limit never closes a pane with queued messages; it holds as for typed text.
  for (const text of [HINT, 'push it']) {
    const w = world({
      panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
      tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET, '╭──────────────╮', '│ >', '╰──────────────╯'] },
      state: { paneSeat: { t1: 'claude:c1' } },
      drafts: { t1: text }
    })
    const worker = await w.mount()
    await worker.emit('agent.status.changed', statusEvent('t1'))
    assert.equal(w.host.callsOf('terminal.close').length, 0, text)
    assert.ok(stored(w).waiting[0]?.draftAt, text)
    await worker.deactivate()
  }
})

test('manual switch: a pane in the middle of a turn is left alone, also by the command that moves this workspace\u2019s agent', async () => {
  // In the middle of a turn (asking for permission counts): left alone, also by the command that
  // moves this workspace's agent.
  for (const busy of ['working', 'blocked'] as const) {
    const w = world({
      panes: [{ terminalId: 't1', agent: 'claude', state: busy, sessionId: 's1' }],
      tails: { t1: ['⏺ Working on it…'] },
      claudeUsage: { session: 5, weekly: 5 },
      inactiveClaude: { c2: { session: 5, weekly: 5 } },
      activeTerminals: ['t1'],
      state: { paneSeat: { t1: 'claude:c1' } }
    })
    const worker = await w.mount()
    assert.match(String(await worker.command('rotator.swapThisPane')), /in the middle of a turn/, busy)
    assert.deepEqual(selects(w), [], busy)
    assert.equal(w.host.callsOf('terminal.close').length, 0, busy)
    const { message } = await worker.request('rotator.switchTo', { seatKey: 'claude:c2' })
    assert.match(message, /keeps its account while it works/, busy)
    assert.equal(w.host.callsOf('terminal.close').length, 0, busy)
    assert.equal(w.host.callsOf('agent.resume').length, 0, busy)
    assert.ok(w.panes.some((p) => p.terminalId === 't1'), busy)
    await worker.deactivate()
  }
})

test('manual switch: a timer tick that comes while the switch is still being carried out does not undo the choice', async () => {
  // Follow my order, c1 first and healthy: switch-back would return to c1 at once. The user picks
  // c2 by hand. The account is selected, and while the plugin looks for the pane in the current
  // tab (an `orca` call that takes a moment) the timer ticks.
  let ticked = false
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1', stateStartedAt: 1_000_000 }],
    tails: { t1: ['⏺ Done.'] },
    claudeUsage: { session: 5, weekly: 5 },
    inactiveClaude: { c1: { session: 5, weekly: 5 } },
    settings: { chain: 'claude:c1, claude:c2, claude:c3' },
    state: { paneSeat: { t1: 'claude:c1' } },
    onActiveTerminals: async () => {
      if (!ticked && selects(w).length > 0) {
        ticked = true
        await w.rotator.tick()
      }
    }
  })
  const worker = await w.mount()
  const { message } = await worker.request('rotator.switchTo', { seatKey: 'claude:c2' })
  assert.ok(ticked, 'a tick ran during the switch')
  assert.match(message, /new launches use two@example\.test/)
  assert.match(message, /Automatic hand-off for Claude is now off/)
  // The choice stands: nothing selected c1 again.
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.equal(w.host.data().settings.service_claude, false)
  assert.equal(stored(w).history.filter((h) => h.reason === 'switch_back').length, 0)
  w.advance(10 * MIN)
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select claude c2'])
  await worker.deactivate()
})

test('Auto-switch manual: a limit is noted and said as such, not as "no healthy account"', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    inactiveClaude: { c2: { session: 5, weekly: 5 } },
    settings: { mode: 'manual' },
    state: { paneSeat: { t1: 'claude:c1' } }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(w), [])
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(lastNote(w), 'Claude hit a limit on one@example.test. Auto-switch is set to manual, so nothing was switched.')
  const last = stored(w).history.at(-1)
  assert.deepEqual([last?.result, last?.detail, last?.why], ['failed', 'manual strategy', 'Auto-switch is manual, so nothing is switched automatically'])
  await worker.deactivate()

  // "When everything is used up: Stop", with every other account limited: that is the cause.
  const stop = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    settings: { when_all_used: 'stop' },
    state: { paneSeat: { t1: 'claude:c1' }, health: { 'claude:c2': { cooldownUntil: 1_000_000 + 60 * MIN }, 'claude:c3': { cooldownUntil: 1_000_000 + 60 * MIN } } }
  })
  const sw = await stop.mount()
  await sw.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(lastNote(stop), 'Claude: no other account has room, and waiting for a reset is off. The session stays where it is.')
  assert.equal(stored(stop).history.at(-1)?.why, 'no other Claude account has room, and waiting for a reset is off')
  await sw.deactivate()
})

test('a limit: a turn the user starts while the accounts are read (live: seconds) is not closed', async () => {
  let armed = false
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    // The move has seen the pane between turns and now reads the accounts: the user sends a prompt.
    onListAccounts: async () => {
      if (armed) w.panes[0]!.state = 'working'
    }
  })
  const worker = await w.mount()
  armed = true
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.panes[0]?.terminalId, 't1')
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(w.cliCalls.filter((c) => c.startsWith('close')).length, 0)
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  assert.deepEqual(w.typed, [])
  // The limit itself was real: the account is still set aside.
  assert.ok((w.host.data().storage.state as RotatorState).health['claude:c1']?.cooldownUntil! > 1_000_000)
  // The end of that turn is a new event, and moves the session then.
  armed = false
  w.panes[0]!.state = 'done'
  w.tails.t1 = [...fx.CLAUDE_SESSION_LIMIT, '❯ go on', ...fx.CLAUDE_SESSION_LIMIT]
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 2))
  assert.deepEqual(w.host.callsOf('terminal.close'), [{ terminalId: 't1' }])
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  await worker.deactivate()
})

test('manual move command: with several agents in the workspace it moves the one in the current terminal tab, never another', async () => {
  const options: Parameters<typeof world>[0] = {
    panes: [
      { terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' },
      { terminalId: 'tB', agent: 'claude', state: 'done', sessionId: 'sB' }
    ],
    tails: { t1: ['⏺ Done.'], tB: ['⏺ Done.'] },
    claudeUsage: { session: 5, weekly: 5 },
    inactiveClaude: { c2: { session: 5, weekly: 5 } },
    state: { paneSeat: { t1: 'claude:c1', tB: 'claude:c1' } },
    activeTerminals: ['tB']
  }
  const w = world(options)
  const worker = await w.mount()
  // The tab in front is tB: t1, listed first, is left alone.
  assert.match(String(await worker.command('rotator.swapThisPane')), /moved to/)
  assert.deepEqual(w.host.callsOf('terminal.close'), [{ terminalId: 'tB' }])
  assert.deepEqual(w.host.callsOf('agent.resume'), [{ workspaceId: 'w1', agent: 'claude', sessionId: 'sB' }])
  // The tab in front is in the middle of a turn: nothing moves, the idle pane behind it included.
  options.activeTerminals = ['t1']
  w.panes.find((p) => p.terminalId === 't1')!.state = 'working'
  assert.match(String(await worker.command('rotator.swapThisPane')), /in the middle of a turn/)
  assert.equal(w.host.callsOf('terminal.close').length, 1)
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  await worker.deactivate()
})

test('manual move command: a turn that started while the move waited its turn is not closed', async () => {
  // The user sends a prompt right after running the command: by the time the move has its turn
  // (the lock, a fresh account read) Orca reports the pane as working.
  const drafts: Record<string, string> = {}
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: ['⏺ Done.'] },
    claudeUsage: { session: 5, weekly: 5 },
    inactiveClaude: { c2: { session: 5, weekly: 5 } },
    state: { paneSeat: { t1: 'claude:c1' } },
    drafts
  })
  // The command's own look at the input box comes after it has seen the pane between turns.
  Object.defineProperty(drafts, 't1', {
    get: () => {
      w.panes[0]!.state = 'working'
      return undefined
    }
  })
  const worker = await w.mount()
  assert.match(await w.rotator.swapFocused(), /nothing to do/)
  assert.equal(w.panes[0]!.state, 'working')
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  assert.deepEqual(selects(w), [])
  await worker.deactivate()
})

test('selection only: the notification names what keeps the session where it is', async () => {
  // Running sessions: new launches only. Nothing called "auto resume" was turned off.
  const launches = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    settings: { running_sessions: 'launches' }
  })
  let worker = await launches.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(launches), ['select claude c2'])
  assert.equal(launches.host.callsOf('terminal.close').length, 0)
  // The one notification, whole: it names that setting and no other.
  assert.deepEqual(notes(launches), ['Claude: new launches now use two@example.test. The session stays where it is for you to resume, because Running sessions is set to new launches only.'])
  assert.equal(stored(launches).history.at(-1)?.detail, 'Running sessions: new launches only')
  await worker.deactivate()

  // Custom mode with "Resume the session after a switch" off.
  const custom = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    settings: { auto_resume: false }
  })
  worker = await custom.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(custom), ['select claude c2'])
  assert.deepEqual(notes(custom), ['Claude: new launches now use two@example.test. The session stays where it is for you to resume, because Resume the session after a switch is off.'])
  assert.equal(stored(custom).history.at(-1)?.detail, 'auto_resume off')
  await worker.deactivate()
})

test('project on a remote Orca server: reads accounts and switches seats on the current project server', async () => {
  let focusedWorkspace = 'w-remote'
  let localActive = 'c1'
  let remoteActive = 'r1'
  const cliCalls: string[] = []
  const panes: Pane[] = [{ terminalId: 'tr1', agent: 'claude', state: 'done', sessionId: 'sr1' }]
  const tails: Record<string, string[]> = { tr1: fx.CLAUDE_SESSION_LIMIT }
  let next = 2
  const cli: Cli = {
    async listAccounts(server) {
      cliCalls.push(server ? `list@${server}` : 'list')
      if (server === 'remote-box') {
        return {
          claude: {
            accounts: [
              { id: 'r1', email: 'remote1@example.test' },
              { id: 'r2', email: 'remote2@example.test' }
            ],
            activeAccountId: remoteActive,
            systemDefaultHome: null
          },
          codex: { accounts: [], activeAccountId: null, systemDefault: { hasAuth: false } },
          rateLimits: {
            claude: {
              status: 'ok',
              session: { usedPercent: remoteActive === 'r1' ? 100 : 12, resetsAt: 1_000_000 + 3_600_000 },
              weekly: { usedPercent: 20, resetsAt: 1_000_000 + 86_400_000 }
            }
          }
        }
      }
      return fx.accountList({ claudeActive: localActive, claudeUsage: { session: 15, weekly: 20 } })
    },
    async select(provider, accountId, server) {
      cliCalls.push(server ? `select@${server} ${provider} ${accountId}` : `select ${provider} ${accountId}`)
      if (provider === 'claude') {
        if (server === 'remote-box') remoteActive = accountId
        else localActive = accountId
      }
    },
    async closeTerminal(id, server) {
      cliCalls.push(server ? `close@${server} ${id}` : `close ${id}`)
    },
    async sendText(id, _text, server) {
      cliCalls.push(server ? `send@${server} ${id}` : `send ${id}`)
    },
    async git() {
      return ''
    }
  }
  const host = mockHost({
    settings: {},
    storage: {},
    results: {
      'agents.list': () => ({ agents: panes.map((p) => ({ title: null, task: null, stateStartedAt: 1, sessionId: null, ...p })) }),
      'terminal.read': ({ terminalId }: { terminalId: string }) => ({ lines: tails[terminalId] ?? [], truncated: false }),
      'terminal.close': ({ terminalId }: { terminalId: string }) => {
        const i = panes.findIndex((p) => p.terminalId === terminalId)
        if (i >= 0) panes.splice(i, 1)
        return { closed: true }
      },
      'agent.resume': ({ agent, sessionId }: { agent: string; sessionId: string }) => {
        const terminalId = `tr${next++}`
        panes.push({ terminalId, agent, state: 'waiting', sessionId })
        return { terminalId, started: true }
      },
      'terminal.sendText': () => {
        throw Object.assign(new Error('terminal is outside the active worktree'), { code: 'action_failed' })
      },
      'workspace.list': {
        workspaces: [
          { id: 'w-local', kind: 'worktree', name: 'local-app', projectId: 'p-local', path: '/local/repo', branch: 'main', hostId: 'local' },
          { id: 'w-remote', kind: 'worktree', name: 'remote-app', projectId: 'p-remote', path: '/srv/repo', branch: 'main', hostId: null }
        ],
        truncated: false
      },
      'project.list': {
        projects: [
          { id: 'p-local', name: 'local-app', kind: 'git', hostId: 'local', path: '/local/repo' },
          { id: 'p-remote', name: 'remote-app', kind: 'git', hostId: 'runtime:remote-box', path: '/srv/repo' }
        ],
        truncated: false
      },
      'workspace.readContext': () => ({ workspaceId: focusedWorkspace, branch: 'main', displayName: focusedWorkspace, terminals: [] }),
      'notifications.show': { delivered: true },
      'statusBar.update': { ok: true }
    }
  })
  let rotator!: Rotator
  const worker = await mountWorker(
    {
      default: async (orca: OrcaWorkerApi) => {
        rotator = await activateWith(orca, { cli, now: () => 1_000_000, sleep: async () => undefined }, { tick: false })
      }
    },
    { host }
  )
  const snapRemote = await worker.request('rotator.snapshot', { refresh: true })
  assert.equal(snapRemote.server, 'remote-box')
  assert.deepEqual(snapRemote.seats.map((s) => s.label), ['remote1@example.test', 'remote2@example.test'])
  assert.ok(cliCalls.includes('list@remote-box'), cliCalls.join(','))

  // A limit in the remote workspace selects the next account on that remote server.
  await worker.emit('agent.status.changed', {
    workspaceId: 'w-remote',
    paneKey: 'pane-tr1',
    terminalId: 'tr1',
    state: 'done',
    receivedAt: 1,
    mainAgent: { state: 'done', stateStartedAt: 1 }
  })
  assert.ok(cliCalls.includes('select@remote-box claude r2'), cliCalls.join(','))
  assert.ok(cliCalls.includes('send@remote-box tr2'), cliCalls.join(','))

  // Switching focus to the local project switches the panel's accounts to the local server.
  focusedWorkspace = 'w-local'
  await worker.emit('workspace.changed', { context: { workspaceId: 'w-local', branch: 'main', displayName: 'local-app', terminals: [] } })
  const snapLocal = await worker.request('rotator.snapshot', {})
  assert.equal(snapLocal.server, undefined)
  assert.ok(snapLocal.seats.some((s) => s.label === 'one@example.test'))
  assert.ok(cliCalls.includes('list'), cliCalls.join(','))
  await worker.deactivate()
})

test('project on a direct SSH target: Orca manages no accounts there, so a limited pane is left alone and the panel says so', async () => {
  const cliCalls: string[] = []
  const panes: Pane[] = [{ terminalId: 'ts1', agent: 'claude', state: 'done', sessionId: 'ss1' }]
  const cli: Cli = {
    async listAccounts(server) {
      cliCalls.push(server ? `list@${server}` : 'list')
      return fx.accountList({ claudeUsage: { session: 100, weekly: 40 } })
    },
    async select(provider, accountId) {
      cliCalls.push(`select ${provider} ${accountId}`)
    },
    async closeTerminal(id) {
      cliCalls.push(`close ${id}`)
    },
    async sendText(id) {
      cliCalls.push(`send ${id}`)
    },
    async git() {
      return ''
    }
  }
  const host = mockHost({
    settings: {},
    storage: {},
    results: {
      'agents.list': () => ({ agents: panes.map((p) => ({ title: null, task: null, stateStartedAt: 1, sessionId: null, ...p })) }),
      'terminal.read': () => ({ lines: fx.CLAUDE_SESSION_LIMIT, truncated: false }),
      'terminal.close': () => ({ closed: true }),
      'agent.resume': () => ({ terminalId: 'never', started: true }),
      'terminal.sendText': () => ({ accepted: true }),
      // The workspace row names no host; its project does.
      'workspace.list': { workspaces: [{ id: 'w-ssh', kind: 'worktree', name: 'build-app', projectId: 'p-ssh', path: '/home/me/repo', branch: 'main', hostId: null }], truncated: false },
      'project.list': { projects: [{ id: 'p-ssh', name: 'build-app', kind: 'git', hostId: 'ssh:build-box', path: '/home/me/repo' }], truncated: false },
      'workspace.readContext': { workspaceId: 'w-ssh', branch: 'main', displayName: 'build-app', terminals: [] },
      'notifications.show': { delivered: true },
      'statusBar.update': { ok: true }
    }
  })
  let rotator!: Rotator
  const worker = await mountWorker(
    {
      default: async (orca: OrcaWorkerApi) => {
        rotator = await activateWith(orca, { cli, now: () => 1_000_000, sleep: async () => undefined }, { tick: false })
      }
    },
    { host }
  )
  const snap = await worker.request('rotator.snapshot', { refresh: true })
  assert.equal(snap.sshHost, 'build-box')
  assert.equal(snap.server, undefined)
  const event = (stamp: number) => ({ workspaceId: 'w-ssh', paneKey: 'pane-ts1', terminalId: 'ts1', state: 'done' as const, receivedAt: stamp, mainAgent: { state: 'done' as const, stateStartedAt: stamp } })
  await worker.emit('agent.status.changed', event(1))
  // Nothing is selected, closed or resumed: the accounts here are not the SSH machine's.
  assert.deepEqual(cliCalls.filter((c) => !c.startsWith('list')), [])
  assert.equal(host.callsOf('agent.resume').length, 0)
  assert.equal(host.callsOf('terminal.close').length, 0)
  let state = host.data().storage.state as RotatorState
  assert.equal(state.history.length, 1)
  assert.equal(state.history[0]?.result, 'failed')
  assert.match(state.history[0]?.detail ?? '', /SSH target build-box/)
  assert.equal(state.health['claude:c1'], undefined)
  assert.equal(host.callsOf('notifications.show').length, 1)
  // The same banner again is not reported twice.
  await worker.emit('agent.status.changed', event(2))
  state = host.data().storage.state as RotatorState
  assert.equal(state.history.length, 1)
  assert.match(await rotator.swapFocused(), /SSH target build-box/)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('history: every move and wait says why in one line', async () => {
  // A limit: the session moves, and the entry names both accounts as the panel does.
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    inactiveClaude: { c2: { session: 5, weekly: 6 } }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  let state = w.host.data().storage.state as RotatorState
  assert.equal(state.history.at(-1)?.result, 'resumed')
  assert.equal(state.history.at(-1)?.why, 'one hit a usage limit; moved to two (used 5 % of 5h, 6 % of the week)')
  // The snapshot the panel reads carries it.
  assert.equal(w.rotator.snapshot().history.at(-1)?.why, state.history.at(-1)?.why)
  await worker.deactivate()

  // A threshold: the level that caused it is in the line.
  const t = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'waiting', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_TALKING_ABOUT_LIMITS },
    claudeUsage: { session: 60, weekly: 10 },
    inactiveClaude: { c2: { session: 5, weekly: 5 } },
    settings: { thresholds_five_hour: 50 }
  })
  const tw = await t.mount()
  await tw.emit('agent.status.changed', statusEvent('t1', 'waiting'))
  state = t.host.data().storage.state as RotatorState
  assert.equal(state.history.at(-1)?.reason, 'threshold')
  assert.equal(state.history.at(-1)?.why, 'one is over its usage threshold (used 60 % of 5h, 10 % of the week); moved to two (used 5 % of 5h, 5 % of the week)')
  await tw.deactivate()

  // Nowhere to go: the wait explains itself; so does the wake.
  const p = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    state: { health: { 'claude:c2': { cooldownUntil: 1_000_000 + 10 * 60_000 }, 'claude:c3': { cooldownUntil: 1_000_000 + 20 * 60_000 } } }
  })
  const pw = await p.mount()
  await pw.emit('agent.status.changed', statusEvent('t1'))
  state = p.host.data().storage.state as RotatorState
  assert.equal(state.history.at(-1)?.result, 'waiting')
  assert.equal(state.history.at(-1)?.why, 'every Claude account is used up or cooling down; waiting for the earliest reset')
  p.advance(11 * 60_000)
  await p.rotator.tick()
  state = p.host.data().storage.state as RotatorState
  assert.equal(state.history.at(-1)?.reason, 'reset')
  assert.match(state.history.at(-1)?.why ?? '', /^a limit has reset; resumed on two/)
  await pw.deactivate()

  // A choice made by hand, and auto resume off (only the selection moves).
  const m = world({ panes: [], tails: {}, claudeUsage: { session: 10, weekly: 10 } })
  const mw = await m.mount()
  await m.rotator.selectSeat('claude:c2')
  state = m.host.data().storage.state as RotatorState
  assert.equal(state.history.at(-1)?.why, 'chosen by hand; new launches use two')
  await mw.deactivate()

  const s = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    settings: { auto_resume: false }
  })
  const sw = await s.mount()
  await sw.emit('agent.status.changed', statusEvent('t1'))
  state = s.host.data().storage.state as RotatorState
  assert.equal(state.history.at(-1)?.result, 'selected')
  assert.equal(state.history.at(-1)?.why, 'one hit a usage limit; new launches use two')
  await sw.deactivate()
})

test('history: switching back for new launches says which account is available again', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    settings: { auto_swap_idle_after_seconds: 0 }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  w.advance(48 * 3_600_000)
  await w.rotator.tick()
  const state = w.host.data().storage.state as RotatorState
  assert.equal(state.history.at(-1)?.reason, 'switch_back')
  assert.match(state.history.at(-1)?.why ?? '', /^one is available again.*; new launches use it$/)
  await worker.deactivate()
})

// ---- modes: Smart, Follow my order, Manual, custom ----------------------------------------------

const configFor = (settings: Record<string, string | number | boolean>): Promise<Config> =>
  readConfig({ settings: { get: async () => settings } } as unknown as Pick<OrcaWorkerApi, 'settings'>)

/** Every legacy decision setting spelled out at its default, as a host that fills in manifest
 *  defaults would report them. */
const LEGACY_AT_DEFAULTS = {
  strategy: 'drain',
  switch_back: true,
  switch_cooldown_minutes: 5,
  min_headroom_gap: 10,
  auto_swap_idle_after_seconds: 900,
  auto_switch_on_rate_limit: true,
  auto_switch_on_threshold: true,
  thresholds_five_hour: 100,
  thresholds_seven_day: 100,
  auto_resume: true,
  wait_for_reset: true,
  chain: ''
}

test('modes: `auto` resolves from the earlier settings (the migration table)', async () => {
  // Nothing changed: Smart, whether the host reports no settings or every default.
  assert.deepEqual(await configFor({}), SMART_CONFIG)
  assert.deepEqual(await configFor({ mode: 'auto', ...LEGACY_AT_DEFAULTS }), SMART_CONFIG)
  assert.deepEqual(resolveMode({}), { mode: 'smart', auto: true, switchEarly: 'just-before', keepThresholds: false })

  // An account order with drain or priority: Follow my order, with switch-back.
  const ordered = await configFor({ chain: 'claude:c2, claude:c1' })
  assert.deepEqual([ordered.mode, ordered.strategy, ordered.switchBack, ordered.chain], ['my-order', 'drain', true, 'claude:c2, claude:c1'])
  const priority = await configFor({ chain: 'claude:c2', strategy: 'priority' })
  assert.deepEqual([priority.mode, priority.strategy, priority.switchBack], ['my-order', 'priority', true])
  // It looks ahead like Smart does.
  assert.deepEqual([ordered.horizonMinutes, ordered.lowFiveHour, ordered.lowSevenDay], [10, 97, 99])

  // strategy manual: Manual, whatever else is set.
  const manual = await configFor({ strategy: 'manual', switch_back: false, chain: 'claude:c2' })
  assert.deepEqual([manual.mode, manual.strategy], ['manual', 'manual'])

  // Anything else: custom, the stored settings exactly, and a note for the panel.
  const changed: [Record<string, string | number | boolean>, Partial<Config>][] = [
    [{ strategy: 'balanced' }, { strategy: 'balanced' }],
    [{ strategy: 'soonest-reset' }, { strategy: 'soonest-reset' }],
    [{ strategy: 'priority' }, { strategy: 'priority' }],
    [{ switch_back: false }, { switchBack: false }],
    [{ switch_cooldown_minutes: 0 }, { switchCooldownMinutes: 0 }],
    [{ min_headroom_gap: 25 }, { minHeadroomGap: 25 }],
    [{ auto_swap_idle_after_seconds: 0 }, { autoSwapIdleAfterSeconds: 0 }],
    [{ auto_switch_on_rate_limit: false }, { autoSwitchOnRateLimit: false }],
    [{ auto_switch_on_threshold: false }, { autoSwitchOnThreshold: false }],
    [{ auto_resume: false }, { autoResume: false }],
    [{ wait_for_reset: false }, { waitForReset: false }],
    [{ chain: 'claude:c2', strategy: 'balanced', thresholds_five_hour: 80 }, { chain: 'claude:c2', strategy: 'balanced', thresholdFiveHour: 80 }]
  ]
  for (const [settings, expected] of changed) {
    const { notice, ...config } = await configFor(settings)
    assert.deepEqual(config, { ...DEFAULT_CONFIG, ...expected }, JSON.stringify(settings))
    assert.match(notice ?? '', /kept exactly as they were/, JSON.stringify(settings))
  }

  // Thresholds below 100 are no reason for custom: "Earlier", with the threshold kept as a hard cap.
  const capped = await configFor({ thresholds_five_hour: 80 })
  assert.deepEqual(capped, { ...SMART_CONFIG, thresholdFiveHour: 80, horizonMinutes: 25, lowFiveHour: 90, lowSevenDay: 97 })
  const cappedOrder = await configFor({ thresholds_seven_day: 90, chain: 'claude:c2' })
  assert.deepEqual([cappedOrder.mode, cappedOrder.thresholdSevenDay, cappedOrder.thresholdFiveHour, cappedOrder.horizonMinutes], ['my-order', 90, 100, 25])
  // A Switch early chosen by hand stands; the cap stays.
  const cappedAtLimit = await configFor({ thresholds_five_hour: 80, switch_early: 'at-limit' })
  assert.deepEqual([cappedAtLimit.thresholdFiveHour, cappedAtLimit.horizonMinutes, cappedAtLimit.lowFiveHour], [80, 0, 100])
})

test('modes: a mode chosen by hand; legacy settings apply in custom only', async () => {
  const legacy = { strategy: 'balanced', switch_back: false, thresholds_five_hour: 60, min_headroom_gap: 30, switch_cooldown_minutes: 1, auto_resume: false, wait_for_reset: false }
  // Smart ignores them all.
  assert.deepEqual(await configFor({ mode: 'smart', ...legacy }), SMART_CONFIG)
  // Custom reads them exactly, without the note (it was chosen, not carried over).
  assert.deepEqual(await configFor({ mode: 'custom', ...legacy }), {
    ...DEFAULT_CONFIG,
    strategy: 'balanced',
    switchBack: false,
    thresholdFiveHour: 60,
    minHeadroomGap: 30,
    switchCooldownMinutes: 1,
    autoResume: false,
    waitForReset: false
  })
  assert.deepEqual(await configFor({ mode: 'custom' }), DEFAULT_CONFIG)
  // Follow my order and Manual by hand.
  const order = await configFor({ mode: 'my-order', ...legacy })
  assert.deepEqual([order.strategy, order.switchBack, order.thresholdFiveHour, order.autoResume, order.waitForReset], ['drain', true, 100, true, true])
  assert.equal((await configFor({ mode: 'manual' })).strategy, 'manual')
  // An unknown value is `auto`.
  assert.equal((await configFor({ mode: 'whatever' })).mode, 'smart')
  // Settings that are not decisions apply in every mode.
  const kept = await configFor({ mode: 'smart', exclude: 'claude:c3', chain: 'claude:c2', model_fallback: 'claude=sonnet', auto_message: 'go on', poll_interval_seconds: 30, service_codex: false })
  assert.deepEqual(
    [kept.exclude, kept.chain, kept.modelFallback, kept.autoMessage, kept.pollIntervalSeconds, kept.services.codex],
    ['claude:c3', 'claude:c2', 'claude=sonnet', 'go on', 30, false]
  )
})

test('modes: the three knobs beside Auto-switch', async () => {
  const early = async (switch_early: string) => {
    const c = await configFor({ switch_early })
    return [c.horizonMinutes, c.lowFiveHour, c.lowSevenDay]
  }
  assert.deepEqual(await early('just-before'), [10, 97, 99])
  assert.deepEqual(await early('earlier'), [25, 90, 97])
  assert.deepEqual(await early('at-limit'), [0, 100, 100])
  const running = async (running_sessions: string) => {
    const c = await configFor({ running_sessions })
    return [c.runningSessions, c.autoSwitchOnThreshold, c.autoSwapIdleAfterSeconds, c.autoResume, c.autoSwitchOnRateLimit]
  }
  assert.deepEqual(await running('move'), ['move', true, 900, true, true])
  assert.deepEqual(await running('limit'), ['limit', false, 0, true, true])
  assert.deepEqual(await running('launches'), ['launches', false, 0, false, true])
  assert.equal((await configFor({ when_all_used: 'wait' })).waitForReset, true)
  assert.equal((await configFor({ when_all_used: 'stop' })).waitForReset, false)
  // In custom the knobs are not read.
  assert.deepEqual(await configFor({ mode: 'custom', switch_early: 'earlier', running_sessions: 'launches', when_all_used: 'stop' }), DEFAULT_CONFIG)
})

test('modes: the panel is told the mode, and once that earlier settings were kept as custom', async () => {
  const smart = world({ panes: [], tails: {} })
  let worker = await smart.mount()
  await smart.rotator.tick()
  assert.equal(smart.rotator.snapshot().mode, 'smart')
  assert.equal(smart.rotator.snapshot().notice, undefined)
  await worker.deactivate()

  const custom = world({ panes: [], tails: {}, settings: { strategy: 'balanced' } })
  worker = await custom.mount()
  await custom.rotator.tick()
  assert.equal(custom.rotator.snapshot().mode, 'custom')
  assert.match(custom.rotator.snapshot().notice ?? '', /kept exactly as they were/)
  await worker.request('rotator.dismissNotice', {})
  assert.equal(custom.rotator.snapshot().notice, undefined)
  assert.equal(stored(custom).customNoticeSeen, true)
  await worker.deactivate()
})

test('model cap, Smart: an account known to have room for that model comes before the fallback model', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_MODEL_CAP },
    // c2 has room in its Fable bucket; c3 is known but its bucket is not.
    inactiveClaude: { c2: { session: 5, weekly: 5, fable: 20 }, c3: { session: 1, weekly: 1 } },
    settings: { model_fallback: 'claude=fable,sonnet' }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.deepEqual(w.typed.map((t) => t.text), ['Go continue.'])
  assert.equal(stored(w).history.at(-1)?.reason, 'model_cap')
  assert.equal(stored(w).history.at(-1)?.result, 'resumed')
  await worker.deactivate()

  // A bucket that is nearly full is not room: the fallback model on the same account is next.
  const full = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_MODEL_CAP },
    inactiveClaude: { c2: { session: 5, weekly: 5, fable: 95 } },
    settings: { model_fallback: 'claude=fable,sonnet' }
  })
  const fw = await full.mount()
  await fw.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(full), [])
  assert.deepEqual(full.typed.map((t) => t.text), ['/model sonnet', 'Go continue.'])
  await fw.deactivate()
})

test('model cap, Smart: with no known room and no fallback model the next account not known to be full is tried', async () => {
  // c2 is known and has room in general; nothing says its Fable bucket is full. Waiting for c1's
  // bucket could take days, so the session moves there.
  const unknown = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_MODEL_CAP },
    inactiveClaude: { c2: { session: 5, weekly: 5 } }
  })
  const uw = await unknown.mount()
  await uw.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(unknown), ['select claude c2'])
  assert.equal(stored(unknown).waiting.length, 0)
  assert.equal(stored(unknown).history.at(-1)?.reason, 'model_cap')
  assert.equal(stored(unknown).history.at(-1)?.result, 'resumed')
  await uw.deactivate()

  // An account whose bucket for that model is known to be full is never tried: the session waits.
  const inactiveClaude: Record<string, { session: number; weekly: number; fable?: number }> = { c2: { session: 5, weekly: 5, fable: 95 }, c3: { session: 5, weekly: 5, fable: 96 } }
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_MODEL_CAP },
    inactiveClaude
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(w), [])
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  let state = stored(w)
  assert.equal(state.waiting.length, 1)
  assert.equal(state.waiting[0]?.model, 'fable')
  assert.equal(state.history.at(-1)?.result, 'waiting')
  assert.equal(state.history.at(-1)?.why, 'no other Claude account has room for fable; waiting for its limit to reset')
  // Other accounts having room in general does not end the wait.
  w.advance(2 * MIN)
  await w.rotator.tick()
  assert.deepEqual(selects(w), [])
  assert.equal(stored(w).waiting.length, 1)
  // Orca now reports c2's Fable bucket with room: the session resumes there.
  inactiveClaude.c2 = { session: 5, weekly: 5, fable: 30 }
  w.advance(2 * MIN)
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select claude c2'])
  state = stored(w)
  assert.equal(state.waiting.length, 0)
  assert.equal(state.history.at(-1)?.reason, 'reset')
  assert.equal(state.history.at(-1)?.result, 'resumed')
  await worker.deactivate()

  // Parked only because the other accounts were cooling down: once one is free again the session
  // goes there, and does not sit out the capped bucket's reset.
  const cooling = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_MODEL_CAP },
    state: { health: { 'claude:c2': { cooldownUntil: 1_000_000 + 10 * MIN }, 'claude:c3': { cooldownUntil: 1_000_000 + 30 * MIN } } }
  })
  const cw = await cooling.mount()
  await cw.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(cooling), [])
  assert.equal(stored(cooling).waiting[0]?.model, 'fable')
  cooling.advance(11 * MIN)
  await cooling.rotator.tick()
  assert.deepEqual(selects(cooling), ['select claude c2'])
  assert.equal(stored(cooling).waiting.length, 0)
  await cw.deactivate()

  // "When everything is used up: Stop" also stops this wait.
  const stop = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_MODEL_CAP },
    inactiveClaude: { c2: { session: 5, weekly: 5, fable: 95 }, c3: { session: 5, weekly: 5, fable: 96 } },
    settings: { when_all_used: 'stop' }
  })
  const sw = await stop.mount()
  await sw.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(stored(stop).waiting.length, 0)
  assert.equal(stored(stop).history.at(-1)?.result, 'failed')
  await sw.deactivate()
})

test('model cap, custom: the legacy order is unchanged (fallback model first, then any next account)', async () => {
  const withFallback = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_MODEL_CAP },
    inactiveClaude: { c2: { session: 5, weekly: 5, fable: 20 } },
    settings: { mode: 'custom', model_fallback: 'claude=fable,sonnet' }
  })
  let worker = await withFallback.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(withFallback), [])
  assert.deepEqual(withFallback.typed.map((t) => t.text), ['/model sonnet', 'Go continue.'])
  await worker.deactivate()

  const without = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_MODEL_CAP },
    settings: { mode: 'custom' }
  })
  worker = await without.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  // No numbers for c2 at all: the legacy order still moves there.
  assert.deepEqual(selects(without), ['select claude c2'])
  assert.equal(stored(without).waiting.length, 0)
  await worker.deactivate()
})

// ---- Smart at work: leaving early, selection-only changes, short waits -------------------------

const lastNote = (w: { host: { callsOf(method: string): any[] } }): string => w.host.callsOf('notifications.show').at(-1)?.body ?? ''

/** A Claude pane on c1 between turns, with ordinary output; c2 is known to have room. */
const calm = (claudeUsage: { session: number; weekly: number; sessionReset?: number; weeklyReset?: number }, extra: Partial<Parameters<typeof world>[0]> = {}) =>
  world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [...fx.CLAUDE_TALKING_ABOUT_LIMITS] },
    claudeUsage,
    inactiveClaude: { c2: { session: 5, weekly: 5 } },
    state: { paneSeat: { t1: 'claude:c1' } },
    ...extra
  })

test('smart: a turn that ends on a Low account moves that session, and says why', async () => {
  // No pace is known, so the level decides: 97 % of the 5-hour window.
  const w = calm({ session: 97, weekly: 40 })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.deepEqual(w.host.callsOf('terminal.close').map((c: any) => c.terminalId), ['t1'])
  assert.deepEqual(w.typed.at(-1), { terminalId: 't2', text: 'Go continue.' })
  const state = stored(w)
  assert.equal(state.paneSeat.t2, 'claude:c2')
  assert.equal(state.history.at(-1)?.reason, 'threshold')
  assert.equal(state.history.at(-1)?.why, 'one is nearly at the end of its 5h window (5h 97 %, week 40 %, weekly resets in 24 h); moved to two (5h 5 %, week 5 %, weekly resets in 24 h)')
  // Not at a limit: the account is not cooled, only set aside until its window ends.
  assert.equal(state.health['claude:c1'], undefined)
  assert.equal(state.leftLow?.['claude:c1']?.until, 1_000_000 + 3_600_000)
  // The notification gives the reason and says Orca's restart prompt needs no action.
  assert.match(lastNote(w), /^Claude: one is nearly at the end of its 5h window/)
  assert.match(lastNote(w), /Orca may now offer to restart your running sessions: you do not need to\./)
  await worker.deactivate()

  // 96 %: not Low, nothing happens.
  const ok = calm({ session: 96, weekly: 40 })
  const okWorker = await ok.mount()
  await okWorker.emit('agent.status.changed', statusEvent('t1'))
  await ok.rotator.tick()
  assert.deepEqual(selects(ok), [])
  await okWorker.deactivate()
})

test('smart: the pace decides before the level does (fake clock)', async () => {
  const usage = { session: 80, weekly: 40 }
  const w = calm(usage)
  const worker = await w.mount()
  // 1 point a minute: 84, 88 (12 minutes left: not yet), 92 (8 minutes left: Low).
  for (const level of [84, 88]) {
    w.advance(4 * MIN)
    usage.session = level
    w.touch('t1')
    await w.rotator.tick()
    await worker.emit('agent.status.changed', statusEvent('t1', 'done', level))
    assert.deepEqual(selects(w), [], `at ${level} %`)
  }
  w.advance(4 * MIN)
  usage.session = 92
  w.touch('t1')
  await w.rotator.tick()
  assert.equal(w.rotator.snapshot().seats.find((s) => s.key === 'claude:c1')?.runwayMs, 8 * MIN)
  // The tick alone moves nothing: the session is not idle long enough, and no turn has ended.
  assert.deepEqual(selects(w), [])
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 92))
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.equal(stored(w).history.at(-1)?.why, 'one had about 8 min left at this pace (5h 92 %, week 40 %, weekly resets in 24 h); moved to two (5h 5 %, week 5 %, weekly resets in 24 h)')
  await worker.deactivate()

  // "Only at the limit": the same readings never move it.
  const late = { session: 80, weekly: 40 }
  const l = calm(late, { settings: { switch_early: 'at-limit' } })
  const lw = await l.mount()
  for (const level of [84, 88, 92, 99]) {
    l.advance(4 * MIN)
    late.session = level
    await l.rotator.tick()
    await lw.emit('agent.status.changed', statusEvent('t1', 'done', level))
  }
  assert.deepEqual(selects(l), [])
  await lw.deactivate()
})

test('smart: never in the middle of a turn; only the account for new launches changes, once per cooldown', async () => {
  const inactiveClaude: Record<string, { session: number; weekly: number }> = { c2: { session: 5, weekly: 5 }, c3: { session: 6, weekly: 6 } }
  const later = { session: 5, weekly: 5 }
  const w = world({
    panes: [
      { terminalId: 't1', agent: 'claude', state: 'working', sessionId: 's1' },
      { terminalId: 't5', agent: 'claude', state: 'working', sessionId: 's5' }
    ],
    tails: { t1: ['⏺ Working on it…'], t5: ['⏺ Working on it…'] },
    claudeUsage: { session: 97, weekly: 40 },
    laterClaudeUsage: later,
    inactiveClaude,
    state: { paneSeat: { t1: 'claude:c1', t5: 'claude:c2' } }
  })
  const worker = await w.mount()
  // A status event of a working session is never acted on.
  await worker.emit('agent.status.changed', { ...statusEvent('t1'), state: 'working', mainAgent: { state: 'working', stateStartedAt: 1 } } as never)
  assert.deepEqual(selects(w), [])
  // The tick changes the selection only: nothing is closed, resumed or typed.
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  assert.deepEqual(w.typed, [])
  let state = stored(w)
  assert.deepEqual(state.history.at(-1), { ...state.history.at(-1), reason: 'threshold', result: 'selected', from: 'claude:c1', to: 'claude:c2' })
  assert.match(state.history.at(-1)?.why ?? '', /^one is nearly at the end of its 5h window .*; new launches use two/)
  assert.match(lastNote(w), /^Claude: one is nearly at the end of its 5h window .* Only new sessions start on two@example\.test\./)
  assert.match(lastNote(w), /Orca may now offer to restart your running sessions: you do not need to\. They keep working on the account they are on/)
  // c2 is running Low too (t5 works there) a minute later: within the cooldown nothing changes again.
  later.session = 98
  w.advance(1 * MIN + 1000)
  await w.rotator.tick()
  w.advance(2 * MIN)
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select claude c2'])
  // After the 5-minute cooldown it may: to c3, never back to c1, which was left as Low.
  w.advance(3 * MIN)
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select claude c2', 'select claude c3'])
  state = stored(w)
  assert.equal(state.history.filter((h) => h.result === 'selected').length, 2)
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.deepEqual(w.typed, [])
  await worker.deactivate()
})

test('smart: a selection-only change needs a session in mid-turn on the selected account', async () => {
  // The only session is between turns (and not idle for long): it will move itself at its next
  // turn end, so the selection is left alone until then.
  const w = calm({ session: 97, weekly: 40 }, { panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1', stateStartedAt: 1_000_000 }] })
  const worker = await w.mount()
  await w.rotator.tick()
  assert.deepEqual(selects(w), [])
  await worker.deactivate()
})

test('smart: unsent text in the input box blocks the move', async () => {
  const w = calm({ session: 97, weekly: 40 })
  w.tails.t1 = ['⏺ Done.', '╭──────────────╮', '│ > also update the docs', '╰──────────────╯']
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  // Idle for 20 minutes: the idle sweep leaves it alone too.
  w.advance(20 * MIN)
  await w.rotator.tick()
  assert.deepEqual(selects(w), [])
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  // Sent: the next turn end moves it.
  w.tails.t1 = ['❯ also update the docs', '⏺ Updated README.md.', '╭──────────────╮', '│ >', '╰──────────────╯']
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 2))
  assert.deepEqual(selects(w), ['select claude c2'])
  await worker.deactivate()
})

test('a session that went on while its move waited behind another one is left alone', async () => {
  // Two sessions end a turn on a Low account at once. While the first is being moved (close,
  // resume, wait until ready), the user goes on in the second.
  for (const went of ['typing', 'working'] as const) {
    const w = calm(
      { session: 97, weekly: 40 },
      {
        panes: [
          { terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' },
          { terminalId: 'tB', agent: 'claude', state: 'done', sessionId: 'sB' }
        ],
        tails: { t1: [...fx.CLAUDE_TALKING_ABOUT_LIMITS], tB: [...fx.CLAUDE_TALKING_ABOUT_LIMITS] },
        state: { paneSeat: { t1: 'claude:c1', tB: 'claude:c1' } },
        onSleep: () => {
          if (went === 'typing') w.tails.tB = [...fx.CLAUDE_TALKING_ABOUT_LIMITS, ...DRAFT_BOX]
          else w.panes.find((p) => p.terminalId === 'tB')!.state = 'working'
        }
      }
    )
    const worker = await w.mount()
    await Promise.all([worker.emit('agent.status.changed', statusEvent('t1')), worker.emit('agent.status.changed', statusEvent('tB'))])
    assert.deepEqual((w.host.callsOf('agent.resume') as { sessionId: string }[]).map((c) => c.sessionId), ['s1'], went)
    assert.ok(w.panes.some((p) => p.terminalId === 'tB'), went)
    await worker.deactivate()
  }
})

test('a limited session the user restarted while its move waited behind another one is not closed mid-turn', async () => {
  const w = world({
    panes: [
      { terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' },
      { terminalId: 'tB', agent: 'claude', state: 'done', sessionId: 'sB' }
    ],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT, tB: fx.CLAUDE_SESSION_LIMIT },
    state: { paneSeat: { t1: 'claude:c1', tB: 'claude:c1' } },
    onSleep: () => {
      w.panes.find((p) => p.terminalId === 'tB')!.state = 'working'
    }
  })
  const worker = await w.mount()
  await Promise.all([worker.emit('agent.status.changed', statusEvent('t1')), worker.emit('agent.status.changed', statusEvent('tB'))])
  assert.deepEqual((w.host.callsOf('agent.resume') as { sessionId: string }[]).map((c) => c.sessionId), ['s1'])
  assert.ok(w.panes.some((p) => p.terminalId === 'tB'))
  // When that turn ends on the same limit (a new copy of the banner), it is handled then.
  w.panes.find((p) => p.terminalId === 'tB')!.state = 'done'
  w.tails.tB = [...fx.CLAUDE_SESSION_LIMIT, '❯ continue', ...fx.CLAUDE_SESSION_LIMIT]
  await worker.emit('agent.status.changed', statusEvent('tB', 'done', 2))
  assert.equal(w.host.callsOf('agent.resume').length, 2)
  await worker.deactivate()
})

test('smart: paused, or the service off, does nothing at all', async () => {
  for (const off of ['paused', 'service'] as const) {
    const w = world({
      panes: [
        { terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' },
        { terminalId: 't9', agent: 'claude', state: 'working', sessionId: 's9' }
      ],
      tails: { t1: [...fx.CLAUDE_TALKING_ABOUT_LIMITS], t9: ['⏺ Working on it…'] },
      // Low, with a target that has weekly quota about to expire: every Smart trigger applies.
      claudeUsage: { session: 98, weekly: 40, weeklyReset: 1_000_000 + 6 * 86_400_000 },
      inactiveClaude: { c2: { session: 5, weekly: 5 } },
      settings: off === 'service' ? { service_claude: false } : {},
      state: { paneSeat: { t1: 'claude:c1', t9: 'claude:c1' } }
    })
    const worker = await w.mount()
    if (off === 'paused') await worker.request('rotator.pause', { paused: true })
    await worker.emit('agent.status.changed', statusEvent('t1'))
    w.advance(20 * MIN)
    await w.rotator.tick()
    w.advance(20 * MIN)
    await w.rotator.tick()
    await worker.emit('agent.status.changed', statusEvent('t1', 'done', 2))
    assert.deepEqual(selects(w), [], off)
    assert.equal(w.host.callsOf('terminal.close').length, 0, off)
    assert.equal(w.host.callsOf('agent.resume').length, 0, off)
    assert.deepEqual(w.typed, [], off)
    const state = stored(w)
    assert.equal(state.history.length, 0, off)
    assert.deepEqual(state.leftLow ?? {}, {}, off)
    assert.deepEqual(state.waiting, [], off)
    await worker.deactivate()
  }
})

test('smart: only the session whose turn ended moves; the others follow at their own turn end', async () => {
  const w = calm({ session: 97, weekly: 40 }, {
    panes: [
      { terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1', stateStartedAt: 1_000_000 },
      { terminalId: 't9', agent: 'claude', state: 'done', sessionId: 's9', stateStartedAt: 1_000_000 }
    ],
    tails: { t1: [...fx.CLAUDE_TALKING_ABOUT_LIMITS], t9: [...fx.CLAUDE_TALKING_ABOUT_LIMITS] },
    state: { paneSeat: { t1: 'claude:c1', t9: 'claude:c1' } }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(w.host.callsOf('terminal.close').map((c: any) => c.terminalId), ['t1'])
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  await w.rotator.tick()
  // t9 has not been touched: still on c1, still open.
  assert.deepEqual(w.host.callsOf('terminal.close').map((c: any) => c.terminalId), ['t1'])
  assert.equal(stored(w).paneSeat.t9, 'claude:c1')
  assert.ok(w.panes.some((p) => p.terminalId === 't9'))
  // Its own turn end moves it, onto the account already selected (no second selection change).
  await worker.emit('agent.status.changed', statusEvent('t9', 'done', 2))
  assert.deepEqual(w.host.callsOf('terminal.close').map((c: any) => c.terminalId), ['t1', 't9'])
  assert.deepEqual(selects(w), ['select claude c2'])
  await worker.deactivate()
})

test('smart: an account left as Low is not gone back to within its 5-hour window, unless a reading shows it reset', async () => {
  const usage = { session: 80, weekly: 10 }
  const later = { session: 5, weekly: 5 }
  const inactiveClaude: Record<string, { session: number; weekly: number }> = { c2: { session: 5, weekly: 5 } }
  const w = calm(usage, { laterClaudeUsage: later, inactiveClaude, settings: { exclude: 'claude:c3' } })
  const worker = await w.mount()
  // c1 fills at 1 point a minute and is left at 92 %, 8 minutes before its limit.
  for (const level of [84, 88, 92]) {
    w.advance(4 * MIN)
    usage.session = level
    await w.rotator.tick()
  }
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.equal(stored(w).leftLow?.['claude:c1']?.until, 1_000_000 + 3_600_000)
  // c1 is no longer in use and stays at 92 %: by its numbers alone it would be a fine target again.
  inactiveClaude.c1 = { session: 92, weekly: 10 }
  delete inactiveClaude.c2
  w.tails.t2 = [...fx.CLAUDE_TALKING_ABOUT_LIMITS]
  // Half an hour on, c2 is used up. Its session may leave for any known account… but not c1.
  w.advance(30 * MIN)
  later.session = 100
  await w.rotator.tick()
  await worker.emit('agent.status.changed', statusEvent('t2', 'done', 2))
  w.advance(6 * MIN)
  await w.rotator.tick()
  await worker.emit('agent.status.changed', statusEvent('t2', 'done', 3))
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  assert.ok(stored(w).leftLow?.['claude:c1'])
  // A reading taken since shows c1's window has started over: it is a target again.
  inactiveClaude.c1 = { session: 3, weekly: 11 }
  w.advance(2 * MIN)
  await w.rotator.tick()
  assert.equal(stored(w).leftLow?.['claude:c1'], undefined)
  await worker.emit('agent.status.changed', statusEvent('t2', 'done', 4))
  assert.deepEqual(selects(w), ['select claude c2', 'select claude c1'])
  assert.equal(w.host.callsOf('agent.resume').length, 2)
  await worker.deactivate()
})

test('smart: short wait. An account that resets within 5 minutes is waited for, not left', async () => {
  // A limit, c1's 5-hour window resets in 4 minutes, and c2 would be free to take the session.
  const usage = { session: 100, weekly: 40, sessionReset: 1_000_000 + 4 * MIN }
  const w = calm(usage, { tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET] } })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(w), [])
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  let state = stored(w)
  assert.deepEqual(state.waiting.map((x) => [x.terminalId, x.hold, x.wakeAt]), [['t1', 'short', 1_000_000 + 4 * MIN]])
  assert.equal(state.history.at(-1)?.result, 'waiting')
  assert.equal(state.history.at(-1)?.why, 'one resets in 4 min; waiting is cheaper than moving, which re-reads the whole conversation')
  assert.match(lastNote(w), /^Claude: one resets in 4 min\. The session waits and continues there/)
  // Another account having room does not end a short wait early.
  w.advance(2 * MIN)
  await w.rotator.tick()
  assert.deepEqual(selects(w), [])
  assert.equal(stored(w).waiting.length, 1)
  // The window has reset: the session continues where it is. Nothing is closed or resumed.
  w.advance(2 * MIN + 1000)
  usage.session = 0
  usage.sessionReset = 1_000_000 + 5 * 3_600_000
  await w.rotator.tick()
  state = stored(w)
  assert.equal(state.waiting.length, 0)
  assert.deepEqual(w.typed, [{ terminalId: 't1', text: 'Go continue.' }])
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  assert.deepEqual(selects(w), [])
  assert.deepEqual(state.history.at(-1), { ...state.history.at(-1), reason: 'reset', result: 'retried', from: 'claude:c1', to: 'claude:c1', why: 'one has reset; the session continues there' })
  await worker.deactivate()

  // 6 minutes away is not short: the session moves as usual.
  const far = calm({ session: 100, weekly: 40, sessionReset: 1_000_000 + 6 * MIN }, { tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET] } })
  const fw = await far.mount()
  await fw.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(far), ['select claude c2'])
  assert.equal(stored(far).waiting.length, 0)
  await fw.deactivate()

  // Low (not at a limit) and resetting in 4 minutes: the session simply stays.
  const low = calm({ session: 98, weekly: 40, sessionReset: 1_000_000 + 4 * MIN })
  const lw = await low.mount()
  await lw.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(low), [])
  assert.equal(stored(low).waiting.length, 0)
  assert.equal(stored(low).history.length, 0)
  await lw.deactivate()

  // The legacy settings (custom) know no short wait.
  const custom = calm({ session: 100, weekly: 40, sessionReset: 1_000_000 + 4 * MIN }, { tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET] }, settings: { mode: 'custom' } })
  const cw = await custom.mount()
  await cw.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(custom), ['select claude c2'])
  await cw.deactivate()
})

test('smart: short wait when the best target would run out before the source is back', async () => {
  // c1 is at its limit and back in 12 minutes. c2, the only other account, has filled by 2 points
  // a minute and has 45 left: about 22 minutes, under three horizons, and c1 is back before that.
  const usage = { session: 40, weekly: 40, sessionReset: 1_000_000 + 30 * MIN }
  const inactiveClaude: Record<string, { session: number; weekly: number }> = { c2: { session: 19, weekly: 5 } }
  const w = calm(usage, { tails: { t1: [...fx.CLAUDE_TALKING_ABOUT_LIMITS] }, inactiveClaude, settings: { exclude: 'claude:c3' } })
  const worker = await w.mount()
  for (const level of [31, 43, 55]) {
    w.advance(4 * MIN)
    inactiveClaude.c2 = { session: level, weekly: 5 }
    await w.rotator.tick()
  }
  w.advance(6 * MIN)
  usage.session = 100
  w.tails.t1 = [...fx.CLAUDE_LIMIT_NO_RESET]
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(w), [])
  assert.deepEqual(stored(w).waiting.map((x) => [x.hold, x.wakeAt]), [['short', 1_000_000 + 30 * MIN]])
  await worker.deactivate()
})

test('smart: use it or lose it. An idle session, and new launches, go to weekly quota that would expire', async () => {
  // c1 resets in 6 days; c2 has 95 % of its week left and resets in 24 h.
  const w = calm({ session: 20, weekly: 30, weeklyReset: 1_000_000 + 6 * 86_400_000 })
  const worker = await w.mount()
  // A turn end is no reason for this move.
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  // The selection for new launches changes at the next tick; the session follows once idle (it has
  // been since the fixture's start).
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select claude c2'])
  const state = stored(w)
  assert.deepEqual(state.history.map((h) => [h.reason, h.result]), [['expiring', 'selected'], ['expiring', 'resumed']])
  assert.equal(state.history[0]?.why, 'two has weekly quota that would expire unused (5h 5 %, week 5 %, weekly resets in 24 h); new launches use it')
  assert.equal(state.history[1]?.why, 'idle session; two has weekly quota that would expire unused (5h 5 %, week 5 %, weekly resets in 24 h); moved there from one')
  assert.equal(state.paneSeat.t2, 'claude:c2')
  // Nothing moves back: c1 has nothing expiring.
  w.tails.t2 = [...fx.CLAUDE_TALKING_ABOUT_LIMITS]
  w.advance(30 * MIN)
  await w.rotator.tick()
  await worker.emit('agent.status.changed', statusEvent('t2', 'done', 2))
  assert.deepEqual(selects(w), ['select claude c2'])
  await worker.deactivate()

  // Follow my order never does this: the order decides.
  const ordered = calm({ session: 20, weekly: 30, weeklyReset: 1_000_000 + 6 * 86_400_000 }, { settings: { chain: 'claude:c1, claude:c2' } })
  const ow = await ordered.mount()
  await ordered.rotator.tick()
  assert.deepEqual(selects(ordered), [])
  await ow.deactivate()
})

test('smart: Running sessions. "Only at a limit" and "New launches only" leave a Low session where it is', async () => {
  for (const running_sessions of ['limit', 'launches']) {
    const w = calm({ session: 98, weekly: 40 }, { settings: { running_sessions } })
    const worker = await w.mount()
    await worker.emit('agent.status.changed', statusEvent('t1'))
    w.advance(20 * MIN)
    await w.rotator.tick()
    assert.deepEqual(selects(w), [], running_sessions)
    // A real limit still acts: "limit" moves the session, "launches" only changes the account.
    w.tails.t1 = [...fx.CLAUDE_SESSION_LIMIT]
    await worker.emit('agent.status.changed', statusEvent('t1', 'done', 2))
    assert.deepEqual(selects(w), ['select claude c2'], running_sessions)
    assert.equal(w.host.callsOf('agent.resume').length, running_sessions === 'limit' ? 1 : 0, running_sessions)
    await worker.deactivate()
  }
})

test('my order: leaves a Low account early, and switch-back does not return to it within its window', async () => {
  const later = { session: 5, weekly: 5 }
  const inactiveClaude: Record<string, { session: number; weekly: number }> = { c2: { session: 5, weekly: 5 } }
  const w = calm({ session: 97, weekly: 40 }, { laterClaudeUsage: later, inactiveClaude, settings: { chain: 'claude:c1, claude:c2, claude:c3' } })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(w), ['select claude c2'])
  // c1 is first in the order and under 100 %: the legacy switch-back would return at once.
  inactiveClaude.c1 = { session: 97, weekly: 40 }
  delete inactiveClaude.c2
  w.tails.t2 = [...fx.CLAUDE_TALKING_ABOUT_LIMITS]
  w.advance(20 * MIN)
  await w.rotator.tick()
  await worker.emit('agent.status.changed', statusEvent('t2', 'done', 2))
  assert.deepEqual(selects(w), ['select claude c2'])
  // A reading shows c1's window has started again (2 % used), which ends the mark. At this tick
  // switch-back selects c1 for new launches; the session, idle for over 15 minutes by then,
  // goes back in the same tick's idle check. (One that had just finished a turn would wait for
  // its next turn end, or until it had been idle that long.)
  w.advance(45 * MIN)
  inactiveClaude.c1 = { session: 2, weekly: 40 }
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select claude c2', 'select claude c1'])
  assert.deepEqual(
    stored(w).history.slice(-2).map((h) => [h.reason, h.result, h.from, h.to]),
    [
      ['switch_back', 'selected', 'claude:c2', 'claude:c1'],
      ['switch_back', 'resumed', 'claude:c2', 'claude:c1']
    ]
  )
  assert.deepEqual(stored(w).paneSeat, { t3: 'claude:c1' })
  await worker.deactivate()
})

test('smart: a Low account is left for a target with moderate weekly use (the headroom gap is not halved)', async () => {
  // c1 is at 97 % of its 5-hour window; c2 has used 45 % of its week. The legacy comparison
  // halves 5-hour use (48.5 against 45) and would keep the session on c1 until it hits the limit.
  const w = calm({ session: 97, weekly: 30 }, { inactiveClaude: { c2: { session: 5, weekly: 45 } } })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.equal(stored(w).history.at(-1)?.result, 'resumed')
  await worker.deactivate()

  // A target with under 10 points of room left is not worth an early move.
  const tight = calm({ session: 97, weekly: 30 }, { inactiveClaude: { c2: { session: 5, weekly: 93 } }, settings: { exclude: 'claude:c3' } })
  const tw = await tight.mount()
  await tw.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(tight), [])
  await tw.deactivate()

  // The same comparison decides a selection-only change (a session is mid-turn on c1).
  const busy = calm({ session: 97, weekly: 30 }, {
    panes: [{ terminalId: 't1', agent: 'claude', state: 'working', sessionId: 's1' }],
    inactiveClaude: { c2: { session: 5, weekly: 45 } }
  })
  const bw = await busy.mount()
  await busy.rotator.tick()
  assert.deepEqual(selects(busy), ['select claude c2'])
  assert.equal(busy.host.callsOf('terminal.close').length, 0)
  await bw.deactivate()

  // Custom keeps the legacy comparison.
  const custom = calm({ session: 97, weekly: 30 }, { inactiveClaude: { c2: { session: 5, weekly: 45 } }, settings: { mode: 'custom', thresholds_five_hour: 95 } })
  const cw = await custom.mount()
  await cw.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(custom), [])
  await cw.deactivate()
})

test('smart: a session is not moved when the fresh reading shows its account is no longer Low', async () => {
  // The cached reading says 97 % of the 5-hour window; the window has reset since.
  const usage = { session: 97, weekly: 50, sessionReset: 1_000_000 + 3_600_000 }
  const w = calm(usage)
  const worker = await w.mount()
  usage.session = 2
  usage.sessionReset = 1_000_000 + 5 * 3_600_000
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(w), [])
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(stored(w).history.length, 0)
  await worker.deactivate()
})

test('smart: a short wait never types into a pane that holds unsent text', async () => {
  const usage = { session: 100, weekly: 40, sessionReset: 1_000_000 + 4 * MIN }
  const w = calm(usage, { tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET] } })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(stored(w).waiting[0]?.hold, 'short')
  // While waiting, the user starts typing in the parked pane and has not sent it.
  w.tails.t1 = [...fx.CLAUDE_LIMIT_NO_RESET, '╭──────────────╮', '│ > also update the docs', '╰──────────────╯']
  w.advance(4 * MIN + 1000)
  usage.session = 0
  usage.sessionReset = 1_000_000 + 5 * 3_600_000
  await w.rotator.tick()
  // The account is back, but the draft is the user's: nothing is typed, closed or resumed.
  assert.deepEqual(w.typed, [])
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  assert.equal(stored(w).waiting.length, 0)
  assert.match(lastNote(w), /has reset.*unsent text/)
  await worker.deactivate()
})

// ---- Unsent text: a limit, or the wake of a parked session, never closes such a pane ------------

// Live (Orca 1.4.263): `terminal.read` leaves the text typed in an agent's input box out of its
// lines (the box reads as empty) and `orca terminal read --json` reports it apart, as `draft`.
const EMPTY_BOX = ['╭──────────────╮', '│ >', '╰──────────────╯']

test('unsent text Orca reports apart from the screen: a limit does not close the pane, and moves once it is gone', async () => {
  const drafts: Record<string, string> = { t1: 'also update the docs' }
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET, ...EMPTY_BOX] },
    state: { paneSeat: { t1: 'claude:c1' } },
    drafts
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  w.advance(30_000)
  await w.rotator.tick()
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  assert.deepEqual(selects(w), [])
  assert.deepEqual(w.typed, [])
  assert.deepEqual(notes(w), ['Claude hit its limit on one. Send or clear the text you were typing and the session moves to two.'])
  assert.ok(stored(w).waiting[0]?.draftAt)
  // Cleared: the next look carries the move out.
  delete drafts.t1
  w.advance(30_000)
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.deepEqual(w.host.callsOf('terminal.close'), [{ terminalId: 't1' }])
  assert.deepEqual(w.typed, [{ terminalId: 't2', text: 'Go continue.' }])
  await worker.deactivate()
})

test('unsent text Orca reports apart from the screen: no early move, no retry and no model switch is typed over it', async () => {
  // Smart, a turn that ends on a Low account: the session stays until the text is gone.
  const drafts: Record<string, string> = { t1: 'also update the docs' }
  const low = calm({ session: 97, weekly: 40 }, { drafts })
  let worker = await low.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  low.advance(20 * MIN)
  await low.rotator.tick()
  assert.deepEqual(selects(low), [])
  assert.equal(low.host.callsOf('terminal.close').length, 0)
  delete drafts.t1
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 2))
  assert.deepEqual(selects(low), ['select claude c2'])
  await worker.deactivate()

  // An API error is not retried into the box, and a fallback model is not typed into it.
  for (const tail of [fx.CLAUDE_API_ERROR, fx.CLAUDE_MODEL_CAP]) {
    const w = world({
      panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
      tails: { t1: [...tail, ...EMPTY_BOX] },
      settings: { mode: 'custom', model_fallback: 'claude=sonnet' },
      state: { paneSeat: { t1: 'claude:c1' } },
      drafts: { t1: 'also update the docs' }
    })
    worker = await w.mount()
    await worker.emit('agent.status.changed', statusEvent('t1'))
    assert.deepEqual(w.typed, [])
    assert.deepEqual(selects(w), [])
    assert.equal(stored(w).history.at(-1)?.detail, 'unsent text in the input box')
    await worker.deactivate()
  }

  // The command that moves this workspace's agent refuses as well.
  const cmd = calm({ session: 50, weekly: 40 }, { drafts: { t1: 'also update the docs' } })
  worker = await cmd.mount()
  assert.match(String(await worker.command('rotator.swapThisPane')), /unsent text/)
  assert.equal(cmd.host.callsOf('terminal.close').length, 0)
  await worker.deactivate()

  // Orca cannot say (the read fails): the screen lines decide, as before.
  const blind = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET, ...EMPTY_BOX] },
    state: { paneSeat: { t1: 'claude:c1' } },
    drafts: { t1: '!' }
  })
  worker = await blind.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(blind), ['select claude c2'])
  await worker.deactivate()
})

const notes = (w: { host: { callsOf(method: string): any[] } }): string[] => w.host.callsOf('notifications.show').map((c: any) => c.body as string)

/** A Claude pane known to run on c1 that stopped on a limit while the user was typing in it. */
const limitedWithDraft = (extra: Partial<Parameters<typeof world>[0]> = {}) =>
  world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET, ...DRAFT_BOX] },
    state: { paneSeat: { t1: 'claude:c1' } },
    ...extra
  })

test('unsent text: a limit does not close the pane; it is said once and noted once', async () => {
  const w = limitedWithDraft()
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('close')), [])
  assert.deepEqual(selects(w), [])
  assert.deepEqual(w.typed, [])
  assert.ok(w.panes.some((p) => p.terminalId === 't1'))
  assert.deepEqual(notes(w), ['Claude hit its limit on one. Send or clear the text you were typing and the session moves to two.'])
  let state = stored(w)
  assert.equal(state.waiting.length, 1)
  assert.equal(state.waiting[0]!.reason, 'rate_limit')
  assert.ok(state.waiting[0]!.draftAt)
  // The account is still set aside, so nothing else is sent there.
  assert.ok(state.health['claude:c1']?.cooldownUntil! > 1_000_000)
  assert.deepEqual(state.history.map((h) => [h.reason, h.result, h.detail]), [['rate_limit', 'waiting', 'unsent text in the input box']])
  // Status events and ticks look again while the text is there: no second notice, no second
  // history entry, and the pane stays.
  for (let i = 0; i < 4; i++) {
    await worker.emit('agent.status.changed', statusEvent('t1', i % 2 ? 'done' : 'waiting', 2 + i))
    w.advance(30_000)
    await w.rotator.tick()
  }
  state = stored(w)
  assert.equal(notes(w).length, 1)
  assert.equal(state.history.length, 1)
  assert.equal(state.waiting.length, 1)
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.deepEqual(selects(w), [])
  assert.deepEqual(w.typed, [])
  await worker.deactivate()
})

test('unsent text: once it is cleared the limit move happens (at a tick, or at a status event)', async () => {
  for (const by of ['tick', 'event'] as const) {
    const w = limitedWithDraft()
    const worker = await w.mount()
    await worker.emit('agent.status.changed', statusEvent('t1'))
    assert.equal(w.host.callsOf('terminal.close').length, 0, by)
    w.tails.t1 = [...fx.CLAUDE_LIMIT_NO_RESET, '╭──────────────╮', '│ >', '╰──────────────╯']
    w.advance(30_000)
    if (by === 'tick') await w.rotator.tick()
    else await worker.emit('agent.status.changed', statusEvent('t1', 'waiting', 2))
    assert.deepEqual(selects(w), ['select claude c2'], by)
    assert.deepEqual(w.host.callsOf('terminal.close'), [{ terminalId: 't1' }], by)
    assert.deepEqual(w.host.callsOf('agent.resume'), [{ workspaceId: 'w1', agent: 'claude', sessionId: 's1' }], by)
    assert.deepEqual(w.typed, [{ terminalId: 't2', text: 'Go continue.' }], by)
    const state = stored(w)
    assert.equal(state.waiting.length, 0, by)
    assert.equal(state.paneSeat.t2, 'claude:c2', by)
    assert.deepEqual([state.history.at(-1)?.reason, state.history.at(-1)?.result], ['rate_limit', 'resumed'], by)
    assert.match(state.history.at(-1)?.why ?? '', /hit a usage limit; moved to two/, by)
    // One notice for the wait, one for the move.
    assert.equal(notes(w).length, 2, by)
    await w.rotator.tick()
    assert.equal(w.host.callsOf('agent.resume').length, 1, by)
    await worker.deactivate()
  }
})

test('unsent text: sent instead of cleared, the turn that follows is handled as any other', async () => {
  const w = limitedWithDraft()
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  // The user sends it: the pane works, and a tick in between leaves it alone and stops waiting.
  w.tails.t1 = [...fx.CLAUDE_LIMIT_NO_RESET, '❯ also update the docs']
  w.panes[0]!.state = 'working'
  await w.rotator.tick()
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(stored(w).waiting.length, 0)
  // The turn ends on the same limit (a new copy of the banner): now the session moves.
  w.panes[0]!.state = 'done'
  w.tails.t1 = [...fx.CLAUDE_LIMIT_NO_RESET, '❯ also update the docs', ...fx.CLAUDE_LIMIT_NO_RESET]
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 2))
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  await worker.deactivate()
})

test('unsent text: the wake of a parked session waits for it too', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET] },
    state: {
      paneSeat: { t1: 'claude:c1' },
      health: { 'claude:c2': { cooldownUntil: 1_000_000 + 10 * MIN }, 'claude:c3': { cooldownUntil: 1_000_000 + 20 * MIN } }
    }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(stored(w).waiting.length, 1)
  const before = notes(w).length
  // While parked, the user starts typing and does not send it.
  w.tails.t1 = [...fx.CLAUDE_LIMIT_NO_RESET, ...DRAFT_BOX]
  w.advance(11 * MIN)
  for (let i = 0; i < 3; i++) {
    await w.rotator.tick()
    w.advance(30_000)
  }
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  assert.deepEqual(selects(w), [])
  assert.deepEqual(w.typed, [])
  assert.deepEqual(notes(w).slice(before), ['Claude: two is free again. Send or clear the text you were typing and the session moves to two.'])
  let state = stored(w)
  assert.equal(state.waiting.length, 1)
  assert.ok(state.waiting[0]!.draftAt)
  assert.equal(state.history.filter((h) => h.detail === 'unsent text in the input box').length, 1)
  // Cleared: the wake goes through as before.
  w.tails.t1 = [...fx.CLAUDE_LIMIT_NO_RESET]
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.deepEqual(w.host.callsOf('terminal.close'), [{ terminalId: 't1' }])
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  state = stored(w)
  assert.equal(state.waiting.length, 0)
  assert.deepEqual([state.history.at(-1)?.reason, state.history.at(-1)?.result], ['reset', 'resumed'])
  await worker.deactivate()
})

test('unsent text: paused, or the service off, the pending move stays pending after the text is gone', async () => {
  for (const off of ['paused', 'service'] as const) {
    const w = limitedWithDraft()
    const worker = await w.mount()
    await worker.emit('agent.status.changed', statusEvent('t1'))
    assert.equal(stored(w).waiting.length, 1, off)
    if (off === 'paused') await worker.request('rotator.pause', { paused: true })
    else await worker.request('rotator.setService', { provider: 'claude', enabled: false })
    w.tails.t1 = [...fx.CLAUDE_LIMIT_NO_RESET]
    for (let i = 0; i < 3; i++) {
      w.advance(30_000)
      await w.rotator.tick()
      await worker.emit('agent.status.changed', statusEvent('t1', 'waiting', 2 + i))
    }
    assert.deepEqual(selects(w), [], off)
    assert.equal(w.host.callsOf('terminal.close').length, 0, off)
    assert.equal(w.host.callsOf('agent.resume').length, 0, off)
    assert.deepEqual(w.typed, [], off)
    assert.equal(notes(w).filter((n) => /Send or clear/.test(n)).length, 1, off)
    assert.equal(stored(w).waiting.length, 1, off)
    // Back on: the move is carried out.
    if (off === 'paused') await worker.request('rotator.pause', { paused: false })
    else await worker.request('rotator.setService', { provider: 'claude', enabled: true })
    await w.rotator.tick()
    assert.deepEqual(selects(w), ['select claude c2'], off)
    assert.equal(w.host.callsOf('agent.resume').length, 1, off)
    await worker.deactivate()
  }
})

test('unsent text: a limit on a paused or switched-off service is only noted, as before', async () => {
  for (const off of ['paused', 'service'] as const) {
    const w = limitedWithDraft(off === 'service' ? { settings: { service_claude: false } } : {})
    const worker = await w.mount()
    if (off === 'paused') await worker.request('rotator.pause', { paused: true })
    await worker.emit('agent.status.changed', statusEvent('t1'))
    await w.rotator.tick()
    assert.equal(stored(w).waiting.length, 0, off)
    assert.equal(stored(w).history.length, 0, off)
    assert.equal(notes(w).filter((n) => /Send or clear/.test(n)).length, 0, off)
    assert.equal(w.host.callsOf('terminal.close').length, 0, off)
    await worker.deactivate()
  }
})

test('unsent text: a Codex limit (handoff) launches nothing and closes nothing until it is gone', async () => {
  const w = world({
    panes: [{ terminalId: 'k1', agent: 'codex', state: 'done', sessionId: 'cs1' }],
    tails: { k1: [...fx.CODEX_USAGE_LIMIT, '', '› and bump the version', '  gpt-5 default · ~/projects/demo'] }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('k1'))
  assert.equal(w.host.callsOf('agent.launch').length, 0)
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(notes(w).filter((n) => /^Codex hit its limit.*Send or clear/.test(n)).length, 1)
  w.tails.k1 = [...fx.CODEX_USAGE_LIMIT, '', '› Ask Codex to do anything', '  gpt-5 default · ~/projects/demo']
  await w.rotator.tick()
  assert.equal(w.host.callsOf('agent.launch').length, 1)
  assert.deepEqual(w.host.callsOf('terminal.close'), [{ terminalId: 'k1' }])
  assert.equal(stored(w).history.at(-1)?.result, 'handoff')
  await worker.deactivate()
})

test('unsent text: the command that moves this workspace’s agent refuses instead of closing the pane', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: ['⏺ Done.', ...DRAFT_BOX] },
    claudeUsage: { session: 5, weekly: 5 }
  })
  const worker = await w.mount()
  assert.match(await w.rotator.swapFocused(), /unsent text in its input box/)
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.deepEqual(selects(w), [])
  w.tails.t1 = ['⏺ Done.']
  assert.match(await w.rotator.swapFocused(), /moved to/)
  assert.equal(w.host.callsOf('terminal.close').length, 1)
  await worker.deactivate()
})

test('unsent text: a model cap that waited still goes to the account with room for that model', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [...fx.CLAUDE_MODEL_CAP, ...DRAFT_BOX] },
    // c2 is full in its Fable bucket; c3 has room there.
    inactiveClaude: { c2: { session: 5, weekly: 5, fable: 95 }, c3: { session: 30, weekly: 30, fable: 20 } },
    state: { paneSeat: { t1: 'claude:c1' } }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.deepEqual(w.typed, [])
  assert.match(lastNote(w), /Send or clear the text you were typing and the session moves to me\./)
  assert.equal(stored(w).waiting[0]?.model, 'fable')
  w.tails.t1 = [...fx.CLAUDE_MODEL_CAP]
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select claude c3'])
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  assert.deepEqual([stored(w).history.at(-1)?.reason, stored(w).history.at(-1)?.result], ['model_cap', 'resumed'])
  assert.match(stored(w).history.at(-1)?.why ?? '', /hit its fable limit; moved to me/)
  await worker.deactivate()
})

test('unsent text: a wait cancelled from the panel is not carried out; two looks at once move the session once', async () => {
  const w = limitedWithDraft()
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  w.tails.t1 = [...fx.CLAUDE_LIMIT_NO_RESET]
  await worker.request('rotator.cancelWaiting', { terminalId: 't1' })
  await w.rotator.tick()
  await worker.emit('agent.status.changed', statusEvent('t1', 'waiting', 2))
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  await worker.deactivate()

  // A handoff leaves no session id to recognise the moved session by: the tick and a status
  // event that look at the same wait at once must still launch one successor, not two.
  const c = world({
    panes: [{ terminalId: 'k1', agent: 'codex', state: 'done' }],
    tails: { k1: [...fx.CODEX_USAGE_LIMIT, '', '› and bump the version', '  gpt-5 default · ~/projects/demo'] }
  })
  const cw = await c.mount()
  await cw.emit('agent.status.changed', statusEvent('k1'))
  assert.equal(c.host.callsOf('agent.launch').length, 0)
  c.tails.k1 = [...fx.CODEX_USAGE_LIMIT]
  await Promise.all([c.rotator.tick(), cw.emit('agent.status.changed', statusEvent('k1', 'waiting', 2))])
  assert.equal(c.host.callsOf('agent.launch').length, 1)
  // ...and the second look does not take the pane the first one closed for one the user closed.
  assert.deepEqual((c.host.data().storage.state as RotatorState).history.filter((h) => h.result === 'closed'), [])
  await cw.deactivate()
})

test('a parked session that is in the middle of a turn again (asking for permission) is not closed at wake time', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET] },
    state: {
      paneSeat: { t1: 'claude:c1' },
      health: { 'claude:c2': { cooldownUntil: 1_000_000 + 10 * MIN }, 'claude:c3': { cooldownUntil: 1_000_000 + 20 * MIN } }
    }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(stored(w).waiting.length, 1)
  // The limit lifted early and the user went on there; the agent now waits for a permission
  // answer, which is the middle of a turn (Orca reports `blocked`, and no turn end yet).
  w.tails.t1 = [...fx.CLAUDE_LIMIT_NO_RESET, '❯ carry on', '⏺ Bash(npm test)', '  Do you want to proceed?', '  1. Yes', '  2. No']
  w.panes[0]!.state = 'blocked'
  w.advance(11 * MIN)
  await w.rotator.tick()
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  assert.deepEqual(w.typed, [])
  assert.equal(stored(w).waiting.length, 0)
  // The session itself is left alone. It is in the middle of a turn on an account Orca still
  // reports as used up, so (as for a working session) only the account for new launches changes.
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.deepEqual(stored(w).history.filter((h) => h.result !== 'waiting').map((h) => h.result), ['selected'])
  await worker.deactivate()
})

const parkedWorld = (extra: { agentsListFails?: () => boolean } = {}) =>
  world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET] },
    state: {
      paneSeat: { t1: 'claude:c1' },
      health: { 'claude:c2': { cooldownUntil: 1_000_000 + 10 * MIN }, 'claude:c3': { cooldownUntil: 1_000_000 + 20 * MIN } }
    },
    ...extra
  })

test('a parked pane the user closed is not resumed at wake time: the wait is dropped with one History line', async () => {
  const w = parkedWorld()
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(stored(w).waiting.length, 1)
  const said = w.host.callsOf('notifications.show').length
  // The user closes the parked pane themselves.
  w.panes.splice(0, 1)
  w.advance(11 * MIN)
  await w.rotator.tick()
  await w.rotator.tick()
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  assert.equal(w.host.callsOf('agent.launch').length, 0)
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.deepEqual(selects(w), [])
  assert.deepEqual(w.typed, [])
  const state = stored(w)
  assert.equal(state.waiting.length, 0)
  const closed = state.history.filter((h) => h.result === 'closed')
  assert.equal(closed.length, 1)
  assert.equal(closed[0]!.terminalId, 't1')
  assert.match(closed[0]!.why ?? '', /closed/)
  assert.equal(state.paneSeat.t1, undefined)
  // Quiet: nothing is said about it.
  assert.equal(w.host.callsOf('notifications.show').length, said)
  await worker.deactivate()
})

test('a pane that waits for unsent text and is then closed by the user is not resumed either', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET, '❯ my half-typed prompt'] },
    state: { paneSeat: { t1: 'claude:c1' } }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(stored(w).waiting.length, 1)
  assert.ok(stored(w).waiting[0]!.draftAt)
  w.panes.splice(0, 1)
  delete w.tails.t1
  w.advance(MIN)
  await w.rotator.tick()
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  assert.equal(stored(w).waiting.length, 0)
  assert.equal(stored(w).history.at(-1)?.result, 'closed')
  await worker.deactivate()
})

test('a parked pane that is still open is resumed at wake time; the close of that move is not taken for the user closing it', async () => {
  const w = parkedWorld()
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(stored(w).waiting.length, 1)
  w.advance(11 * MIN)
  await w.rotator.tick()
  // The plugin closed t1 itself and resumed the session in a new pane.
  assert.equal(w.host.callsOf('terminal.close').length, 1)
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.deepEqual(w.panes.map((p) => [p.terminalId, p.sessionId]), [['t2', 's1']])
  assert.deepEqual(stored(w).paneSeat, { t2: 'claude:c2' })
  w.advance(MIN)
  await w.rotator.tick()
  const state = stored(w)
  assert.equal(state.waiting.length, 0)
  assert.equal(state.history.filter((h) => h.result === 'closed').length, 0)
  assert.equal(state.history.filter((h) => h.result === 'resumed').length, 1)
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  await worker.deactivate()
})

test('a parked pane Orca cannot list right now keeps waiting: it is neither dropped nor resumed blind', async () => {
  let fails = false
  const w = parkedWorld({ agentsListFails: () => fails })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(stored(w).waiting.length, 1)
  fails = true
  w.advance(11 * MIN)
  await w.rotator.tick()
  assert.equal(stored(w).waiting.length, 1)
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  fails = false
  w.advance(MIN)
  await w.rotator.tick()
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  assert.equal(stored(w).waiting.length, 0)
  await worker.deactivate()
})

test('per-pane memory: entries of panes that are gone are forgotten after a while; live and waiting panes keep theirs', async () => {
  const banner = { fingerprint: 'claude|rate_limit|x', occurrences: 1 }
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'working', sessionId: 's1' }],
    tails: { t1: ['⏺ Working.'] },
    claudeUsage: { session: 10, weekly: 10 },
    state: {
      paneSeat: { t1: 'claude:c1', gone1: 'claude:c2', gone2: 'claude:c1', parked: 'claude:c1' },
      seen: { t1: banner, gone1: banner, 'session:old': banner },
      apiRetries: { t1: 1, gone1: 2 },
      modelStep: { t1: 1, gone2: 1 },
      // A wait that is not due: its pane is the wake's business, not this clean-up's.
      waiting: [{ terminalId: 'parked', workspaceId: 'w1', agent: 'codex', wakeAt: 1_000_000 + 600 * MIN, hold: 'short' }]
    }
  })
  const worker = await w.mount()
  await w.rotator.tick()
  // Looked at no more than every 10 minutes, and nothing goes before 30 minutes of absence.
  for (let i = 0; i < 5; i++) {
    w.advance(5 * MIN)
    await w.rotator.tick()
  }
  assert.equal(w.rotator.state.paneSeat.gone1, 'claude:c2')
  assert.equal(w.rotator.state.apiRetries.gone1, 2)
  w.advance(5 * MIN)
  await w.rotator.tick()
  const state = stored(w)
  assert.deepEqual(state.paneSeat, { t1: 'claude:c1', parked: 'claude:c1' })
  assert.deepEqual(Object.keys(state.seen).sort(), ['session:old', 't1'])
  assert.deepEqual(state.apiRetries, { t1: 1 })
  assert.deepEqual(state.modelStep, { t1: 1 })
  await worker.deactivate()
})

test('per-pane memory: nothing is forgotten while Orca cannot list the panes, and a pane seen again starts over', async () => {
  let fails = true
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'working', sessionId: 's1' }],
    tails: { t1: ['⏺ Working.'] },
    claudeUsage: { session: 10, weekly: 10 },
    state: { paneSeat: { t1: 'claude:c1', t9: 'claude:c2' } },
    agentsListFails: () => fails
  })
  const worker = await w.mount()
  for (let i = 0; i < 5; i++) {
    await w.rotator.tick()
    w.advance(10 * MIN)
  }
  assert.deepEqual(w.rotator.state.paneSeat, { t1: 'claude:c1', t9: 'claude:c2' })
  fails = false
  // Missing for 20 minutes, then listed again (a pane Orca restored): the count starts over.
  for (let i = 0; i < 3; i++) {
    await w.rotator.tick()
    w.advance(10 * MIN)
  }
  w.panes.push({ terminalId: 't9', agent: 'claude', state: 'working' })
  await w.rotator.tick()
  w.panes.pop()
  for (let i = 0; i < 3; i++) {
    w.advance(10 * MIN)
    await w.rotator.tick()
  }
  assert.equal(w.rotator.state.paneSeat.t9, 'claude:c2')
  w.advance(10 * MIN)
  await w.rotator.tick()
  assert.deepEqual(w.rotator.state.paneSeat, { t1: 'claude:c1' })
  await worker.deactivate()
})

test('per-pane memory: each map is capped, newest entries kept', async () => {
  const many = Object.fromEntries(Array.from({ length: 620 }, (_, i) => [`old${i}`, 'claude:c2']))
  const counts = Object.fromEntries(Array.from({ length: 620 }, (_, i) => [`old${i}`, 1]))
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'working' }],
    tails: {},
    claudeUsage: { session: 10, weekly: 10 },
    state: { paneSeat: { ...many, t1: 'claude:c1' }, apiRetries: { ...counts, t1: 2 }, modelStep: { ...counts, t1: 3 } }
  })
  const worker = await w.mount()
  await w.rotator.setPaused(true)
  const state = stored(w)
  for (const map of [state.paneSeat, state.apiRetries, state.modelStep]) {
    assert.equal(Object.keys(map).length, 500)
    assert.ok('t1' in map)
    assert.ok(!('old0' in map))
  }
  await worker.deactivate()
})

// ---- The first message after a move, and the retry after an API error ---------------------------

test('after a move: the first message is not typed over text typed in the resumed pane, nor into a turn started there', async () => {
  // The user starts typing in the resumed pane before it is ready (Orca reports the text apart).
  const typing = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET] },
    state: { paneSeat: { t1: 'claude:c1' } },
    drafts: { t2: 'wait, first check the logs' }
  })
  let worker = await typing.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(typing.host.callsOf('agent.resume').length, 1)
  assert.deepEqual(typing.typed, [])
  assert.equal(typing.cliCalls.filter((c) => c.startsWith('send')).length, 0)
  assert.equal(stored(typing).history.at(-1)?.result, 'resumed')
  assert.equal(stored(typing).paneSeat.t2, 'claude:c2')
  assert.match(lastNote(typing), /unsent text in its input box.*left for you to continue/)
  await worker.deactivate()

  // The same with the text on the screen itself.
  const onScreen = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET], t2: ['⏺ Working on it.', ...DRAFT_BOX] },
    state: { paneSeat: { t1: 'claude:c1' } }
  })
  worker = await onScreen.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(onScreen.host.callsOf('agent.resume').length, 1)
  assert.deepEqual(onScreen.typed, [])
  await worker.deactivate()

  // The user sends a message in the resumed pane before it reports ready: it is in the middle of
  // a turn for as long as the plugin waits.
  const working = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET] },
    state: { paneSeat: { t1: 'claude:c1' } },
    onSleep: () => {
      const resumed = working.panes.find((p) => p.terminalId === 't2')
      if (resumed) resumed.state = 'working'
    }
  })
  worker = await working.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(working.host.callsOf('agent.resume').length, 1)
  assert.deepEqual(working.typed, [])
  assert.equal(stored(working).history.at(-1)?.result, 'resumed')
  await worker.deactivate()
})

test('API error: no retry is typed once the error is no longer the latest output; what is there instead is handled', async () => {
  // During the backoff the user went on and that turn finished without an error.
  const tails: Record<string, string[]> = { t1: [...fx.CLAUDE_API_ERROR] }
  const went = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails,
    claudeUsage: { session: 20, weekly: 20 },
    state: { paneSeat: { t1: 'claude:c1' } },
    onSleep: () => {
      tails.t1 = [...fx.CLAUDE_API_ERROR, '❯ never mind, just list the files', '⏺ Here they are:', '  src/a.ts', '  src/b.ts', '  src/c.ts', '  src/d.ts', '  src/e.ts', ...EMPTY_BOX]
    }
  })
  let worker = await went.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(went.typed, [])
  assert.equal(went.cliCalls.filter((c) => c.startsWith('send')).length, 0)
  assert.deepEqual(selects(went), [])
  assert.equal(stored(went).history.filter((h) => h.result === 'retried').length, 0)
  await worker.deactivate()

  // During the backoff the user went on and that turn ended on a limit. Its status event came
  // while the retry was still pending, so the limit is handled when the backoff is over.
  const limitTails: Record<string, string[]> = { t1: [...fx.CLAUDE_API_ERROR] }
  const limited = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: limitTails,
    state: { paneSeat: { t1: 'claude:c1' } },
    onSleep: () => {
      if (limited.panes.some((p) => p.terminalId === 't1')) limitTails.t1 = [...fx.CLAUDE_API_ERROR, '❯ continue', ...fx.CLAUDE_LIMIT_NO_RESET]
    }
  })
  worker = await limited.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(limited), ['select claude c2'])
  assert.deepEqual(limited.typed, [{ terminalId: 't2', text: 'Go continue.' }])
  assert.equal(stored(limited).history.at(-1)?.result, 'resumed')
  await worker.deactivate()
})

test('new launches: a tick already under way when a move changes the selection does not change it again within the cooldown', async () => {
  // c3 comes first in the user's order and Orca has no numbers for it; c2 is known to have room.
  // A limit on c1 moves the session to c2. A tick that began just before had already decided to
  // select c3 for new launches, and waits behind that move.
  let armed = false
  let tick: Promise<void> | undefined
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET] },
    inactiveClaude: { c2: { session: 5, weekly: 5 } },
    settings: { chain: 'claude:c3, claude:c1, claude:c2', auto_swap_idle_after_seconds: 0 },
    state: { paneSeat: { t1: 'claude:c1' } },
    onListAccounts: async () => {
      if (!armed || tick) return
      tick = w.rotator.tick()
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
  })
  const worker = await w.mount()
  armed = true
  await worker.emit('agent.status.changed', statusEvent('t1'))
  await tick
  assert.ok(tick, 'the tick ran during the move')
  // One selection change, so Orca offers to restart the running sessions once, not twice.
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.equal(stored(w).history.filter((h) => h.result === 'selected').length, 0)
  // After the cooldown the selection goes to the first account in the order, as before.
  w.advance(5 * MIN + 1000)
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select claude c2', 'select claude c3'])
  await worker.deactivate()
})

// ---- Review round 9: permission prompts are mid-turn; state per server; the launch hook's save --

test('smart: a session asking for permission (blocked) is in the middle of a turn, so the account for new launches changes', async () => {
  const w = calm({ session: 97, weekly: 40 }, { panes: [{ terminalId: 't1', agent: 'claude', state: 'blocked', sessionId: 's1' }] })
  const worker = await w.mount()
  await w.rotator.tick()
  // The session cannot move while it waits for the answer: only the selection changes.
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  assert.deepEqual(w.typed, [])
  assert.equal(stored(w).history.at(-1)?.result, 'selected')
  await worker.deactivate()

  // Blocked or working, a session is never moved by the idle sweep or by its own status event.
  for (const state of ['blocked', 'working'] as const) {
    const busy = calm({ session: 100, weekly: 40 }, { panes: [{ terminalId: 't1', agent: 'claude', state, sessionId: 's1' }] })
    const bw = await busy.mount()
    await bw.emit('agent.status.changed', { ...statusEvent('t1'), state, mainAgent: { state, stateStartedAt: 1 } } as never)
    busy.advance(20 * MIN)
    await busy.rotator.tick()
    assert.equal(busy.host.callsOf('terminal.close').length, 0, state)
    assert.equal(busy.host.callsOf('agent.resume').length, 0, state)
    assert.deepEqual(busy.typed, [], state)
    await bw.deactivate()
  }
})

type PlacedPane = Pane & { ws: 'w-local' | 'w-remote' }

/** This computer and a paired server (`remote-box`) whose Claude accounts have the same ids
 *  (c1, c2): the same seat keys, but other accounts. */
function twoServers(options: {
  panes: PlacedPane[]
  tails: Record<string, string[]>
  localUsage?: { session: number; weekly: number }
  state?: Partial<RotatorState>
  settings?: Record<string, string | number | boolean>
  /** Called while the CLI lists the accounts of `server` (live: about 3 s). */
  onList?: (server: string | undefined) => Promise<void>
  /** Terminals in the active tab of each workspace. */
  activeTerminals?: string[]
}) {
  let clock = 1_000_000
  let focused: 'w-local' | 'w-remote' = 'w-local'
  let localActive = 'c1'
  let remoteActive = 'c1'
  let next = 2
  const panes = [...options.panes]
  const cliCalls: string[] = []
  const cli: Cli = {
    async listAccounts(server) {
      cliCalls.push(server ? `list@${server}` : 'list')
      await options.onList?.(server)
      if (server !== 'remote-box') {
        return fx.accountList({
          claudeActive: localActive,
          updatedAt: clock,
          inactiveClaude: { [localActive === 'c1' ? 'c2' : 'c1']: { session: 5, weekly: 5 } },
          claudeUsage: localActive === 'c1' ? options.localUsage ?? { session: 15, weekly: 20 } : { session: 5, weekly: 5 }
        })
      }
      return {
        claude: {
          accounts: [
            { id: 'c1', email: 'remote1@example.test' },
            { id: 'c2', email: 'remote2@example.test' }
          ],
          activeAccountId: remoteActive,
          systemDefaultHome: null
        },
        codex: { accounts: [], activeAccountId: null, systemDefault: { hasAuth: false } },
        rateLimits: {
          claude: {
            status: 'ok',
            session: { usedPercent: remoteActive === 'c1' ? 100 : 12, resetsAt: 1_000_000 + 3_600_000 },
            weekly: { usedPercent: 20, resetsAt: 1_000_000 + 30 * 86_400_000 }
          }
        }
      }
    },
    async select(provider, accountId, server) {
      cliCalls.push(server ? `select@${server} ${provider} ${accountId}` : `select ${provider} ${accountId}`)
      if (provider !== 'claude') return
      if (server === 'remote-box') remoteActive = accountId
      else localActive = accountId
    },
    async closeTerminal(id, server) {
      cliCalls.push(server ? `close@${server} ${id}` : `close ${id}`)
    },
    async sendText(id, _text, server) {
      cliCalls.push(server ? `send@${server} ${id}` : `send ${id}`)
    },
    async activeTerminals() {
      return options.activeTerminals ?? []
    },
    async git() {
      return ''
    }
  }
  const host = mockHost({
    settings: options.settings ?? {},
    storage: options.state ? { state: { paused: false, health: {}, paneSeat: {}, seen: {}, apiRetries: {}, modelStep: {}, waiting: [], history: [], ...options.state } as never } : {},
    results: {
      'agents.list': (params?: { workspaceId?: string }) => ({
        agents: panes
          .filter((p) => p.ws === (params?.workspaceId ?? focused))
          .map(({ ws: _ws, ...p }) => ({ title: null, task: null, stateStartedAt: 1, sessionId: null, ...p }))
      }),
      'terminal.read': ({ terminalId }: { terminalId: string }) => ({ lines: options.tails[terminalId] ?? [], truncated: false }),
      'terminal.close': ({ terminalId }: { terminalId: string }) => {
        const i = panes.findIndex((p) => p.terminalId === terminalId)
        if (i >= 0) panes.splice(i, 1)
        return { closed: true }
      },
      'agent.resume': ({ workspaceId, agent, sessionId }: { workspaceId: 'w-local' | 'w-remote'; agent: string; sessionId: string }) => {
        const terminalId = `n${next++}`
        panes.push({ terminalId, agent, state: 'waiting', sessionId, ws: workspaceId })
        return { terminalId, started: true }
      },
      'terminal.sendText': { accepted: true },
      'workspace.list': {
        workspaces: [
          { id: 'w-local', kind: 'worktree', name: 'local-app', projectId: 'p-local', path: '/local/repo', branch: 'main', hostId: 'local' },
          { id: 'w-remote', kind: 'worktree', name: 'remote-app', projectId: 'p-remote', path: '/srv/repo', branch: 'main', hostId: null }
        ],
        truncated: false
      },
      'project.list': {
        projects: [
          { id: 'p-local', name: 'local-app', kind: 'git', hostId: 'local', path: '/local/repo' },
          { id: 'p-remote', name: 'remote-app', kind: 'git', hostId: 'runtime:remote-box', path: '/srv/repo' }
        ],
        truncated: false
      },
      'workspace.readContext': () => ({ workspaceId: focused, branch: 'main', displayName: focused, terminals: [] }),
      'notifications.show': { delivered: true },
      'statusBar.update': { ok: true }
    }
  })
  let rotator!: Rotator
  const mod = {
    default: async (orca: OrcaWorkerApi) => {
      rotator = await activateWith(orca, { cli, now: () => clock, sleep: async () => undefined }, { tick: false })
    }
  }
  return {
    host,
    cliCalls,
    panes,
    get rotator() {
      return rotator
    },
    advance(ms: number) {
      clock += ms
    },
    focus(ws: 'w-local' | 'w-remote') {
      focused = ws
    },
    event(terminalId: string, ws: 'w-local' | 'w-remote') {
      return { workspaceId: ws, paneKey: `pane-${terminalId}`, terminalId, state: 'done' as const, receivedAt: 1, mainAgent: { state: 'done' as const, stateStartedAt: 1 } }
    },
    async mount() {
      const worker = await mountWorker(mod, { host })
      await rotator.accounts(true)
      return worker
    }
  }
}

test('per server: a limit and a switch on a paired server leave this computer’s account, cooldown and switch cooldown alone', async () => {
  const w = twoServers({
    panes: [
      { terminalId: 'tr1', agent: 'claude', state: 'done', sessionId: 'sr1', ws: 'w-remote' },
      { terminalId: 'tl1', agent: 'claude', state: 'working', sessionId: 'sl1', ws: 'w-local' }
    ],
    tails: { tr1: [...fx.CLAUDE_SESSION_LIMIT], tl1: ['⏺ Working on it…'] },
    // This computer's c1 is running Low while a session is in the middle of a turn on it.
    localUsage: { session: 97, weekly: 20 },
    state: { paneSeat: { tr1: 'claude:c1', tl1: 'claude:c1' } }
  })
  const worker = await w.mount()
  // The paired server's c1 hits its limit: its session moves to that server's c2.
  await worker.emit('agent.status.changed', w.event('tr1', 'w-remote'))
  assert.deepEqual(selects(w), ['select@remote-box claude c2'])
  let state = stored(w)
  assert.ok(state.health['remote-box|claude:c1']?.cooldownUntil! > 1_000_000)
  assert.equal(state.health['claude:c1'], undefined)
  assert.equal(state.lastAutoSwitchAt?.['remote-box|claude'], 1_000_000)
  assert.equal(state.lastAutoSwitchAt?.claude, undefined)
  // Orca has no numbers for that server's c2: the probation that follows is that server's too.
  assert.equal(state.probation?.['remote-box|claude']?.key, 'claude:c2')
  assert.equal(state.probation?.claude, undefined)
  // This computer's c1 shows no cooldown in the panel…
  const local = await worker.request('rotator.snapshot', {})
  assert.equal(local.server, undefined)
  assert.equal(local.seats.find((s) => s.key === 'claude:c1')?.cooldownUntil, undefined)
  // …and its selection may change in the same minute: the paired server's switch is not its own.
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select@remote-box claude c2', 'select claude c2'])
  state = stored(w)
  assert.equal(state.lastAutoSwitchAt?.claude, 1_000_000)
  assert.ok(state.leftLow?.['claude:c1'])
  assert.equal(state.leftLow?.['remote-box|claude:c1'], undefined)
  // Within its own cooldown neither server's selection changes again by advice.
  await w.rotator.tick()
  assert.equal(selects(w).length, 2)
  // The paired server's panel shows its own cooldown, and *Clear* clears that one only.
  w.focus('w-remote')
  const remote = await worker.request('rotator.snapshot', { refresh: true })
  assert.equal(remote.server, 'remote-box')
  assert.ok(remote.seats.find((s) => s.key === 'claude:c1')?.cooldownUntil)
  await worker.request('rotator.clearCooldown', { seatKey: 'claude:c1' })
  state = stored(w)
  assert.equal(state.health['remote-box|claude:c1'], undefined)
  assert.ok(state.leftLow?.['claude:c1'])
  await worker.deactivate()
})

test('per server: state stored before the keys carried a server loads as this computer’s, and never applies to a paired server', async () => {
  const w = twoServers({
    panes: [
      { terminalId: 'tr1', agent: 'claude', state: 'done', sessionId: 'sr1', ws: 'w-remote' },
      { terminalId: 'tl1', agent: 'claude', state: 'done', sessionId: 'sl1', ws: 'w-local' }
    ],
    tails: { tr1: [...fx.CLAUDE_SESSION_LIMIT], tl1: [...fx.CLAUDE_SESSION_LIMIT] },
    state: {
      paneSeat: { tr1: 'claude:c1', tl1: 'claude:c1' },
      // As an older version stored them: bare seat keys, a bare provider.
      health: { 'claude:c2': { cooldownUntil: 1_000_000 + 30 * MIN, reason: 'rate_limit: 5-hour limit reached' } },
      lastAutoSwitchAt: { claude: 1_000_000 },
      probation: { claude: { key: 'claude:c3', until: 1_000_000 + 10 * MIN } },
      leftLow: { 'claude:c3': { at: 1_000_000, until: 1_000_000 + 3_600_000 } }
    }
  })
  const worker = await w.mount()
  // On this computer everything is as before: c2 is cooling down, so the limit on c1 goes past it.
  const before = await worker.request('rotator.snapshot', {})
  assert.equal(before.seats.find((s) => s.key === 'claude:c2')?.cooldownUntil, 1_000_000 + 30 * MIN)
  await worker.emit('agent.status.changed', w.event('tl1', 'w-local'))
  assert.deepEqual(selects(w), ['select claude c3'])
  let state = stored(w)
  assert.equal(state.health['claude:c2']?.cooldownUntil, 1_000_000 + 30 * MIN)
  assert.ok(state.health['claude:c1']?.cooldownUntil)
  assert.deepEqual(state.probation?.claude, { key: 'claude:c3', until: 1_000_000 + 10 * MIN })
  assert.ok(state.leftLow?.['claude:c3'])
  // The paired server's c2 is another account: this computer's cooldown does not keep its
  // session from moving there.
  await worker.emit('agent.status.changed', w.event('tr1', 'w-remote'))
  assert.deepEqual(selects(w), ['select claude c3', 'select@remote-box claude c2'])
  state = stored(w)
  assert.ok(state.health['remote-box|claude:c1']?.cooldownUntil)
  assert.equal(state.waiting.length, 0)
  await worker.deactivate()
})

test('per server: a paired server’s "left as Low" mark survives a read of this computer’s accounts, and ends with its window', async () => {
  const w = twoServers({
    panes: [],
    tails: {},
    state: {
      leftLow: {
        'remote-box|claude:c2': { at: 1_000_000, until: 1_000_000 + 60 * MIN, used: 97 },
        // This computer has no such account any more: its mark goes, as before.
        'claude:gone': { at: 1_000_000, until: 1_000_000 + 60 * MIN }
      }
    }
  })
  const worker = await w.mount()
  await w.rotator.accounts(true)
  await w.rotator.tick()
  assert.deepEqual(Object.keys(stored(w).leftLow ?? {}), ['remote-box|claude:c2'])
  // A read of the paired server's own accounts keeps it too while its window lasts…
  w.focus('w-remote')
  w.advance(2 * MIN)
  await w.rotator.tick()
  assert.equal(w.rotator.snapshot().server, 'remote-box')
  assert.deepEqual(Object.keys(stored(w).leftLow ?? {}), ['remote-box|claude:c2'])
  // …and once the window is over, any read drops it.
  w.focus('w-local')
  w.advance(60 * MIN)
  await w.rotator.tick()
  assert.deepEqual(Object.keys(stored(w).leftLow ?? {}), [])
  await worker.deactivate()
})

test('launch hook: a storage failure while noting the new pane’s account is logged, never an unhandled rejection', async () => {
  const logs: string[] = []
  let fail = false
  const rotator = new Rotator({
    host: { call: async (method: string) => (method === 'workspace.readContext' ? { workspaceId: 'w1' } : method === 'workspace.list' ? { workspaces: [{ id: 'w1', hostId: 'local' }] } : {}) },
    cli: {
      listAccounts: async () => fx.accountList(),
      select: async () => undefined,
      closeTerminal: async () => undefined,
      sendText: async () => undefined,
      git: async () => ''
    },
    now: () => 1_000_000,
    sleep: async () => undefined,
    loadState: async () => null,
    saveState: async () => {
      if (fail) throw new Error('storage is full')
    },
    config: async () => DEFAULT_CONFIG,
    log: (message) => logs.push(message),
    notify: async () => undefined,
    publish: () => undefined,
    loadUsage: async () => null,
    saveUsage: async () => undefined,
    readLive: async () => null,
    loadSamples: async () => null,
    saveSamples: async () => undefined
  })
  await rotator.init()
  await rotator.accounts(true)
  fail = true
  rotator.noteLaunch('claude', 't9', 'w1')
  await new Promise((resolve) => setTimeout(resolve, 5))
  // The account is still remembered for this run; only the write failed.
  assert.equal(rotator.state.paneSeat.t9, 'claude:c1')
  assert.deepEqual(logs.filter((l) => /could not save/.test(l)), ['could not save the account of t9: storage is full'])
  rotator.dispose()
})

test('per server: a session in the middle of a turn on a paired server does not count as one on this computer’s account', async () => {
  const w = twoServers({
    panes: [
      { terminalId: 'tr1', agent: 'claude', state: 'working', sessionId: 'sr1', ws: 'w-remote' },
      // This computer's only session is between turns (and not idle for long): it moves itself at
      // its next turn end, so the selection is left alone until then.
      { terminalId: 'tl1', agent: 'claude', state: 'done', sessionId: 'sl1', ws: 'w-local', stateStartedAt: 1_000_000 }
    ],
    tails: { tr1: ['⏺ Working on it…'], tl1: [...fx.CLAUDE_TALKING_ABOUT_LIMITS] },
    localUsage: { session: 97, weekly: 20 },
    state: { paneSeat: { tr1: 'claude:c1', tl1: 'claude:c1' } }
  })
  const worker = await w.mount()
  await w.rotator.tick()
  // No change of selection, so Orca shows no restart prompt for a session that is elsewhere.
  assert.deepEqual(selects(w), [])
  // With a session of this computer's own in the middle of a turn there, it does change.
  w.panes.find((p) => p.terminalId === 'tl1')!.state = 'blocked'
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select claude c2'])
  await worker.deactivate()
})

test('the next-account command (the status-bar click): switch-back does not undo it at the next tick; it waits out the switch cooldown', async () => {
  // "Follow my order" (and the legacy drain) go back to an earlier account that is healthy. The
  // user just left that account by hand: going back half a minute later is a flap, with Orca's
  // restart prompt shown twice.
  for (const settings of [{ chain: 'claude:c1,claude:c2,claude:c3' }, { switch_cooldown_minutes: 5, min_headroom_gap: 11 }] as Record<string, string | number>[]) {
    const label = JSON.stringify(settings)
    const w = world({ panes: [], tails: {}, claudeUsage: { session: 5, weekly: 5 }, settings })
    const worker = await w.mount()
    assert.match(String(await worker.command('rotator.next')), /Claude: new launches use two@example.test/, label)
    assert.deepEqual(selects(w), ['select claude c2'], label)
    for (let i = 0; i < 4; i++) {
      w.advance(30_000)
      await w.rotator.tick()
    }
    assert.deepEqual(selects(w), ['select claude c2'], label)
    assert.deepEqual(notes(w), [], label)
    // After the switch cooldown the mode's own rule applies again, and says why.
    w.advance(4 * MIN)
    await w.rotator.tick()
    assert.deepEqual(selects(w), ['select claude c2', 'select claude c1'], label)
    assert.match(lastNote(w), /one is available again/, label)
    await worker.deactivate()
  }
})

test('after a move: a first message that cannot be typed leaves the move a move, and the new account usable', async () => {
  // The session is resumed on c2, and then neither Orca nor the CLI can type into the new pane.
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET] },
    state: { paneSeat: { t1: 'claude:c1' } },
    refuseHostSend: true,
    failSend: () => true
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('send')), ['send t2'])
  const state = stored(w)
  assert.equal(state.paneSeat.t2, 'claude:c2')
  // The move happened: it is not noted as failed, and the account the session now runs on is not
  // set aside as one that could not be switched to.
  assert.deepEqual(state.history.map((h) => h.result), ['resumed'])
  assert.equal(state.health['claude:c2'], undefined)
  assert.deepEqual(notes(w).filter((n) => /failed/.test(n)), [])
  assert.match(lastNote(w), /first message could not be typed.*left for you to continue/)
  await worker.deactivate()
})

test('model cap: the fallback model is never typed into a turn the user started meanwhile', async () => {
  for (const mode of ['smart', 'custom']) {
    let armed = true
    const drafts: Record<string, string> = {}
    const w = world({
      panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
      tails: { t1: [...fx.CLAUDE_MODEL_CAP] },
      settings: { mode, model_fallback: 'claude=fable,sonnet' },
      drafts
    })
    // The user sends a prompt while Orca is asked for unsent text (live: a CLI process).
    Object.defineProperty(drafts, 't1', {
      get: () => {
        if (armed) w.panes[0]!.state = 'working'
        return undefined
      }
    })
    const worker = await w.mount()
    await worker.emit('agent.status.changed', statusEvent('t1'))
    assert.equal(w.panes[0]!.state, 'working', mode)
    assert.equal(w.typed.length, 0, mode)
    assert.equal(w.cliCalls.filter((c) => c.startsWith('send')).length, 0, mode)
    assert.deepEqual(selects(w), [], mode)
    assert.equal(w.host.callsOf('terminal.close').length, 0, mode)
    // The fallback model is still there for the next time.
    assert.equal(stored(w).modelStep.t1 ?? 0, 0, mode)
    // That turn ends on the same cap: a new event, and the model is switched then.
    armed = false
    w.panes[0]!.state = 'done'
    w.tails.t1 = [...fx.CLAUDE_MODEL_CAP, '❯ go on', ...fx.CLAUDE_MODEL_CAP]
    await worker.emit('agent.status.changed', statusEvent('t1', 'done', 2))
    assert.deepEqual(w.typed.map((t) => t.text), ['/model sonnet', 'Go continue.'], mode)
    await worker.deactivate()
  }
})

test('smart: a short wait never types into a turn the user started while the accounts were read', async () => {
  const usage = { session: 100, weekly: 40, sessionReset: 1_000_000 + 4 * MIN }
  let listings = 0
  let armed = false
  const w = calm(usage, {
    tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET] },
    // The wake has seen the pane between turns and reads the accounts afresh (live: seconds); the
    // tick's own read comes first.
    onListAccounts: async () => {
      if (armed && ++listings === 2) w.panes[0]!.state = 'working'
    }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(stored(w).waiting[0]?.hold, 'short')
  w.advance(4 * MIN + 1000)
  usage.session = 0
  usage.sessionReset = 1_000_000 + 5 * 3_600_000
  armed = true
  await w.rotator.tick()
  assert.equal(listings, 2)
  assert.equal(w.panes[0]!.state, 'working')
  // The user went on there: nothing is typed into that turn, and the wait is over.
  assert.deepEqual(w.typed, [])
  assert.equal(w.cliCalls.filter((c) => c.startsWith('send')).length, 0)
  assert.equal(stored(w).waiting.length, 0)
  assert.equal(stored(w).history.filter((h) => h.result === 'retried').length, 0)
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  await worker.deactivate()
})

test('per server: a choice made by hand goes to the server whose accounts were shown, also when the focus moves on while they are read', async () => {
  // Both servers know an account c2. The user picks c2 of this computer; while the accounts are
  // read (live: seconds) they switch to the project on the paired server.
  for (const how of ['command', 'panel'] as const) {
    let armed = false
    const w = twoServers({
      panes: [
        { terminalId: 'tl1', agent: 'claude', state: 'waiting', sessionId: 'sl1', ws: 'w-local' },
        { terminalId: 'tr1', agent: 'claude', state: 'waiting', sessionId: 'sr1', ws: 'w-remote' }
      ],
      tails: { tl1: ['⏺ Done.'], tr1: ['⏺ Done.'] },
      state: { paneSeat: { tl1: 'claude:c1', tr1: 'claude:c1' } },
      activeTerminals: ['tl1', 'tr1'],
      onList: async (server) => {
        if (!armed || server) return
        armed = false
        w.focus('w-remote')
        await w.rotator.refreshFocus()
      }
    })
    const worker = await w.mount()
    armed = true
    if (how === 'command') await w.rotator.selectSeat('claude:c2')
    else await worker.request('rotator.switchTo', { seatKey: 'claude:c2' })
    assert.equal(w.rotator.server, 'remote-box', how)
    // This computer's c2, and nothing on the paired server: no selection, no pane closed there.
    assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2'], how)
    assert.deepEqual(w.host.callsOf('terminal.close'), [], how)
    assert.ok(w.panes.some((p) => p.terminalId === 'tr1'), how)
    assert.deepEqual(stored(w).history.map((h) => [h.result, h.from, h.to]), [['selected', 'claude:c1', 'claude:c2']], how)
    await worker.deactivate()
  }
})

test('the move command: switch-back does not undo it at the next tick or turn end; it waits out the switch cooldown', async () => {
  // As for the next-account command: the user just moved this session off c1 by hand. Selecting
  // c1 again half a minute later, or taking the session back at its next turn end, is a flap,
  // with Orca's restart prompt shown twice.
  for (const settings of [{ chain: 'claude:c1,claude:c2,claude:c3' }, { switch_cooldown_minutes: 5, min_headroom_gap: 11 }] as Record<string, string | number>[]) {
    const label = JSON.stringify(settings)
    const w = world({
      panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
      tails: { t1: ['⏺ Done.'] },
      claudeUsage: { session: 5, weekly: 5 },
      state: { paneSeat: { t1: 'claude:c1' } },
      settings
    })
    const worker = await w.mount()
    assert.match(String(await worker.command('rotator.swapThisPane')), /claude: moved to two@example.test \(resumed\)/, label)
    assert.deepEqual(selects(w), ['select claude c2'], label)
    assert.equal(stored(w).paneSeat.t2, 'claude:c2', label)
    w.tails.t2 = ['⏺ Done.']
    for (let i = 0; i < 4; i++) {
      w.advance(30_000)
      await w.rotator.tick()
      await worker.emit('agent.status.changed', statusEvent('t2', 'done', 2 + i))
    }
    assert.deepEqual(selects(w), ['select claude c2'], label)
    assert.equal(stored(w).paneSeat.t2, 'claude:c2', label)
    assert.equal(w.host.callsOf('agent.resume').length, 1, label)
    // After the switch cooldown the mode's own rule applies again.
    w.advance(4 * MIN)
    await w.rotator.tick()
    assert.deepEqual(selects(w), ['select claude c2', 'select claude c1'], label)
    await worker.deactivate()
  }
})
