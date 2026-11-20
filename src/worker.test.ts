// End-to-end through the real worker: Orca events in, host calls and CLI calls out.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { Rotator, restartNote, type Cli } from './engine'
import { classify, draftOf } from './adapters'
import * as fx from './fixtures'
import { likeOrca, type SettingsFaults } from './fixtures'
import { activateWith, configFrom, nextTickMs, ticker } from './worker'
import { settingValues, upgradedValues } from './settings'

/** What a setup reads as after the one-time 0.2 upgrade (worker.ts). */
const up = (stored: Record<string, unknown>) => ({ ...settingValues(stored), ...upgradedValues(stored) })
import { DEFAULT_CONFIG, type RotatorState } from './types'

type Pane = { terminalId: string; agent: string; state: 'working' | 'waiting' | 'done' | 'blocked'; sessionId?: string; title?: string; stateStartedAt?: number; unlisted?: boolean }

/** One thing the plugin did to a session or to the selected account, as the fake Orca saw it, with
 *  what held at that very moment: the session's state and input box (`draft` as `orca terminal
 *  read` would report it, `screenDraft` as its screen shows it), whether automatic hand-off was
 *  paused, and whether the service's switch was on. `paste` is text put into the input box
 *  without Enter. The safety tests at the end of this file check every one of them. */
type Act = {
  kind: 'select' | 'close' | 'type' | 'paste' | 'resume' | 'launch'
  terminalId?: string
  agent?: string
  accountId?: string
  sessionId?: string
  text?: string
  state?: Pane['state']
  draft?: string
  screenDraft?: string | null
  paused: boolean
  serviceOn: boolean
}

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
  /** Orca's settings failing to be read or written (fixtures.ts `likeOrca`). */
  settingsFaults?: SettingsFaults
  /** Runs the worker's own clock on these timers (by default it has none: tests call `tick`). */
  timers?: { setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (handle: unknown) => void }
  /** What the plugin's storage holds besides its state. */
  storage?: Record<string, unknown>
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
  /** Every terminal on screen in those tabs (the other panes of a split tab too), when the CLI says. */
  visibleTerminals?: string[]
  /** Terminals of the focused workspace (`workspace.readContext`); read on every call. */
  focusedTerminals?: string[]
  /** Called when the plugin waits (a backoff, a settle delay), with the wait in ms. */
  onSleep?: (ms: number) => void
  /** While it returns true, Orca cannot list agents (`agents.list` fails); it is given the call's
   *  parameters, so a test can fail the listing of one workspace only. */
  agentsListFails?: (params?: { workspaceId?: string }) => boolean
  /** Unsent text Orca reports apart from the screen lines (`orca terminal read` → `draft`), by
   *  terminal; read on every look, so a test can change it. `'!'` makes that read fail, `'?'` makes
   *  it come back without an answer. No entry is Orca answering that the box is empty. */
  drafts?: Record<string, string>
  /** Called while the CLI lists the active terminals (live: a process that takes a moment). */
  onActiveTerminals?: () => Promise<void>
  /** Called while the CLI lists the accounts (live: about 3 s). */
  onListAccounts?: () => Promise<void>
  /** While it returns true, `orca terminal send` fails (live: the pane is gone, or the CLI is). */
  failSend?: () => boolean
  /** While it returns true for a terminal id, `orca terminal switch` fails (e.g. headless server). */
  failFocus?: (terminalId: string) => boolean
  /** Called when `orca terminal switch` runs for a terminal id. */
  onFocus?: (terminalId: string) => Promise<void> | void
  /** Called while git is read for a hand-off summary (live: a process each, up to seconds). */
  onGit?: () => void
  /** What `orca account list` answers, given what it would have answered (read on every list, so
   *  a test can change it): accounts removed, an empty or broken answer, or a throw. */
  accounts?: (list: Record<string, any>) => any
}) {
  // Each world gets its own copy of the lines: tests add to a pane's tail (`w.tails.t1!.push`), and
  // the fixtures are shared. (Until fix round 15 such a push changed `fx.CLAUDE_SESSION_LIMIT`
  // itself, so every later test that used it read a screen whose banner was no longer the latest
  // output, and exercised the threshold path instead of a limit.)
  for (const [terminalId, lines] of Object.entries(options.tails)) options.tails[terminalId] = [...lines]
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
  // The looks that start an `orca` process each, live: the terminal layout, and a pane's input box.
  const lookups: string[] = []
  // Everything done to a session or to the selection, with what held at that moment (see `Act`).
  const acts: Act[] = []
  // What the plugin asked of Orca that the real host API refuses whole for its size (Orca 1.4.263,
  // its own schemas; the test host takes any size): a notification that is then never shown, a
  // first message that is then never sent. The fake Orca refuses them too, and notes them here.
  const refused: string[] = []
  const tooLong = (what: string, text: unknown, max: number) => {
    if (typeof text !== 'string' || text.length <= max) return
    refused.push(`${what}: ${text.length} characters (Orca takes ${max})`)
    throw Object.assign(new Error(`${what} is too long`), { code: 'invalid_params' })
  }
  const act = (kind: Act['kind'], extra: Partial<Act> = {}) => {
    const pane = panes.find((p) => p.terminalId === extra.terminalId)
    const agent = extra.agent ?? pane?.agent
    const service = agent === 'opencode2' ? 'opencode' : agent
    acts.push({
      kind,
      ...(agent ? { agent } : {}),
      ...(pane ? { state: pane.state, ...(pane.sessionId ? { sessionId: pane.sessionId } : {}) } : {}),
      ...(extra.terminalId ? { draft: options.drafts?.[extra.terminalId] ?? '', screenDraft: draftOf(options.tails[extra.terminalId] ?? []) } : {}),
      paused: rotator?.state.paused === true,
      serviceOn: service ? host.data().settings[`service_${service}`] !== false : true,
      ...extra
    })
  }
  const cli: Cli = {
    async listAccounts() {
      cliCalls.push('list')
      await options.onListAccounts?.()
      const result = accountListFor()
      return options.accounts ? options.accounts(result) : result
    },
    async select(provider, accountId) {
      cliCalls.push(`select ${provider} ${accountId}`)
      act('select', { agent: provider, accountId })
      if (options.failSelect?.includes(accountId)) throw new Error(`account ${accountId} needs sign-in`)
      if (provider === 'claude') claudeActive = accountId === 'system' ? null : accountId
      if (provider === 'codex') codexActive = accountId === 'system' ? null : accountId
    },
    async closeTerminal(id) {
      cliCalls.push(`close ${id}`)
      act('close', { terminalId: id })
    },
    async focusTerminal(terminalId) {
      if (options.failFocus?.(terminalId)) throw new Error('orca terminal switch: renderer_unavailable')
      cliCalls.push(`focus ${terminalId}`)
      await options.onFocus?.(terminalId)
    },
    async activeTerminals() {
      lookups.push('terminals')
      await options.onActiveTerminals?.()
      return options.activeTerminals ?? []
    },
    ...(options.visibleTerminals
      ? {
          visibleTerminals: async () => {
            lookups.push('terminals')
            return options.visibleTerminals!
          }
        }
      : {}),
    async draft(terminalId) {
      lookups.push(`draft ${terminalId}`)
      const text = options.drafts?.[terminalId]
      if (text === '!') throw new Error('orca terminal read: runtime_unavailable')
      if (text === '?') return undefined
      return text ?? ''
    },
    async sendText(terminalId, text) {
      cliCalls.push(`send ${terminalId}`)
      if (options.failSend?.()) throw new Error('orca terminal send: terminal_not_found')
      act('type', { terminalId, text })
      typed.push({ terminalId, text })
      deliver(terminalId, text)
    },
    async typeText(terminalId, text) {
      cliCalls.push(`type ${terminalId}`)
      act('paste', { terminalId, text })
      typed.push({ terminalId, text })
    },
    async git(_cwd, args) {
      options.onGit?.()
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
    // The tests of holding for unsent text run with it not put back; `restoreOn` tests turn it on.
    // Engine tests run "Early when away" (the default) with no wait for the user to leave (early
    // moves at once) unless they say otherwise.
    settings: { restore_unsent_text: false, timing: 'early', away_minutes: 0, ...(options.settings ?? {}) },
    // Engine tests that name the 0.2 "manual" setting: its one-time pause has been done.
    storage: { 'migrated-manual': true as never, ...(options.storage as object), ...(options.state ? { state: { paused: false, health: {}, paneSeat: {}, seen: {}, apiRetries: {}, modelStep: {}, waiting: [], history: [], ...options.state } as never } : {}) } as never,
    results: {
      'agents.list': (params?: { workspaceId?: string }) => {
        if (options.agentsListFails?.(params)) throw Object.assign(new Error('selector_not_found'), { code: 'action_failed' })
        // Orca 1.4.263 lists a background pane that was never shown with `terminalId: null`.
        return {
          agents: panes.map(({ unlisted, ...p }) => ({ title: null, task: null, stateStartedAt: 1, sessionId: null, ...p, ...(unlisted ? { terminalId: null } : {}) }))
        }
      },
      'terminal.read': ({ terminalId }: { terminalId: string }) => ({ lines: options.tails[terminalId] ?? [], truncated: false }),
      'terminal.close': ({ terminalId }: { terminalId: string }) => {
        act('close', { terminalId })
        const i = panes.findIndex((p) => p.terminalId === terminalId)
        if (i >= 0) panes.splice(i, 1)
        return { closed: true }
      },
      'agent.resume': ({ agent, sessionId }: { agent: string; sessionId: string }) => {
        const from = Object.keys(options.tails).find((t) => panes.every((p) => p.terminalId !== t) && options.tails[t]?.length)
        act('resume', { agent, sessionId })
        return { terminalId: spawn(agent, sessionId, from), started: true }
      },
      'agent.launch': ({ agent, prompt }: { agent: string; prompt?: string }) => {
        tooLong('agent.launch prompt', prompt, 4096)
        act('launch', { agent })
        return { terminalId: spawn(agent) }
      },
      'terminal.sendText': ({ terminalId, text, enter }: { terminalId: string; text: string; enter?: boolean }) => {
        if (options.refuseHostSend) throw Object.assign(new Error('terminal is outside the active worktree'), { code: 'action_failed' })
        // (Refused, not noted: the plugin then sends it with the CLI, which has no such limit.)
        if (text.length > 4096) throw Object.assign(new Error('text is too long'), { code: 'invalid_params' })
        act(enter === false ? 'paste' : 'type', { terminalId, text })
        typed.push({ terminalId, text })
        deliver(terminalId, text)
        return { accepted: true }
      },
      'workspace.list': { workspaces: [{ id: 'w1', kind: 'worktree', name: 'w1', path: '/repo', branch: 'feat/x', hostId: 'local' }], truncated: false },
      'workspace.readContext': () => ({ workspaceId: 'w1', branch: 'feat/x', displayName: 'w1', terminals: (options.focusedTerminals ?? []).map((id) => ({ id })) }),
      'notifications.show': ({ title, body }: { title: string; body?: string }) => {
        tooLong('notification title', title, 120)
        tooLong('notification body', body, 1000)
        return { delivered: true }
      },
      'statusBar.update': { ok: true }
    }
  })
  let rotator!: Rotator
  let settings!: OrcaWorkerApi['settings']
  const mod = {
    default: async (orca: OrcaWorkerApi) => {
      settings = orca.settings
      rotator = await activateWith(likeOrca(orca, options.settingsFaults),
        {
          cli,
          now: () => clock,
          sleep: async (ms: number) => options.onSleep?.(ms)
        },
        options.timers ? { timers: options.timers } : { tick: false }
      )
    }
  }
  return {
    host,
    tails: options.tails,
    cliCalls,
    typed,
    acts,
    refused,
    lookups,
    panes,
    get rotator() {
      return rotator
    },
    advance(ms: number) {
      clock += ms
    },
    /** A setting changed in Orca's own Settings (not in the panel, which is a sign of the user). */
    async set(key: string, value: string | number | boolean) {
      await settings.set(key, value)
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

test('live (Orca 1.4.263): a background pane listed without its terminal id is found by its session id', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1', unlisted: true }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', { ...statusEvent('t1'), sessionId: 's1' })
  assert.ok(w.cliCalls.includes('select claude c2'), w.cliCalls.join(','))
  assert.deepEqual(w.host.callsOf('agent.resume'), [{ workspaceId: 'w1', agent: 'claude', sessionId: 's1' }])
  // Without a session id in the event there is nothing to tie it to: left alone.
  const blind = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1', unlisted: true }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT }
  })
  const w2 = await blind.mount()
  await w2.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(blind.cliCalls.filter((c) => c.startsWith('select')).length, 0)
  await worker.deactivate()
  await w2.deactivate()
})

test('Claude rate limit: select next account, close, resume, send "Continue."', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1', title: 'fix parser' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.ok(w.cliCalls.includes('select claude c2'), w.cliCalls.join(','))
  assert.deepEqual(w.host.callsOf('terminal.close'), [{ terminalId: 't1' }])
  assert.deepEqual(w.host.callsOf('agent.resume'), [{ workspaceId: 'w1', agent: 'claude', sessionId: 's1' }])
  assert.deepEqual(w.typed, [{ terminalId: 't2', text: 'Continue.' }])
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
  assert.deepEqual(w.typed, [{ terminalId: 't1', text: 'Continue.' }])
  // A repeated event with no new output does nothing.
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 1))
  assert.equal(w.typed.length, 1)
  // The same error printed again after the retry (a new copy): retried again.
  w.tails.t1!.push('❯ Continue.', ...fx.CLAUDE_API_ERROR)
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
  for (const pick of ['smart', 'my-order']) {
    const w = world({
      panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
      tails: { t1: [...fx.CLAUDE_MODEL_CAP, ...DRAFT_BOX] },
      settings: { pick, model_fallback: 'claude=fable,sonnet' }
    })
    const worker = await w.mount()
    await worker.emit('agent.status.changed', statusEvent('t1'))
    // Neither `/model sonnet` nor the first message: both would send the user's text.
    assert.deepEqual(w.typed, [], pick)
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
  assert.deepEqual(w.typed.map((t) => t.text), ['/model sonnet', 'Continue.'])
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
  // The summary is a prompt sent from the new account: it never names the old one (an email).
  assert.match(launches[0]!.prompt, /^You are taking over a coding session that Codex was running in this workspace\./)
  assert.equal(/example\.test/.test(launches[0]!.prompt), false, launches[0]!.prompt)
  const state = w.host.data().storage.state as RotatorState
  assert.equal(state.history.at(-1)?.result, 'handoff')
  assert.equal(state.paneSeat.t2, 'codex:system')
  await worker.deactivate()
})

test('threshold: a finished turn on a busy seat moves on; normal output never triggers', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'waiting', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_TALKING_ABOUT_LIMITS },
    claudeUsage: { session: 100, weekly: 10 },
    // A threshold move needs a target with known room.
    inactiveClaude: { c2: { session: 5, weekly: 5 } }
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
  assert.match(await worker.command('rotator.nextCodex') as string, /Codex: new sessions start on/)
  assert.ok(w.cliCalls.includes('select codex system'), w.cliCalls.join(','))
  assert.ok(worker.posts.some((p) => p.event === 'rotator.changed'))
  // No status bar item: the plugin never touches Orca's status bar.
  assert.equal(w.host.callsOf('statusBar.update').length, 0)
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
  w.tails.t2!.push('❯ Continue.', '⏺ Continuing.', '  ⎿  5-hour limit reached ∙ resets 3pm')
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
  assert.match(w.tails.t2!.join('\n'), /5-hour limit reached[\s\S]*❯ Continue\./)
  await worker.emit('agent.status.changed', statusEvent('t2', 'done', 2))
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2'])
  await worker.deactivate()
})

test('live (Orca 1.4.263): an older banner the redraw briefly shows as newest is not a new limit', async () => {
  const OLD = ['⏺ Running.', '  ⎿  Claude usage limit reached. Your limit will reset at 9pm', '⏺ Noted.']
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: OLD }
  })
  const worker = await w.mount()
  // First limit (the "9pm" banner): moved to c2.
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2'])
  // A second, different limit in the resumed pane: moved on to c3.
  w.tails.t2 = [...(w.tails.t2 ?? []), '❯ Continue.', '⏺ Working.', '  ⎿  5-hour limit reached ∙ resets 3pm']
  await worker.emit('agent.status.changed', statusEvent('t2', 'done', 2))
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2', 'select claude c3'])
  // The next resumed pane is caught mid-redraw: the older "9pm" banner is the newest line yet.
  const t3 = w.panes.at(-1)!.terminalId
  w.tails[t3] = [...OLD]
  await worker.emit('agent.status.changed', statusEvent(t3, 'done', 3))
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2', 'select claude c3'])
  assert.equal(stored(w).waiting.length, 0)
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
  assert.deepEqual(w.typed, [{ terminalId: 't2', text: 'Continue.' }])
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
  w.tails.t1!.push('❯ Continue.', '  ⎿  5-hour limit reached ∙ resets 3pm')
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 2))
  assert.ok(w.cliCalls.includes('select claude c2'), w.cliCalls.join(','))
  const snap = await worker.request('rotator.snapshot', {})
  assert.equal(snap.services.claude, true)
  await assert.rejects(worker.request('rotator.setService', { provider: 'gpt', enabled: true }))
  await worker.deactivate()
})

test('the panel\'s Settings tab reads every setting, changes one (checked and clamped), and refuses anything else', async () => {
  const w = world({ panes: [], tails: {}, settings: { timing: 'at-limit', active_terminal: 'nonsense' } })
  const worker = await w.mount()
  const values = await worker.request('rotator.settings', {})
  assert.equal(values.pick, 'smart')
  assert.equal(values.timing, 'at-limit')
  assert.equal(values.active_terminal, 'ask', 'a value a setting does not take reads as its default')
  assert.equal(values.early_minutes, 10)
  const out = await worker.request('rotator.settings', { key: 'pick', value: 'my-order' })
  assert.equal(out.pick, 'my-order')
  assert.equal(w.host.data().settings.pick, 'my-order')
  assert.equal((await worker.request('rotator.snapshot', {})).mode, 'my-order')
  // Numbers typed in the panel arrive as text, and are kept within range.
  assert.equal((await worker.request('rotator.settings', { key: 'early_minutes', value: '500' })).early_minutes, 120)
  assert.equal((await worker.request('rotator.settings', { key: 'restore_unsent_text', value: false })).restore_unsent_text, false)
  await assert.rejects(worker.request('rotator.settings', { key: 'pick', value: 'yolo' }))
  await assert.rejects(worker.request('rotator.settings', { key: 'early_minutes', value: 'soon' }))
  await assert.rejects(worker.request('rotator.settings', { key: 'chain', value: 'claude:*' }))
  await assert.rejects(worker.request('rotator.settings', { key: 'service_claude', value: false }))
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
  w.tails.t2 = [...fx.CLAUDE_SESSION_LIMIT, '❯ Continue.', '⏺ Continuing.']
  await worker.emit('agent.status.changed', statusEvent('t2', 'done', 2))
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2'])
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  await worker.deactivate()
})

test('review: a handled banner that scrolled out of a full read window counts again', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    redraw: true
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2'])
  // The user goes on in the resumed session; 80 lines later the old banner is out of the read window.
  w.tails.t2 = Array.from({ length: 80 }, (_, i) => `  line ${i}`)
  await worker.emit('agent.status.changed', statusEvent('t2', 'done', 2))
  w.tails.t2 = [...Array.from({ length: 77 }, (_, i) => `  line ${i}`), ...fx.CLAUDE_SESSION_LIMIT.slice(2, 4)]
  await worker.emit('agent.status.changed', statusEvent('t2', 'done', 3))
  // Handled as a new limit.
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

test('review: every account used up does not rotate (and type) forever', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'waiting', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_TALKING_ABOUT_LIMITS },
    claudeUsage: { session: 100, weekly: 10 },
    laterClaudeUsage: { session: 100, weekly: 10 },
    // Orca's (older) numbers for the accounts not in use show room: a threshold move needs that.
    inactiveClaude: { c2: { session: 5, weekly: 5 }, c3: { session: 5, weekly: 5 } },
    redraw: true
  })
  const worker = await w.mount()
  // Each resumed pane ends its turn on an account that is used up too.
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

test('switch back: once the first account resets, new sessions start on it and a pane moves back at turn end', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    settings: { pick: 'my-order', idle_minutes: 0 }
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
  // Only the limit, which interrupted the work, was followed by the first message (in t2). The
  // switch-back moved a session that had finished its turn: it is resumed and left ready, since
  // typing "Continue." there would start work nobody asked for.
  assert.deepEqual(w.typed, [{ terminalId: 't2', text: 'Continue.' }])
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
    // Switch-back belongs to Custom order; Auto (Smart) has no preferred account.
    settings: { pick: 'my-order' }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  w.advance(48 * 3_600_000)
  await w.rotator.tick()
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2', 'select claude c1'])
  assert.equal(w.host.callsOf('agent.resume').length, 2)
  // The first message follows the limit only (t2). The idle pane moved back had finished its
  // turn: it is resumed on c1 and left ready, not told to continue (this asserted the opposite
  // until fix round 15: an idle session was set to work again by a move that was only advice).
  assert.deepEqual(w.typed, [{ terminalId: 't2', text: 'Continue.' }])
  assert.equal((w.host.data().storage.state as RotatorState).paneSeat.t3, 'claude:c1')
  await worker.deactivate()
})

test('switch back is off for Auto, and never closes a pane with unsent text', async () => {
  const auto = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT }
  })
  let worker = await auto.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  auto.advance(48 * 3_600_000)
  await auto.rotator.tick()
  assert.equal(auto.cliCalls.filter((c) => c.startsWith('select')).length, 1)
  await worker.deactivate()

  const draft = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    settings: { pick: 'my-order' }
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
  w.tails.t1!.push('❯ Continue.', '  ⎿  5-hour limit reached ∙ resets 3pm')
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
  // Low at 98 % (not used up), and nothing known about the other accounts: stay.
  const stay = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'waiting', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_TALKING_ABOUT_LIMITS },
    claudeUsage: { session: 98, weekly: 10 }
  })
  let worker = await stay.mount()
  await worker.emit('agent.status.changed', statusEvent('t1', 'waiting'))
  assert.equal(selects(stay).length, 0)
  assert.equal(stay.host.callsOf('terminal.close').length, 0)
  // Nothing happened, so nothing was stored.
  assert.equal(stored(stay)?.waiting.length ?? 0, 0)
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
    laterClaudeUsage: { session: 100, weekly: 10 },
    inactiveClaude
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(w), ['select claude c2'])
  // max(10 min, 2 × the 5-minute selection cooldown).
  assert.deepEqual(stored(w).probation?.claude, { key: 'claude:c2', until: 1_000_000 + 10 * MIN })
  // c2 turns out to be used up, and c3 is now known to have room.
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
    settings: { chain: 'claude:c2, claude:c1, claude:c3', pick: 'my-order', idle_minutes: 0 },
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
    settings: { pick: 'my-order', idle_minutes: 0 }
  })
  const worker = await w.mount()
  // c1 is healthy and first in the chain; the user still wants another account.
  const { message } = await worker.request('rotator.switchTo', { seatKey: 'claude:c2' })
  assert.match(message, /new sessions start on/)
  assert.match(message, /Claude: automatic hand-off is now off, because you chose an account yourself/)
  assert.deepEqual(w.cliCalls.filter((c) => c.startsWith('select')), ['select claude c2'])
  let snap = await worker.request('rotator.snapshot', {})
  assert.equal(snap.services.claude, false)
  assert.equal(snap.history.at(-1)?.reason, 'manual')
  assert.equal(w.host.data().settings.service_claude, false)
  assert.ok(w.host.callsOf('notifications.show').some((c: any) => /automatic hand-off is now off/.test(c.body)))
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
  assert.match(message, /this session was handed off/)
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
  assert.match((await worker.request('rotator.switchTo', { seatKey: 'claude:c2' })).message, /already start on/)
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
  assert.match(message, /this session was handed off/)
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.deepEqual(w.host.callsOf('terminal.close'), [{ terminalId: 't1' }])
  assert.deepEqual(w.host.callsOf('agent.resume'), [{ workspaceId: 'w1', agent: 'claude', sessionId: 's1' }])
  const state = stored(w)
  assert.equal(state.paneSeat.t2, 'claude:c2')
  assert.deepEqual(state.history.at(-1), { ...state.history.at(-1), reason: 'manual', result: 'resumed', from: 'claude:c1', to: 'claude:c2' })
  await worker.deactivate()
})

test('manual switch: the pane in the tab moves as the confirmation says, also when running sessions are otherwise moved only at a limit', async () => {
  // "At limit" is about what the plugin does by itself. Here the user asked, and was told the
  // session moves.
  const cases: Record<string, string | number | boolean>[] = [{}, { timing: 'at-limit' }]
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
    assert.match(message, /this session was handed off/, label)
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
    assert.match(answer.message, /nothing was handed off/, how)
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
  assert.match(message, /new sessions start on two@example\.test; this session was handed off/)
  assert.match(message, /Claude: automatic hand-off is now off, because you chose an account yourself/)
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
  assert.match(third.message, /this session was handed off/)
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
  assert.match(message, /new sessions start on two@example\.test; this session has unsent text in its input box and keeps its account/)
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
    // Said as queued messages, not as text the user typed.
    assert.equal(draft?.queued, true, JSON.stringify(extra))
    assert.equal(w.host.callsOf('terminal.close').length, 0, JSON.stringify(extra))
    await worker.deactivate()
  }
  // Automatic moves: a limit never closes a pane with queued messages; it holds as for typed text.
  // Queued messages also hold when unsent text is put back: they cannot go with the session.
  for (const [text, restore] of [[HINT, false], ['push it', false], [HINT, true], [`  ${HINT}\n`, true]] as const) {
    const w = world({
      settings: { restore_unsent_text: restore },
      panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
      tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET, '╭──────────────╮', '│ >', '╰──────────────╯'] },
      state: { paneSeat: { t1: 'claude:c1' } },
      drafts: { t1: text }
    })
    const worker = await w.mount()
    await worker.emit('agent.status.changed', statusEvent('t1'))
    assert.equal(w.host.callsOf('terminal.close').length, 0, `${text} ${restore}`)
    assert.ok(stored(w).waiting[0]?.draftAt, `${text} ${restore}`)
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
  assert.match(message, /new sessions start on two@example\.test/)
  assert.match(message, /Claude: automatic hand-off is now off, because you chose an account yourself/)
  // The choice stands: nothing selected c1 again.
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.equal(w.host.data().settings.service_claude, false)
  assert.equal(stored(w).history.filter((h) => h.reason === 'switch_back').length, 0)
  w.advance(10 * MIN)
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select claude c2'])
  await worker.deactivate()
})

test('When everything is used up: Stop. A limit with every other account limited says that is the cause', async () => {
  const stop = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    settings: { when_all_used: 'stop' },
    state: { paneSeat: { t1: 'claude:c1' }, health: { 'claude:c2': { cooldownUntil: 1_000_000 + 60 * MIN }, 'claude:c3': { cooldownUntil: 1_000_000 + 60 * MIN } } }
  })
  const sw = await stop.mount()
  await sw.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(lastNote(stop), 'Claude: no other account has room, and When everything is used up is set to Stop. The session stays where it is.')
  assert.equal(stored(stop).history.at(-1)?.why, 'no other Claude account has room, and When everything is used up is set to Stop')
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
  assert.match(String(await worker.command('rotator.swapThisPane')), /handed off to/)
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
    },
    async draft() {
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
        rotator = await activateWith(likeOrca(orca), { cli, now: () => 1_000_000, sleep: async () => undefined }, { tick: false })
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
    },
    async draft() {
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
        rotator = await activateWith(likeOrca(orca), { cli, now: () => 1_000_000, sleep: async () => undefined }, { tick: false })
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
  assert.equal(state.history.at(-1)?.why, 'one hit a usage limit; handed off to two (used 5 % of 5h, 6 % of the week)')
  // The snapshot the panel reads carries it.
  assert.equal(w.rotator.snapshot().history.at(-1)?.why, state.history.at(-1)?.why)
  await worker.deactivate()

  // Used up without a banner yet: the level that caused it is in the line.
  const t = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'waiting', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_TALKING_ABOUT_LIMITS },
    claudeUsage: { session: 100, weekly: 10 },
    inactiveClaude: { c2: { session: 5, weekly: 5 } }
  })
  const tw = await t.mount()
  await tw.emit('agent.status.changed', statusEvent('t1', 'waiting'))
  state = t.host.data().storage.state as RotatorState
  assert.equal(state.history.at(-1)?.reason, 'threshold')
  assert.equal(state.history.at(-1)?.why, 'one is running low (used 100 % of 5h, 10 % of the week); handed off to two (used 5 % of 5h, 5 % of the week)')
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

  // A choice made by hand (only the selection moves).
  const m = world({ panes: [], tails: {}, claudeUsage: { session: 10, weekly: 10 } })
  const mw = await m.mount()
  await m.rotator.selectSeat('claude:c2')
  state = m.host.data().storage.state as RotatorState
  assert.equal(state.history.at(-1)?.why, 'chosen by hand; new sessions start on two')
  await mw.deactivate()
})

test('history: switching back for new launches says which account is available again', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    settings: { pick: 'my-order', idle_minutes: 0 }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  w.advance(48 * 3_600_000)
  await w.rotator.tick()
  const state = w.host.data().storage.state as RotatorState
  assert.equal(state.history.at(-1)?.reason, 'switch_back')
  assert.match(state.history.at(-1)?.why ?? '', /^one is available again.*; new sessions start on it$/)
  await worker.deactivate()
})

// ---- settings: Auto or Custom order, Early when away or At limit ---------------------------------

test('settings: the two basic choices give the engine its behaviour', () => {
  // At limit, chosen.
  const passive = configFrom({ timing: 'at-limit' })
  assert.equal(passive.mode, 'smart')
  assert.equal(passive.horizonMinutes, 0)
  assert.equal(passive.runningSessions, 'limit')
  assert.equal(passive.autoSwapIdleAfterSeconds, 0)
  // The default: Auto, Early when away.
  const smartEarly = configFrom({})
  assert.equal(smartEarly.mode, 'smart')
  assert.equal(smartEarly.strategy, 'smart')
  assert.equal(smartEarly.switchBack, false)
  assert.equal(smartEarly.horizonMinutes, 10)
  assert.equal(smartEarly.lowFiveHour, 97)
  assert.equal(smartEarly.floorFiveHour, 99, 'an account at 99 % is left whatever its pace')
  assert.equal(smartEarly.runningSessions, 'move')
  assert.equal(smartEarly.autoSwapIdleAfterSeconds, 900)
  assert.equal(smartEarly.waitForReset, true)
  assert.equal(smartEarly.activeTerminal, 'ask')
  const ordered = configFrom({ pick: 'my-order', timing: 'at-limit', when_all_used: 'stop' })
  assert.equal(ordered.mode, 'my-order')
  assert.equal(ordered.strategy, 'drain')
  assert.equal(ordered.switchBack, true)
  assert.equal(ordered.horizonMinutes, 0)
  assert.equal(ordered.lowFiveHour, 100)
  assert.equal(ordered.runningSessions, 'limit')
  assert.equal(ordered.autoSwapIdleAfterSeconds, 0)
  assert.equal(ordered.autoSwitchOnThreshold, false)
  assert.equal(ordered.waitForReset, false)
  // Advanced: minutes, the level floor, idle time; out-of-range numbers are clamped.
  const tuned = configFrom({ timing: 'early', early_minutes: 25, early_percent_left: 10, idle_minutes: 0, switch_cooldown_minutes: 999 })
  assert.equal(tuned.horizonMinutes, 25)
  assert.equal(tuned.floorFiveHour, 90)
  assert.equal(tuned.autoSwapIdleAfterSeconds, 0)
  assert.equal(tuned.switchCooldownMinutes, 240)
  // A value a setting does not take is its default.
  assert.equal(configFrom({ pick: 'manual', timing: 7 }).mode, 'smart')
})

test('settings: values an older version stored carry over while the new setting is unset', () => {
  assert.equal(up({ mode: 'my-order' }).pick, 'my-order')
  assert.equal(up({ chain: 'claude:c2, claude:c1' }).pick, 'my-order')
  assert.equal(up({ chain: 'claude:c2', strategy: 'balanced' }).pick, 'smart')
  assert.equal(up({ mode: 'manual' }).pick, 'smart')
  assert.equal(up({ switch_early: 'at-limit' }).timing, 'at-limit')
  assert.equal(up({ running_sessions: 'launches' }).timing, 'at-limit')
  assert.equal(up({ switch_early: 'earlier' }).early_minutes, 25)
  assert.equal(up({ switch_early: 'earlier' }).timing, 'early')
  assert.equal(up({ switch_early: 'just-before' }).timing, 'early', 'the old default lands on the new one')
  assert.equal(up({ auto_swap_idle_after_seconds: 1800 }).idle_minutes, 30)
  // "Only at a limit" for running sessions wins over "earlier"; short idle times round up.
  assert.equal(up({ switch_early: 'earlier', running_sessions: 'limit' }).timing, 'at-limit')
  assert.equal(up({ auto_swap_idle_after_seconds: 20 }).idle_minutes, 1)
  assert.equal(up({ auto_swap_idle_after_seconds: 999_999 }).idle_minutes, 1440)
  // A new value that differs from its default wins. One at its default counts as untouched, since
  // Orca reads every declared setting as its default (the upgrade runs once, at the first start).
  assert.equal(up({ switch_early: 'earlier', early_minutes: 40 }).early_minutes, 40)
  assert.equal(up({ switch_early: 'at-limit', timing: 'early' }).timing, 'at-limit')
  assert.deepEqual(upgradedValues({ pick: 'smart', timing: 'early' }), {}, 'nothing from 0.2: nothing changes')
})

test('settings: every setting the panel shows is in orca-plugin.json, with the same default and choices', async () => {
  const { readFileSync } = await import('node:fs')
  const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url) as never, 'utf8'))
  const listed = new Map<string, any>(manifest.contributes.settings.map((x: any) => [x.key, x]))
  const { ALL_SETTINGS } = await import('./settings')
  for (const spec of ALL_SETTINGS) {
    const entry = listed.get(spec.key)
    assert.ok(entry, `${spec.key} is in the manifest`)
    assert.deepEqual(entry.default, spec.default, spec.key)
    if (spec.kind === 'choice') assert.deepEqual(entry.enum, spec.options.map((o) => o.value), spec.key)
  }
  // Nothing in the manifest the panel leaves out but the services (Accounts tab) and the account order (arrows).
  const shown = new Set(ALL_SETTINGS.map((x) => x.key))
  assert.deepEqual([...listed.keys()].filter((k) => !shown.has(k)).sort(), ['chain', 'service_antigravity', 'service_claude', 'service_codex', 'service_devin', 'service_opencode'])
})

test('the panel is told the mode and when sessions hand off', async () => {
  const smart = world({ panes: [], tails: {} })
  let worker = await smart.mount()
  await smart.rotator.tick()
  assert.equal(smart.rotator.snapshot().mode, 'smart')
  assert.equal(smart.rotator.snapshot().atLimitOnly, undefined)
  assert.equal(smart.rotator.snapshot().order, undefined)
  await worker.deactivate()

  const ordered = world({ panes: [], tails: {}, settings: { pick: 'my-order', timing: 'at-limit', chain: 'claude:c3, claude:c1, claude:elsewhere' } })
  worker = await ordered.mount()
  await ordered.rotator.tick()
  const snap = ordered.rotator.snapshot()
  assert.equal(snap.mode, 'my-order')
  assert.equal(snap.atLimitOnly, true)
  assert.deepEqual(snap.order?.claude?.slice(0, 2), ['claude:c3', 'claude:c1'])
  // The arrows: c1 up, then c3 down again; the order is saved as the account order setting.
  await worker.request('rotator.moveSeat', { seatKey: 'claude:c1', by: -1 })
  assert.match(String(ordered.host.data().settings.chain), /^claude:c1, claude:c3/)
  // An entry for an account this project does not list (another Orca server's) is kept.
  assert.match(String(ordered.host.data().settings.chain), /claude:elsewhere$/)
  await assert.rejects(worker.request('rotator.moveSeat', { seatKey: 'claude:c1', by: 2 }))
  await worker.deactivate()
})

test('model cap, Auto: an account known to have room for that model comes before the fallback model', async () => {
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
  assert.deepEqual(w.typed.map((t) => t.text), ['Continue.'])
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
  assert.deepEqual(full.typed.map((t) => t.text), ['/model sonnet', 'Continue.'])
  await fw.deactivate()
})

test('model cap, Auto: with no known room and no fallback model the next account not known to be full is tried', async () => {
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

test('Auto: a turn that ends on a Low account moves that session, and says why', async () => {
  // No pace is known, so the level decides: 97 % of the 5-hour window.
  const w = calm({ session: 97, weekly: 40 })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.deepEqual(w.host.callsOf('terminal.close').map((c: any) => c.terminalId), ['t1'])
  // The turn had ended and nothing interrupted it: the session is resumed and left ready.
  assert.deepEqual(w.typed, [])
  const state = stored(w)
  assert.equal(state.paneSeat.t2, 'claude:c2')
  assert.equal(state.history.at(-1)?.reason, 'threshold')
  assert.equal(state.history.at(-1)?.why, 'one is nearly at the end of its 5h window (5h 97 %, week 40 %, weekly resets in 24 h); handed off to two (5h 5 %, week 5 %, weekly resets in 24 h)')
  // Not at a limit: the account is not cooled, only set aside until its window ends.
  assert.equal(state.health['claude:c1'], undefined)
  assert.equal(state.leftLow?.['claude:c1']?.until, 1_000_000 + 3_600_000)
  // The notification gives the reason and says Orca's restart prompt needs no action.
  assert.match(lastNote(w), /^Claude: one is nearly at the end of its 5h window/)
  assert.match(lastNote(w), /Orca may now offer to restart your running sessions: you do not need to\. They keep working on the account they are on, and Auto Hand-off hands each one off by itself between turns or when it is idle\./)
  await worker.deactivate()

  // 96 %: not Low, nothing happens.
  const ok = calm({ session: 96, weekly: 40 })
  const okWorker = await ok.mount()
  await okWorker.emit('agent.status.changed', statusEvent('t1'))
  await ok.rotator.tick()
  assert.deepEqual(selects(ok), [])
  await okWorker.deactivate()
})

test('Auto: the pace decides before the level does (fake clock)', async () => {
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
  assert.equal(stored(w).history.at(-1)?.why, 'one had about 8 min left at this pace (5h 92 %, week 40 %, weekly resets in 24 h); handed off to two (5h 5 %, week 5 %, weekly resets in 24 h)')
  await worker.deactivate()

  // "Only at the limit": the same readings never move it.
  const late = { session: 80, weekly: 40 }
  const l = calm(late, { settings: { timing: 'at-limit' } })
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

test('Auto: never in the middle of a turn; only the account for new launches changes, once per cooldown', async () => {
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
  assert.match(state.history.at(-1)?.why ?? '', /^one is nearly at the end of its 5h window .*; new sessions start on two/)
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

test('Auto: a selection-only change needs a session in mid-turn on the selected account', async () => {
  // The only session is between turns (and not idle for long): it will move itself at its next
  // turn end, so the selection is left alone until then.
  const w = calm({ session: 97, weekly: 40 }, { panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1', stateStartedAt: 1_000_000 }] })
  const worker = await w.mount()
  await w.rotator.tick()
  assert.deepEqual(selects(w), [])
  await worker.deactivate()
})

test('Auto: unsent text in the input box blocks the move', async () => {
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
  let restarted = false
  const w = world({
    panes: [
      { terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' },
      { terminalId: 'tB', agent: 'claude', state: 'done', sessionId: 'sB' }
    ],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT, tB: fx.CLAUDE_SESSION_LIMIT },
    state: { paneSeat: { t1: 'claude:c1', tB: 'claude:c1' } },
    // The user starts a turn in tB while t1 moves (once: later sleeps are tB's own move).
    onSleep: () => {
      if (restarted) return
      restarted = true
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

test('Auto: paused, or the service off, does nothing at all', async () => {
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

test('Auto: only the session whose turn ended moves; the others follow at their own turn end', async () => {
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

test('Auto: an account left as Low is not gone back to within its 5-hour window, unless a reading shows it reset', async () => {
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

test('Auto: short wait. An account that resets within 5 minutes is waited for, not left', async () => {
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
  assert.equal(state.history.at(-1)?.why, 'one resets in 4 min; waiting is cheaper than handing off, which re-reads the whole conversation')
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
  assert.deepEqual(w.typed, [{ terminalId: 't1', text: 'Continue.' }])
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
})

test('Auto: short wait when the best target would run out before the source is back', async () => {
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

test('Auto: use it or lose it. An idle session, and new launches, go to weekly quota that would expire', async () => {
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
  assert.equal(state.history[0]?.why, 'two has weekly quota that would expire unused (5h 5 %, week 5 %, weekly resets in 24 h); new sessions start on it')
  assert.equal(state.history[1]?.why, 'idle session; two has weekly quota that would expire unused (5h 5 %, week 5 %, weekly resets in 24 h); handed off there from one')
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

test('Auto: "At limit" leaves a Low session where it is', async () => {
  const w = calm({ session: 98, weekly: 40 }, { settings: { timing: 'at-limit' } })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  w.advance(20 * MIN)
  await w.rotator.tick()
  assert.deepEqual(selects(w), [])
  // A real limit still moves the session.
  w.tails.t1 = [...fx.CLAUDE_SESSION_LIMIT]
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 2))
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  await worker.deactivate()
})

test('Custom order: leaves a Low account early, and switch-back does not return to it within its window', async () => {
  const later = { session: 5, weekly: 5 }
  const inactiveClaude: Record<string, { session: number; weekly: number }> = { c2: { session: 5, weekly: 5 } }
  const w = calm({ session: 97, weekly: 40 }, { laterClaudeUsage: later, inactiveClaude, settings: { chain: 'claude:c1, claude:c2, claude:c3' } })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(w), ['select claude c2'])
  // c1 is first in the order and under 100 %: switch-back alone would return at once.
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

test('Auto: a Low account is left for a target with moderate weekly use (the headroom gap is not halved)', async () => {
  // c1 is at 97 % of its 5-hour window; c2 has used 45 % of its week. Comparing loads would
  // halve 5-hour use (48.5 against 45) and keep the session on c1 until it hits the limit.
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
})

test('Auto: a session is not moved when the fresh reading shows its account is no longer Low', async () => {
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

test('Auto: a short wait never types into a pane that holds unsent text', async () => {
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
  assert.deepEqual(notes(w), ['Claude hit its limit on one. Send or clear the text you were typing and the session hands off to two.'])
  assert.ok(stored(w).waiting[0]?.draftAt)
  // Cleared: the next look carries the move out.
  delete drafts.t1
  w.advance(30_000)
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.deepEqual(w.host.callsOf('terminal.close'), [{ terminalId: 't1' }])
  assert.deepEqual(w.typed, [{ terminalId: 't2', text: 'Continue.' }])
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
      settings: { model_fallback: 'claude=sonnet' },
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

  // Orca cannot say (the read fails): the pane may hold text, since the screen lines leave it
  // out, so it is not closed. (Until fix round 15 the lines alone decided, and the pane moved.)
  const blind = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET, ...EMPTY_BOX] },
    state: { paneSeat: { t1: 'claude:c1' } },
    drafts: { t1: '!' }
  })
  worker = await blind.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(blind), [])
  assert.equal(blind.host.callsOf('terminal.close').length, 0)
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
  assert.deepEqual(notes(w), ['Claude hit its limit on one. Send or clear the text you were typing and the session hands off to two.'])
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
    assert.deepEqual(w.typed, [{ terminalId: 't2', text: 'Continue.' }], by)
    const state = stored(w)
    assert.equal(state.waiting.length, 0, by)
    assert.equal(state.paneSeat.t2, 'claude:c2', by)
    assert.deepEqual([state.history.at(-1)?.reason, state.history.at(-1)?.result], ['rate_limit', 'resumed'], by)
    assert.match(state.history.at(-1)?.why ?? '', /hit a usage limit; handed off to two/, by)
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
  assert.deepEqual(notes(w).slice(before), ['Claude: two is free again. Send or clear the text you were typing and the session hands off to two.'])
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
  assert.match(await w.rotator.swapFocused(), /handed off to/)
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
  assert.match(lastNote(w), /Send or clear the text you were typing and the session hands off to me\./)
  assert.equal(stored(w).waiting[0]?.model, 'fable')
  w.tails.t1 = [...fx.CLAUDE_MODEL_CAP]
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select claude c3'])
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  assert.deepEqual([stored(w).history.at(-1)?.reason, stored(w).history.at(-1)?.result], ['model_cap', 'resumed'])
  assert.match(stored(w).history.at(-1)?.why ?? '', /hit its fable limit; handed off to me/)
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
  assert.deepEqual(limited.typed, [{ terminalId: 't2', text: 'Continue.' }])
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
    settings: { chain: 'claude:c3, claude:c1, claude:c2', pick: 'my-order', idle_minutes: 0 },
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

test('Auto: a session asking for permission (blocked) is in the middle of a turn, so the account for new launches changes', async () => {
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
    },
    async draft() {
      return ''
    }
  }
  const host = mockHost({
    settings: { timing: 'early', away_minutes: 0, ...(options.settings ?? {}) },
    // Engine tests that name the 0.2 "manual" setting: its one-time pause has been done.
    storage: { 'migrated-manual': true as never, ...(options.state ? { state: { paused: false, health: {}, paneSeat: {}, seen: {}, apiRetries: {}, modelStep: {}, waiting: [], history: [], ...options.state } as never } : {}) } as never,
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
      rotator = await activateWith(likeOrca(orca), { cli, now: () => clock, sleep: async () => undefined }, { tick: false })
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
      git: async () => '', draft: async () => ''
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

test('the next-account command: switch-back does not undo it at the next tick; it waits out the switch cooldown', async () => {
  // Custom order goes back to an earlier account that is healthy. The
  // user just left that account by hand: going back half a minute later is a flap, with Orca's
  // restart prompt shown twice.
  for (const settings of [{ chain: 'claude:c1,claude:c2,claude:c3' }, { pick: 'my-order' }] as Record<string, string | number>[]) {
    const label = JSON.stringify(settings)
    const w = world({ panes: [], tails: {}, claudeUsage: { session: 5, weekly: 5 }, settings })
    const worker = await w.mount()
    assert.match(String(await worker.command('rotator.next')), /Claude: new sessions start on two@example.test/, label)
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
  for (const pick of ['smart', 'my-order']) {
    let armed = true
    const drafts: Record<string, string> = {}
    const w = world({
      panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
      tails: { t1: [...fx.CLAUDE_MODEL_CAP] },
      settings: { pick, model_fallback: 'claude=fable,sonnet' },
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
    assert.equal(w.panes[0]!.state, 'working', pick)
    assert.equal(w.typed.length, 0, pick)
    assert.equal(w.cliCalls.filter((c) => c.startsWith('send')).length, 0, pick)
    assert.deepEqual(selects(w), [], pick)
    assert.equal(w.host.callsOf('terminal.close').length, 0, pick)
    // The fallback model is still there for the next time.
    assert.equal(stored(w).modelStep.t1 ?? 0, 0, pick)
    // That turn ends on the same cap: a new event, and the model is switched then.
    armed = false
    w.panes[0]!.state = 'done'
    w.tails.t1 = [...fx.CLAUDE_MODEL_CAP, '❯ go on', ...fx.CLAUDE_MODEL_CAP]
    await worker.emit('agent.status.changed', statusEvent('t1', 'done', 2))
    assert.deepEqual(w.typed.map((t) => t.text), ['/model sonnet', 'Continue.'], pick)
    await worker.deactivate()
  }
})

test('Auto: a short wait never types into a turn the user started while the accounts were read', async () => {
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
  for (const settings of [{ chain: 'claude:c1,claude:c2,claude:c3' }, { pick: 'my-order' }] as Record<string, string | number>[]) {
    const label = JSON.stringify(settings)
    const w = world({
      panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
      tails: { t1: ['⏺ Done.'] },
      claudeUsage: { session: 5, weekly: 5 },
      state: { paneSeat: { t1: 'claude:c1' } },
      settings
    })
    const worker = await w.mount()
    assert.match(String(await worker.command('rotator.swapThisPane')), /Claude: handed off to two@example.test/, label)
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

// ---- Fix round 15: the guards fail closed, advice only where a session can resume, and the
// first message only where work was interrupted ---------------------------------------------------

test('fail closed: when Orca cannot say what the input box holds, a limit does not close the pane; it moves once Orca answers', async () => {
  // `!`: `orca terminal read` errors or times out. `?`: it comes back without a usable answer.
  for (const how of ['!', '?']) {
    const drafts: Record<string, string> = { t1: how }
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
    assert.equal(w.host.callsOf('terminal.close').length, 0, how)
    assert.equal(w.host.callsOf('agent.resume').length, 0, how)
    assert.deepEqual(selects(w), [], how)
    assert.deepEqual(w.typed, [], how)
    // Said once, in plain words, and not as "the text you were typing": nobody knows there is any.
    assert.deepEqual(notes(w), ['Claude hit its limit on one. Orca could not be asked whether the session is between turns with an empty input box, so it was not handed off. It hands off to two once that can be checked.'], how)
    assert.equal(stored(w).history.at(-1)?.detail, 'could not check the session', how)
    assert.ok(stored(w).waiting[0]?.draftAt, how)
    // Orca answers again, and the box is empty: the next look carries the move out.
    delete drafts.t1
    w.advance(30_000)
    await w.rotator.tick()
    assert.deepEqual(selects(w), ['select claude c2'], how)
    assert.deepEqual(w.host.callsOf('terminal.close'), [{ terminalId: 't1' }], how)
    assert.deepEqual(w.typed, [{ terminalId: 't2', text: 'Continue.' }], how)
    await worker.deactivate()
  }
})

test('fail closed: when Orca cannot say what the input box holds, no early or idle move, no retry and no model switch', async () => {
  const drafts: Record<string, string> = { t1: '!' }
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

  for (const tail of [fx.CLAUDE_API_ERROR, fx.CLAUDE_MODEL_CAP]) {
    const w = world({
      panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
      tails: { t1: [...tail, ...EMPTY_BOX] },
      settings: { model_fallback: 'claude=sonnet' },
      state: { paneSeat: { t1: 'claude:c1' } },
      drafts: { t1: '?' }
    })
    worker = await w.mount()
    await worker.emit('agent.status.changed', statusEvent('t1'))
    assert.deepEqual(w.typed, [])
    assert.deepEqual(selects(w), [])
    assert.equal(stored(w).history.at(-1)?.detail, 'could not check the input box')
    assert.match(lastNote(w), /Orca could not be asked whether the session has unsent text/)
    await worker.deactivate()
  }
})

test('fail closed: when Orca cannot list the agents, a limit does not close the pane; it moves once Orca answers', async () => {
  // The listing fails from the moment the accounts are read for the move (live: seconds later).
  let armed = false
  let failing = false
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET, ...EMPTY_BOX] },
    state: { paneSeat: { t1: 'claude:c1' } },
    onListAccounts: async () => {
      if (armed) failing = true
    },
    agentsListFails: () => failing
  })
  const worker = await w.mount()
  armed = true
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  assert.deepEqual(selects(w), [])
  assert.equal(stored(w).waiting.length, 1)
  assert.match(lastNote(w), /Orca could not be asked whether the session is between turns/)
  // Still failing: it keeps waiting, and says nothing more.
  w.advance(30_000)
  await w.rotator.tick()
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(notes(w).length, 1)
  armed = false
  failing = false
  w.advance(30_000)
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.deepEqual(w.host.callsOf('terminal.close'), [{ terminalId: 't1' }])
  assert.equal(stored(w).waiting.length, 0)
  await worker.deactivate()
})

test('fail closed: when Orca cannot list the agents, a move that is advice does not happen', async () => {
  let armed = false
  let failing = false
  const w = calm({ session: 97, weekly: 40 }, {
    onListAccounts: async () => {
      if (armed) failing = true
    },
    agentsListFails: () => failing
  })
  const worker = await w.mount()
  armed = true
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(w), [])
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  await worker.deactivate()
})

test('fail closed: after a move, the first message is not typed into a pane Orca cannot say is safe to type into', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET] },
    state: { paneSeat: { t1: 'claude:c1' } },
    drafts: { t2: '!' }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  assert.deepEqual(w.typed, [])
  assert.equal(stored(w).history.at(-1)?.result, 'resumed')
  assert.match(lastNote(w), /Orca could not be asked whether it is safe to type there.*left for you to continue/)
  await worker.deactivate()
})

test('fail closed: a short wait that is over keeps waiting while Orca cannot say whether typing is safe', async () => {
  const usage = { session: 100, weekly: 40, sessionReset: 1_000_000 + 4 * MIN }
  const drafts: Record<string, string> = {}
  const w = calm(usage, { tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET] }, drafts })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(stored(w).waiting[0]?.hold, 'short')
  w.advance(4 * MIN + 1000)
  usage.session = 0
  usage.sessionReset = 1_000_000 + 5 * 3_600_000
  drafts.t1 = '!'
  await w.rotator.tick()
  assert.deepEqual(w.typed, [])
  assert.equal(stored(w).waiting.length, 1)
  delete drafts.t1
  w.advance(30_000)
  await w.rotator.tick()
  assert.deepEqual(w.typed, [{ terminalId: 't1', text: 'Continue.' }])
  assert.equal(stored(w).waiting.length, 0)
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  await worker.deactivate()
})

test('fail closed, by hand: "Hand off to this account" says it could not check the session, and switches nothing', async () => {
  // Orca cannot say what the input box holds, or cannot list the workspace's agents.
  for (const how of ['draft-error', 'draft-no-answer', 'agents'] as const) {
    const w = idleInTab(how === 'agents' ? { agentsListFails: (params) => !!params?.workspaceId } : { drafts: { t1: how === 'draft-error' ? '!' : '?' } })
    const worker = await w.mount()
    const answer = await worker.request('rotator.switchTo', { seatKey: 'claude:c2' })
    assert.match(answer.message, /^Claude: Orca could not be asked whether this session is between turns with an empty input box, so nothing was handed off/, how)
    assert.equal(answer.draft, undefined, how)
    assert.deepEqual(selects(w), [], how)
    assert.notEqual(w.host.data().settings.service_claude, false, how)
    assert.equal(w.host.callsOf('terminal.close').length, 0, how)
    assert.equal(w.host.callsOf('agent.resume').length, 0, how)
    // Agreeing to lose text changes nothing: there is no text to agree about.
    const again = await worker.request('rotator.switchTo', { seatKey: 'claude:c2', acceptDraft: true, draft: { terminalId: 't1', text: '' } })
    assert.match(again.message, /could not be asked/, how)
    assert.equal(w.host.callsOf('terminal.close').length, 0, how)
    // The command that moves this workspace's agent says the same and moves nothing.
    assert.match(String(await worker.command('rotator.swapThisPane')), /Orca could not be asked whether this session is between turns with an empty input box; it was not handed off/, how)
    assert.equal(w.host.callsOf('terminal.close').length, 0, how)
    assert.deepEqual(selects(w), [], how)
    await worker.deactivate()
  }
})

test('fail closed, by hand: a session that cannot be checked once the account is selected keeps its account, and the answer says so', async () => {
  // The first look is fine; Orca stops answering while the account is being selected.
  const drafts: Record<string, string> = {}
  const w = idleInTab({ drafts })
  const worker = await w.mount()
  const select = w.rotator['deps'].cli.select
  w.rotator['deps'].cli.select = async (provider, accountId, server) => {
    await select(provider, accountId, server)
    drafts.t1 = '!'
  }
  const { message } = await worker.request('rotator.switchTo', { seatKey: 'claude:c2' })
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.match(message, /Orca could not be asked about this session, so it was not handed off and keeps its account/)
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  await worker.deactivate()
})

test('services that cannot resume a session (Codex): a running pane moves only at a real limit, never as advice', async () => {
  // x1 is at 100 %: a finished turn there, and then an idle pane, would be moved as advice.
  const w = world({
    panes: [{ terminalId: 'k1', agent: 'codex', state: 'done', sessionId: 'cs1' }],
    tails: { k1: ['• Updated the parser.', '', '› Ask Codex to do anything', '  gpt-5 default · ~/projects/demo'] },
    state: { paneSeat: { k1: 'codex:x1' } }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('k1'))
  w.advance(20 * MIN)
  await w.rotator.tick()
  // A handoff starts a new session from a summary: that is never done to a session that works.
  assert.equal(w.host.callsOf('agent.launch').length, 0)
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.ok(w.panes.some((p) => p.terminalId === 'k1'))
  // The limit itself: now it is handed off.
  w.tails.k1 = [...fx.CODEX_USAGE_LIMIT]
  await worker.emit('agent.status.changed', statusEvent('k1', 'done', 2))
  assert.equal(w.host.callsOf('agent.launch').length, 1)
  assert.deepEqual(w.host.callsOf('terminal.close'), [{ terminalId: 'k1' }])
  assert.equal(stored(w).history.at(-1)?.result, 'handoff')
  await worker.deactivate()

  // Switch-back (Custom order) leaves a Codex pane on the lower account as well; new launches follow.
  const back = world({
    panes: [{ terminalId: 'k1', agent: 'codex', state: 'done', sessionId: 'cs1' }],
    tails: { k1: ['• Updated the parser.', '', '› Ask Codex to do anything', '  gpt-5 default · ~/projects/demo'] },
    codexUsage: { session: 5, weekly: 5 },
    settings: { pick: 'my-order' },
    state: { paneSeat: { k1: 'codex:system' } }
  })
  const bw = await back.mount()
  await bw.emit('agent.status.changed', statusEvent('k1'))
  back.advance(20 * MIN)
  await back.rotator.tick()
  assert.equal(back.host.callsOf('agent.launch').length, 0)
  assert.equal(back.host.callsOf('terminal.close').length, 0)
  // The note about Orca's restart prompt does not promise Codex what only Claude sessions get.
  assert.match(restartNote(configFrom({}), 'claude'), /They keep working on the account they are on, and Auto Hand-off hands each one off by itself between turns or when it is idle\.$/)
  assert.match(restartNote(configFrom({}), 'codex'), /They keep working on the account they are on\.$/)
  assert.match(restartNote(configFrom({ timing: 'at-limit' }), 'claude'), /They keep working on the account they are on\.$/)
  await bw.deactivate()

  // A Claude pane Orca gives no session id for cannot be resumed either: no early move.
  const anon = calm({ session: 97, weekly: 40 }, { panes: [{ terminalId: 't1', agent: 'claude', state: 'done' }] })
  const aw = await anon.mount()
  await aw.emit('agent.status.changed', statusEvent('t1'))
  anon.advance(20 * MIN)
  await anon.rotator.tick()
  assert.equal(anon.host.callsOf('agent.launch').length, 0)
  assert.equal(anon.host.callsOf('terminal.close').length, 0)
  await aw.deactivate()
})

test('the first message is typed only where work was interrupted: not after an early, idle, expiring-quota or switch-back move, nor a move by hand', async () => {
  // Early (Smart, a turn that ended on a Low account): the session finished; it is resumed and left ready.
  const early = calm({ session: 97, weekly: 40 })
  let worker = await early.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(early.host.callsOf('agent.resume').length, 1)
  assert.equal(stored(early).history.at(-1)?.result, 'resumed')
  assert.deepEqual(early.typed, [])
  await worker.deactivate()

  // Idle (the sweep) on an account that is used up.
  const idle = calm({ session: 100, weekly: 10 })
  worker = await idle.mount()
  idle.advance(20 * MIN)
  await idle.rotator.tick()
  assert.equal(stored(idle).history.at(-1)?.reason, 'idle')
  assert.equal(idle.host.callsOf('agent.resume').length, 1)
  assert.deepEqual(idle.typed, [])
  await worker.deactivate()

  // Expiring quota (Smart, "use it or lose it").
  const lose = calm({ session: 20, weekly: 30, weeklyReset: 1_000_000 + 6 * 86_400_000 })
  worker = await lose.mount()
  await lose.rotator.tick()
  assert.deepEqual(stored(lose).history.map((h) => [h.reason, h.result]), [['expiring', 'selected'], ['expiring', 'resumed']])
  assert.deepEqual(lose.typed, [])
  await worker.deactivate()

  // By hand: the user is there and types what they want.
  const hand = idleInTab()
  worker = await hand.mount()
  assert.match((await worker.request('rotator.switchTo', { seatKey: 'claude:c2' })).message, /this session was handed off/)
  assert.deepEqual(hand.typed, [])
  await worker.deactivate()

  // A limit interrupted the work: the first message is typed, as before.
  const limit = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET] },
    state: { paneSeat: { t1: 'claude:c1' } }
  })
  worker = await limit.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(limit.typed, [{ terminalId: 't2', text: 'Continue.' }])
  await worker.deactivate()
})

/** A Claude pane that shows a limit in a workspace on a direct SSH target. */
function sshWorld(options: { settings?: Record<string, string | number | boolean>; state?: Partial<RotatorState>; /** While true, Orca cannot list the workspaces. */ workspaceListFails?: () => boolean } = {}) {
  const cliCalls: string[] = []
  const cli: Cli = {
    listAccounts: async () => fx.accountList({ claudeUsage: { session: 100, weekly: 40 } }),
    select: async (provider, accountId) => void cliCalls.push(`select ${provider} ${accountId}`),
    closeTerminal: async (id) => void cliCalls.push(`close ${id}`),
    sendText: async (id) => void cliCalls.push(`send ${id}`),
    git: async () => '',
    draft: async () => ''
  }
  const workspaces = { workspaces: [{ id: 'w-ssh', kind: 'worktree', name: 'build-app', projectId: 'p-ssh', path: '/home/me/repo', branch: 'main', hostId: 'ssh:build-box' }], truncated: false }
  const host = mockHost({
    settings: options.settings ?? {},
    // Engine tests that name the 0.2 "manual" setting: its one-time pause has been done.
    storage: { 'migrated-manual': true as never, ...(options.state ? { state: { paused: false, health: {}, paneSeat: {}, seen: {}, apiRetries: {}, modelStep: {}, waiting: [], history: [], ...options.state } as never } : {}) } as never,
    results: {
      'agents.list': { agents: [{ title: null, task: null, stateStartedAt: 1, terminalId: 'ts1', agent: 'claude', state: 'done', sessionId: 'ss1' }] },
      'terminal.read': () => ({ lines: fx.CLAUDE_SESSION_LIMIT, truncated: false }),
      'workspace.list': () => {
        if (options.workspaceListFails?.()) throw Object.assign(new Error('runtime_unavailable'), { code: 'action_failed' })
        return workspaces
      },
      'terminal.close': { closed: true },
      'agent.resume': { terminalId: 'ts2', started: true },
      'terminal.sendText': { accepted: true },
      'workspace.readContext': { workspaceId: 'w-ssh', branch: 'main', displayName: 'build-app', terminals: [] },
      'notifications.show': { delivered: true },
      'statusBar.update': { ok: true }
    }
  })
  const mod = {
    default: async (orca: OrcaWorkerApi) => {
      await activateWith(likeOrca(orca), { cli, now: () => 1_000_000, sleep: async () => undefined }, { tick: false })
    }
  }
  const event = (stamp: number) => ({ workspaceId: 'w-ssh', paneKey: 'pane-ts1', terminalId: 'ts1', state: 'done' as const, receivedAt: stamp, mainAgent: { state: 'done' as const, stateStartedAt: stamp } })
  return { host, event, cliCalls, mount: () => mountWorker(mod, { host }) }
}

test('SSH target: paused, or the service off, a limit there is only noted: no notification and no History line', async () => {
  for (const off of ['paused', 'service'] as const) {
    const w = sshWorld(off === 'paused' ? { state: { paused: true } } : { settings: { service_claude: false } })
    const worker = await w.mount()
    await worker.emit('agent.status.changed', w.event(1))
    assert.equal(w.host.callsOf('notifications.show').length, 0, off)
    const state = w.host.data().storage.state as RotatorState
    assert.deepEqual(state.history, [], off)
    // The banner is noted, so turning hand-off on again does not act on a stale one.
    assert.equal(Object.keys(state.seen).length, 1, off)
    await worker.deactivate()
  }
  // Neither paused nor off: said once, as before.
  const on = sshWorld()
  const worker = await on.mount()
  await worker.emit('agent.status.changed', on.event(1))
  assert.equal(on.host.callsOf('notifications.show').length, 1)
  assert.equal((on.host.data().storage.state as RotatorState).history.length, 1)
  await worker.deactivate()
})

// ---- the terminal you are on ------------------------------------------------------------------

const onTab = (extra: Partial<Parameters<typeof world>[0]> = {}) => {
  const options: Parameters<typeof world>[0] = {
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    activeTerminals: ['t1'],
    focusedTerminals: ['t1'],
    ...extra,
    // These tests are about "Wait, then count down" unless they say otherwise ("Ask me first" is
    // the default, and adds a question on top of it).
    settings: { active_terminal: 'careful', ...(extra.settings ?? {}) }
  }
  return { options, w: world(options) }
}
const bodies = (w: { host: { callsOf(m: string): unknown[] } }) => w.host.callsOf('notifications.show').map((n: any) => String(n.body))

test('the terminal you are on: a limit there waits out a countdown with no sign of you, then hands off', async () => {
  const { w } = onTab()
  const worker = await w.mount()
  // Past the start-up, when the user is taken to be here (5 minutes).
  w.advance(301_000)
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  const held = w.rotator.snapshot().waiting.find((x) => x.terminalId === 't1')
  assert.ok(held?.activeSince !== undefined && held.countdownUntil !== undefined, JSON.stringify(held))
  assert.ok(bodies(w).some((b) => /The session on screen hands off to .* in 60 s unless you are using it\./.test(b)), bodies(w).join(' | '))
  assert.equal(stored(w).history.at(-1)?.result, 'waiting')
  // Not yet: half the countdown.
  w.advance(30_000)
  await w.rotator.tick()
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  // Run out, no sign of the user: it moves, and the wait is over.
  w.advance(31_000)
  await w.rotator.tick()
  assert.deepEqual(w.host.callsOf('agent.resume'), [{ workspaceId: 'w1', agent: 'claude', sessionId: 's1' }])
  assert.deepEqual(w.rotator.snapshot().waiting, [])
  await worker.deactivate()
})

test('the terminal you are on: a sign of you stops the countdown; Hand off now moves it at once', async () => {
  const { w } = onTab()
  const worker = await w.mount()
  // Past the start-up, when the user is taken to be here (5 minutes).
  w.advance(301_000)
  await worker.emit('agent.status.changed', statusEvent('t1'))
  // Using the panel is a sign of the user.
  await worker.request('rotator.clearCooldown', { seatKey: 'claude:c9' })
  w.advance(61_000)
  await w.rotator.tick()
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  const held = w.rotator.snapshot().waiting.find((x) => x.terminalId === 't1')
  assert.ok(held && held.countdownUntil === undefined, JSON.stringify(held))
  assert.ok(bodies(w).some((b) => /The session on screen was not handed off\. It hands off to .* when you switch to another tab or step away/.test(b)), bodies(w).join(' | '))
  await worker.request('rotator.handoffNow', { terminalId: 't1' })
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  assert.deepEqual(w.rotator.snapshot().waiting, [])
  await worker.deactivate()
})

test('the terminal you are on: typing in its input box counts as you being there', async () => {
  const drafts: Record<string, string> = {}
  const { w } = onTab({ drafts, settings: { restore_unsent_text: true } })
  const worker = await w.mount()
  // Past the start-up, when the user is taken to be here (5 minutes).
  w.advance(301_000)
  await worker.emit('agent.status.changed', statusEvent('t1'))
  w.advance(20_000)
  await w.rotator.tick()
  drafts.t1 = 'one more th'
  w.advance(45_000)
  await w.rotator.tick()
  assert.equal(w.host.callsOf('agent.resume').length, 0, 'typing during the countdown keeps it')
  assert.equal(w.rotator.snapshot().waiting[0]?.countdownUntil, undefined)
  await worker.deactivate()
})

test('the terminal you are on, "wait until I leave it": no countdown; it moves once another tab is shown, with one reminder meanwhile', async () => {
  const { options, w } = onTab({ settings: { active_terminal: 'wait' } })
  const worker = await w.mount()
  // Past the start-up, when the user is taken to be here (5 minutes).
  w.advance(301_000)
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.rotator.snapshot().waiting[0]?.countdownUntil, undefined)
  w.advance(11 * 60_000)
  await w.rotator.tick()
  await w.rotator.tick()
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  assert.equal(bodies(w).filter((b) => /has waited 11 min to hand off/.test(b)).length, 1, bodies(w).join(' | '))
  options.activeTerminals = ['t9']
  await w.rotator.tick()
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  await worker.deactivate()
})

test('the terminal you are on, "move at once": moved like any other pane', async () => {
  const { w } = onTab({ settings: { active_terminal: 'now' } })
  const worker = await w.mount()
  // Past the start-up, when the user is taken to be here (5 minutes).
  w.advance(301_000)
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  await worker.deactivate()
})

test('the terminal you are on: never moved early, while a pane in another tab is', async () => {
  const shown = calm({ session: 97, weekly: 40 }, { activeTerminals: ['t1'], focusedTerminals: ['t1'] })
  let worker = await shown.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(shown.host.callsOf('agent.resume').length, 0)
  await worker.deactivate()
  // In the active tab of a workspace that is not the focused one: not shown, moved.
  const elsewhere = calm({ session: 97, weekly: 40 }, { activeTerminals: ['t1'], focusedTerminals: [] })
  worker = await elsewhere.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(elsewhere.host.callsOf('agent.resume').length, 1)
  await worker.deactivate()
})

test('unsent text goes with the session: put back unsent in the new pane, after the first message', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    drafts: { t1: 'fix the parser\nthen run the tests' },
    settings: { restore_unsent_text: true }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  const fresh = w.typed.map((t) => t.terminalId).find((id) => id !== 't1')!
  assert.deepEqual(
    w.typed.filter((t) => t.terminalId === fresh).map((t) => t.text),
    ['Continue.', '\u001b[200~fix the parser\nthen run the tests\u001b[201~']
  )
  assert.ok(bodies(w).some((b) => b.includes('Your unsent text was put back in its input box: “fix the parser')), bodies(w).join(' | '))
  await worker.deactivate()
})

test('unsent text that stands for a pasted image or block keeps the session where it is', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    drafts: { t1: '[Image #1] what is wrong here?' },
    settings: { restore_unsent_text: true }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  assert.ok(w.rotator.snapshot().waiting[0]?.draftAt)
  await worker.deactivate()
})

test('the last look: an input box that changes in the moment before closing keeps the pane, and the move is tried again', async () => {
  const drafts: Record<string, string> = {}
  let typing = true
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    drafts,
    settings: { restore_unsent_text: true },
    onSleep: (ms) => {
      if (ms === 1000 && typing) {
        drafts.t1 = 'wait'
        typing = false
      }
    }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  assert.equal(w.rotator.snapshot().waiting.length, 1)
  await w.rotator.tick()
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  assert.ok(w.typed.some((t) => t.text === '\u001b[200~wait\u001b[201~'))
  await worker.deactivate()
})

// ---- "Early when away": early only once the user has left ---------------------------------------

test("early when away: no early move while you are here; one once you have been away 10 minutes", async () => {
  const w = calm({ session: 97, weekly: 40 }, { settings: { away_minutes: 10 } })
  const worker = await w.mount()
  // Just started: you are taken to be here. A turn that ends on a Low account stays.
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  assert.equal(w.rotator.snapshot().userHere, true)
  // Ten minutes with no sign of you: away. The next turn end moves it.
  w.advance(10 * 60_000 + 1000)
  w.touch('t1')
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 2))
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  assert.equal(w.rotator.snapshot().userHere, undefined)
  await worker.deactivate()
})

test("early when away: a prompt you send counts as you being here; a turn the plugin started does not", async () => {
  // The session is on screen; "Move right away" so that only your presence holds the early move.
  const w = calm({ session: 97, weekly: 40 }, { settings: { away_minutes: 10, active_terminal: 'now' }, activeTerminals: ['t1'], focusedTerminals: ['t1'] })
  const worker = await w.mount()
  // Between turns at the start (you are taken to be here, so it stays).
  await worker.emit('agent.status.changed', statusEvent('t1', 'waiting', 2))
  w.advance(11 * 60_000)
  // You send a prompt: the pane goes from between turns to working.
  await worker.emit('agent.status.changed', { ...statusEvent('t1', 'done', 3), state: 'working' as const, mainAgent: { state: 'working', stateStartedAt: 3 } })
  assert.equal(w.rotator.snapshot().userHere, true)
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 4))
  assert.equal(w.host.callsOf('agent.resume').length, 0, 'held: you were just here')
  await worker.deactivate()
})

test('early when away: a turn that starts in a session not on screen is no sign of you', async () => {
  // t1 is in a tab Orca is not showing: an agent going on by itself there says nothing about you.
  const w = calm({ session: 97, weekly: 40 }, { settings: { away_minutes: 10 }, activeTerminals: ['t9'], focusedTerminals: ['t9'] })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1', 'waiting', 2))
  w.advance(11 * 60_000)
  await worker.emit('agent.status.changed', { ...statusEvent('t1', 'done', 3), state: 'working' as const, mainAgent: { state: 'working', stateStartedAt: 3 } })
  assert.equal(w.rotator.snapshot().userHere, undefined)
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 4))
  assert.equal(w.host.callsOf('agent.resume').length, 1, 'moved early: you are away')
  await worker.deactivate()
})

test("at limit: only a limit moves a session; the panel shows the style chosen", async () => {
  const w = calm({ session: 97, weekly: 40 }, { settings: { timing: 'at-limit' } })
  const worker = await w.mount()
  w.advance(60 * 60_000)
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  assert.equal(w.rotator.snapshot().atLimitOnly, true)
  assert.equal(configFrom({ timing: 'at-limit' }).runningSessions, 'limit')
  await worker.deactivate()
})


test('session on screen, "Ask me first" (the default): the panel asks; Hand off now moves it at once', async () => {
  const { w } = onTab({ settings: { active_terminal: 'ask' } })
  const worker = await w.mount()
  w.advance(301_000)
  await worker.emit('agent.status.changed', statusEvent('t1'))
  const held = w.rotator.snapshot().waiting[0]
  assert.equal(held?.asked, true)
  assert.ok(held?.countdownUntil !== undefined, 'no sign of you: the countdown runs while it asks')
  assert.ok(bodies(w).some((b) => /Hand off the session on screen to .* now\? Open Auto Hand-off and press Hand off now or Not now\. If you do not answer, it hands off in 60 s\./.test(b)), bodies(w).join(' | '))
  await worker.request('rotator.handoffNow', { terminalId: 't1' })
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  await worker.deactivate()
})

test('session on screen, "Ask me first": not answered, it acts like Wait, then count down', async () => {
  const { w } = onTab({ settings: { active_terminal: 'ask' } })
  const worker = await w.mount()
  w.advance(301_000)
  await worker.emit('agent.status.changed', statusEvent('t1'))
  w.advance(61_000)
  await w.rotator.tick()
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  await worker.deactivate()
})

test('session on screen, "Ask me first": Not now stops the countdown; it moves once another tab is shown', async () => {
  const { options, w } = onTab({ settings: { active_terminal: 'ask' } })
  const worker = await w.mount()
  w.advance(301_000)
  await worker.emit('agent.status.changed', statusEvent('t1'))
  await worker.request('rotator.declineHandoff', { terminalId: 't1' })
  const held = w.rotator.snapshot().waiting[0]
  assert.equal(held?.declined, true)
  assert.equal(held?.countdownUntil, undefined)
  w.advance(5 * 60_000)
  await w.rotator.tick()
  assert.equal(w.host.callsOf('agent.resume').length, 0, 'no countdown after Not now')
  options.activeTerminals = ['t9']
  await w.rotator.tick()
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  await worker.deactivate()
})

test('upgrade: an older "manual" setting pauses automatic hand-off once, and says so', async () => {
  const host = mockHost({ settings: { mode: 'manual' }, results: { 'notifications.show': { delivered: true }, 'agents.list': { agents: [] } } })
  const { mountWorker: mount } = await import('orca/testing')
  const worker = await mount({ default: async (orca: OrcaWorkerApi) => { await activateWith(likeOrca(orca), { cli: { async listAccounts() { return {} }, async select() {}, async closeTerminal() {}, async sendText() {}, async git() { return '' }, async draft() { return '' } } as Cli, now: () => 1_000_000, sleep: async () => undefined }, { tick: false }) } }, { host })
  assert.equal((host.data().storage.state as RotatorState | undefined)?.paused, true)
  assert.equal(host.data().storage['migrated-manual'], true)
  assert.ok(host.callsOf('notifications.show').some((n: any) => /kept Auto Hand-off from handing sessions off by itself/.test(String(n.body))))
  await worker.deactivate()
})

test('upgrade: which 0.2 settings count as "not by itself" (paused once), and which leftovers do not', async () => {
  const { wasManual } = await import('./settings')
  assert.equal(wasManual({}), false)
  assert.equal(wasManual({ mode: 'manual' }), true)
  assert.equal(wasManual({ strategy: 'manual' }), true)
  assert.equal(wasManual({ mode: 'custom', strategy: 'manual' }), true)
  // 0.2 ran the Advanced settings as stored (custom): no hand-off at a limit, or none resumed.
  assert.equal(wasManual({ auto_switch_on_rate_limit: false }), true)
  assert.equal(wasManual({ mode: 'custom', auto_resume: false }), true)
  // Smart or My order chosen in 0.2 overrode them: such a user had automatic hand-offs, and keeps them.
  assert.equal(wasManual({ mode: 'smart', strategy: 'manual' }), false)
  assert.equal(wasManual({ mode: 'my-order', auto_switch_on_rate_limit: false }), false)
  assert.equal(wasManual({ mode: 'smart', pick: 'smart' }), false)
})

test('an account card\'s "Never switch to this": added to and removed from the exclude list, and shown on the card', async () => {
  const w = world({ panes: [], tails: {}, settings: { exclude: 'one@example.test' } })
  const worker = await w.mount()
  await w.rotator.tick()
  await worker.request('rotator.setExcluded', { seatKey: 'claude:c2', excluded: true })
  assert.equal(w.host.data().settings.exclude, 'one@example.test, claude:c2')
  await w.rotator.tick()
  assert.equal(w.rotator.snapshot().seats.find((x) => x.key === 'claude:c2')?.excluded, true)
  // Turned off again: every entry naming it goes, its label included.
  await worker.request('rotator.setExcluded', { seatKey: 'claude:c1', excluded: false })
  assert.equal(w.host.data().settings.exclude, 'claude:c2')
  await assert.rejects(worker.request('rotator.setExcluded', { seatKey: 'claude:c1' } as never))
  await worker.deactivate()
})

test('settings: one API retry setting (0 = off); an older "retry off" carries over as 0', () => {
  assert.equal(configFrom(up({})).retryOnApiError, true)
  assert.equal(configFrom(up({ max_api_retries: 0 })).retryOnApiError, false)
  assert.equal(up({ retry_on_api_error: false }).max_api_retries, 0)
  assert.equal(configFrom(up({ retry_on_api_error: false })).retryOnApiError, false)
})

// ---- review fixes (0.3.0) ----------------------------------------------------------------------

test('unsent text is never lost: a hand-off that fails keeps it in full in History, and the notification quotes its start', async () => {
  const text = `fix the parser\n${'and then the tests '.repeat(150)}`.trim()
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    drafts: { t1: text },
    settings: { restore_unsent_text: true }
  })
  const worker = await w.mount()
  // The old pane is closed, then resuming the session fails: the text is no longer in any pane.
  w.host.respond('agent.resume', () => {
    throw Object.assign(new Error('session_not_found'), { code: 'action_failed' })
  })
  await worker.emit('agent.status.changed', statusEvent('t1'))
  const failed = stored(w).history.at(-1)
  assert.equal(failed?.result, 'failed')
  assert.equal(failed?.unsent, text)
  const said = bodies(w).find((b) => /hand-off to .* failed/.test(b)) ?? ''
  assert.match(said, /^Claude: hand-off to two failed: /)
  // (Orca shows no notification over 1000 characters: one that quoted it all would not be shown.)
  assert.ok(said.includes(`Your unsent text is kept in History: “${text.slice(0, 299)}…”`), said.slice(0, 200))
  assert.ok(said.length <= 1000, `${said.length} characters`)
  // The panel's snapshot carries it.
  assert.equal(w.rotator.snapshot().history.at(-1)?.unsent, text)
  await worker.deactivate()
})

test('unsent text is never lost: when the new input box is not free it is kept with the History entry', async () => {
  const drafts: Record<string, string> = { t1: 'fix the parser' }
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    drafts,
    settings: { restore_unsent_text: true, auto_message: '' }
  })
  const worker = await w.mount()
  // The resumed pane (t2) already shows something in its input box: nothing is pasted over it.
  drafts.t2 = 'a suggestion'
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  assert.equal(w.typed.filter((t) => t.text.includes('fix the parser')).length, 0)
  const moved = stored(w).history.at(-1)
  assert.equal(moved?.result, 'resumed')
  assert.equal(moved?.unsent, 'fix the parser')
  assert.ok(bodies(w).some((b) => b.includes('Your unsent text could not be put back; it is kept in History: “fix the parser”')), bodies(w).join(' | '))
  await worker.deactivate()
})

test('the last look comes right before the pane is closed: a turn started while the account was selected keeps the pane', async () => {
  // A limit move: the turn starts during the settle look (after `orca account select`).
  let started = false
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    onSleep: (ms) => {
      if (ms !== 1000 || started) return
      started = true
      w.panes.find((p) => p.terminalId === 't1')!.state = 'working'
    }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(w), ['select claude c2'], 'the look comes after the selection')
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  // The limit move stays pending for the tick.
  assert.equal(stored(w).waiting.length, 1)
  await worker.deactivate()

  // An early (advisory) move: the same, and nothing is left waiting.
  let typing = false
  const drafts: Record<string, string> = {}
  const e = calm({ session: 97, weekly: 40 }, {
    drafts,
    onSleep: (ms) => {
      if (ms !== 1000 || typing) return
      typing = true
      drafts.t1 = 'one more thing'
    }
  })
  const ew = await e.mount()
  await ew.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(e.host.callsOf('terminal.close').length, 0)
  assert.equal(e.host.callsOf('agent.resume').length, 0)
  assert.equal(stored(e).waiting.length, 0)
  await ew.deactivate()
})

test('Hand off now says why it did not hand off: paused, service off, or no account with room', async () => {
  const { w } = onTab({ settings: { active_terminal: 'wait' } })
  const worker = await w.mount()
  w.advance(301_000)
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.rotator.snapshot().waiting.length, 1)
  await worker.request('rotator.pause', { paused: true })
  assert.match((await worker.request('rotator.handoffNow', { terminalId: 't1' })).message ?? '', /paused/)
  await worker.request('rotator.pause', { paused: false })
  await worker.request('rotator.setService', { provider: 'claude', enabled: false })
  assert.match((await worker.request('rotator.handoffNow', { terminalId: 't1' })).message ?? '', /^Claude: automatic hand-off is off/)
  await worker.request('rotator.setService', { provider: 'claude', enabled: true })
  // Every other account is cooling down now.
  w.rotator.state.health['claude:c2'] = { cooldownUntil: 1_000_000 + 10 * 3_600_000 }
  w.rotator.state.health['claude:c3'] = { cooldownUntil: 1_000_000 + 10 * 3_600_000 }
  assert.equal((await worker.request('rotator.handoffNow', { terminalId: 't1' })).message, 'No other Claude account has room.')
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  // From here on it is an ordinary wait for a reset: the panel no longer shows it as held on screen.
  const plain = w.rotator.snapshot().waiting[0]
  assert.ok(plain && plain.activeSince === undefined && plain.asked === undefined && plain.wakeAt > 1_000_000, JSON.stringify(plain))
  // A session that is not waiting.
  assert.match((await worker.request('rotator.handoffNow', { terminalId: 't9' })).message ?? '', /no longer waiting/)
  // When it does hand off, there is nothing to explain.
  delete w.rotator.state.health['claude:c2']
  const done = await worker.request('rotator.handoffNow', { terminalId: 't1' })
  assert.equal(done.message, undefined)
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  await worker.deactivate()
})

test('paused: a waiting session the user goes on with stops waiting, so un-pausing does not hand it off', async () => {
  for (const off of ['paused', 'service'] as const) {
    const w = world({
      panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
      tails: { t1: fx.CLAUDE_SESSION_LIMIT },
      state: { health: { 'claude:c2': { cooldownUntil: 1_000_000 + 10 * MIN }, 'claude:c3': { cooldownUntil: 1_000_000 + 20 * MIN } } }
    })
    const worker = await w.mount()
    await worker.emit('agent.status.changed', statusEvent('t1'))
    assert.equal(stored(w).waiting.length, 1, off)
    if (off === 'paused') await worker.request('rotator.pause', { paused: true })
    else await worker.request('rotator.setService', { provider: 'claude', enabled: false })
    // The user continues in it: a turn ends with no limit as its latest output.
    w.tails.t1!.push('❯ carry on', '⏺ Done.', '  All 12 tests pass.', '  Nothing else is left to do.', '  The branch is ready for review.', '  See the summary above.')
    await worker.emit('agent.status.changed', statusEvent('t1', 'done', 2))
    assert.equal(stored(w).waiting.length, 0, off)
    if (off === 'paused') await worker.request('rotator.pause', { paused: false })
    else await worker.request('rotator.setService', { provider: 'claude', enabled: true })
    // Once the accounts are free again, nothing wakes it: it is no longer waiting. (The tick may
    // still move it as any idle session on a used-up account; that is not the wait.)
    w.advance(30 * MIN)
    await w.rotator.tick()
    assert.equal(stored(w).history.filter((h) => h.reason === 'reset').length, 0, off)
    await worker.deactivate()
  }
})

test('live (Orca 1.4.263): a waiting background pane listed without its terminal id is neither idle nor closed', async () => {
  const waiting = { terminalId: 't1', workspaceId: 'w1', agent: 'claude' as const, sessionId: 's1', fromSeat: 'claude:c1', wakeAt: 1_000_000 - 1000 }
  // Working: the user went on there, so the wait ends (not "closed").
  const busy = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'working', sessionId: 's1', unlisted: true }],
    tails: { t1: ['⏺ Working…'] },
    claudeUsage: { session: 5, weekly: 5 },
    state: { waiting: [waiting] }
  })
  let worker = await busy.mount()
  await busy.rotator.tick()
  assert.equal(busy.host.callsOf('terminal.close').length, 0)
  assert.equal(stored(busy).waiting.length, 0)
  assert.equal(stored(busy).history.some((h) => h.result === 'closed'), false)
  await worker.deactivate()
  // Between turns: it is there, so the wake goes on with it (its own account has room again, so
  // in the pane it is in).
  const idle = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1', unlisted: true }],
    tails: { t1: ['⏺ Done.'] },
    claudeUsage: { session: 5, weekly: 5 },
    state: { waiting: [waiting] }
  })
  worker = await idle.mount()
  await idle.rotator.tick()
  assert.equal(stored(idle).history.some((h) => h.result === 'closed'), false)
  assert.equal(stored(idle).waiting.length, 0)
  assert.deepEqual(idle.typed, [{ terminalId: 't1', text: 'Continue.' }])
  await worker.deactivate()
  // Another account has room, its own does not: it is handed off there.
  const other = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1', unlisted: true }],
    tails: { t1: ['⏺ Done.'] },
    inactiveClaude: { c2: { session: 5, weekly: 5 } },
    state: { waiting: [waiting] }
  })
  worker = await other.mount()
  await other.rotator.tick()
  assert.equal(stored(other).history.some((h) => h.result === 'closed'), false)
  assert.equal(other.host.callsOf('agent.resume').length, 1)
  await worker.deactivate()
})

test('the session on screen: one countdown notice and one "not handed off" notice per hold, however often you come and go', async () => {
  const { w } = onTab()
  const worker = await w.mount()
  w.advance(301_000)
  await worker.emit('agent.status.changed', statusEvent('t1'))
  for (let i = 0; i < 3; i++) {
    // You show up (the countdown stops), then leave again (it starts over).
    await worker.request('rotator.clearCooldown', { seatKey: 'claude:c9' })
    w.advance(20_000)
    await w.rotator.tick()
    w.advance(301_000)
    await w.rotator.tick()
    await worker.request('rotator.clearCooldown', { seatKey: 'claude:c9' })
    await w.rotator.tick()
  }
  assert.equal(bodies(w).filter((b) => /hands off to .* in 60 s/.test(b)).length, 1, bodies(w).join(' | '))
  assert.equal(bodies(w).filter((b) => /was not handed off/.test(b)).length, 1, bodies(w).join(' | '))
  await worker.deactivate()
})

test('a hand-off by hand takes plain unsent text along and puts it back; no question is asked', async () => {
  const w = idleInTab({ drafts: { t1: 'also update the docs' }, settings: { restore_unsent_text: true } })
  const worker = await w.mount()
  const answer = await worker.request('rotator.switchTo', { seatKey: 'claude:c2' })
  assert.equal(answer.draft, undefined)
  assert.match(answer.message, /this session was handed off/)
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  assert.ok(w.typed.some((t) => t.terminalId === 't2' && t.text === '\u001b[200~also update the docs\u001b[201~'), JSON.stringify(w.typed))
  // No first message after a hand-off by hand.
  assert.equal(w.typed.some((t) => t.text === 'Continue.'), false)
  assert.ok(bodies(w).some((b) => b.startsWith('Claude: handed off to two, as you chose.')), bodies(w).join(' | '))
  await worker.deactivate()
})

test('notifications name the service and say times in local clock words', async () => {
  const p = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    state: { health: { 'claude:c2': { cooldownUntil: 1_000_000 + 10 * MIN }, 'claude:c3': { cooldownUntil: 1_000_000 + 20 * MIN } } }
  })
  const worker = await p.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  const { clockWords } = await import('./labels')
  const waited = stored(p).history.at(-1)
  assert.equal(waited?.result, 'waiting')
  assert.match(waited?.detail ?? '', /^until \d{1,2}:\d\d (am|pm)$|^until \w{3} \d{1,2}:\d\d (am|pm)$/)
  assert.ok(!/\d{4}-\d\d-\d\dT/.test(waited?.detail ?? ''), 'no ISO time')
  assert.ok(bodies(p).some((b) => b.startsWith('Claude: every account is used up. The session continues at ') && b.includes(clockWords(1_000_000 + 10 * MIN, 1_000_000))), bodies(p).join(' | '))
  await worker.deactivate()
})

test('settings: "Keep the session on screen waiting" is 5 minutes in the engine’s defaults too', () => {
  assert.equal(DEFAULT_CONFIG.presenceSeconds, 300)
  assert.equal(configFrom({}).presenceSeconds, 300)
})

test('session on screen: an answer given while the hand-off is under way is kept (Not now, Don\u2019t hand off, pausing)', async () => {
  for (const answer of ['rotator.declineHandoff', 'rotator.cancelWaiting', 'rotator.pause'] as const) {
    let worker: Awaited<ReturnType<ReturnType<typeof world>['mount']>> | undefined
    let armed = false
    const { w } = onTab({
      settings: { active_terminal: 'ask' },
      // The last look waits a second between its two reads of the input box: the user answers then.
      onSleep: (ms) => {
        if (!armed || ms !== 1000) return
        armed = false
        return (answer === 'rotator.pause' ? worker!.request(answer, { paused: true }) : worker!.request(answer, { terminalId: 't1' })) as never
      }
    })
    worker = await w.mount()
    w.advance(301_000)
    await worker.emit('agent.status.changed', statusEvent('t1'))
    // The countdown ran out with no sign of the user: the hand-off starts.
    w.advance(61_000)
    armed = true
    await w.rotator.tick()
    assert.equal(armed, false, `${answer}: the hand-off was under way`)
    assert.equal(w.host.callsOf('terminal.close').length, 0, `${answer}: the session is not closed`)
    assert.equal(w.host.callsOf('agent.resume').length, 0, answer)
    const waiting = w.rotator.snapshot().waiting
    if (answer === 'rotator.cancelWaiting') assert.deepEqual(waiting, [])
    else assert.equal(waiting.length, 1, `${answer}: it still waits`)
    // Nor at the next look: the answer stands.
    w.advance(30_000)
    await w.rotator.tick()
    assert.equal(w.host.callsOf('agent.resume').length, 0, `${answer}: not handed off later either`)
    await worker.deactivate()
  }
})

test('a service that starts a new session: text typed while the summary is put together keeps the old session', async () => {
  const drafts: Record<string, string> = {}
  let typing = true
  const w = world({
    panes: [{ terminalId: 't1', agent: 'codex', state: 'done', sessionId: 'cs1', title: 'fix parser' }],
    tails: { t1: fx.CODEX_USAGE_LIMIT },
    drafts,
    // Reading git for the summary takes a moment (live: up to seconds): the user starts typing.
    onGit: () => {
      if (typing) drafts.t1 = 'and one more th'
    }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.host.callsOf('agent.launch').length, 0, 'no new session over text being typed')
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.ok(!w.cliCalls.some((c) => c.startsWith('close')), w.cliCalls.join(','))
  // Still pending: once the text is gone, it is handed off.
  typing = false
  delete drafts.t1
  await w.rotator.tick()
  assert.equal(w.host.callsOf('agent.launch').length, 1)
  await worker.deactivate()
})

test('early when away: running one of the plugin\u2019s commands is a sign of you', async () => {
  const w = calm({ session: 50, weekly: 40 }, { settings: { away_minutes: 10 } })
  const worker = await w.mount()
  w.advance(11 * 60_000)
  await w.rotator.tick()
  assert.equal(w.rotator.snapshot().userHere, undefined)
  await worker.command('rotator.refresh')
  assert.equal(w.rotator.snapshot().userHere, true)
  await worker.deactivate()
})

// ---- review round 2 ---------------------------------------------------------------------------

test('a hold over queued messages is said as that, not as text being typed', async () => {
  const drafts: Record<string, string> = { t1: 'Press up to edit queued messages' }
  const w = world({
    settings: { restore_unsent_text: true },
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET, '╭──────────────╮', '│ >', '╰──────────────╯'] },
    state: { paneSeat: { t1: 'claude:c1' } },
    drafts
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(stored(w).waiting[0]?.queued, true)
  assert.match(lastNote(w), /The session has queued messages, which cannot go along\. Once they are sent or cleared, the session hands off to /)
  assert.ok(!/text you were typing/.test(lastNote(w)), lastNote(w))
  assert.match(stored(w).history.at(-1)?.why ?? '', /once its queued messages are sent or cleared/)
  // Typed text is still said as typed text.
  drafts.t1 = '[Image #1] look at this'
  const typed = world({
    settings: { restore_unsent_text: true },
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET, '╭──────────────╮', '│ >', '╰──────────────╯'] },
    state: { paneSeat: { t1: 'claude:c1' } },
    drafts: { t1: '[Image #1] look at this' }
  })
  const tw = await typed.mount()
  await tw.emit('agent.status.changed', statusEvent('t1'))
  assert.match(lastNote(typed), /Send or clear the text you were typing/)
  assert.equal(stored(typed).waiting[0]?.queued, undefined)
  // The queued messages are gone: the mark goes with the hold, and the session is handed off.
  delete drafts.t1
  await w.rotator.tick()
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  assert.deepEqual(stored(w).waiting, [])
  await worker.deactivate()
  await tw.deactivate()
})

test('model cap: pausing while the session is looked at stops the fallback model from being typed', async () => {
  const drafts: Record<string, string> = {}
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [...fx.CLAUDE_MODEL_CAP] },
    settings: { model_fallback: 'claude=fable,sonnet' },
    drafts
  })
  // The user pauses while Orca is asked for unsent text (live: a CLI process).
  Object.defineProperty(drafts, 't1', {
    get: () => {
      w.rotator.state.paused = true
      return undefined
    }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(w.typed, [])
  assert.equal(w.cliCalls.filter((c) => c.startsWith('send')).length, 0)
  assert.deepEqual(selects(w), [])
  // The fallback model is still there for the next time.
  assert.equal(stored(w).modelStep.t1 ?? 0, 0)
  await worker.deactivate()
})

test('session on screen: Don’t hand off pressed while the last look stops the hand-off ends the wait for good', async () => {
  let worker: Awaited<ReturnType<ReturnType<typeof world>['mount']>> | undefined
  let armed = false
  const drafts: Record<string, string> = {}
  const { w } = onTab({
    settings: { active_terminal: 'ask' },
    drafts,
    // Between the two reads of the input box the user starts typing and presses Don't hand off.
    onSleep: (ms) => {
      if (!armed || ms !== 1000) return
      armed = false
      drafts.t1 = 'wait, one more th'
      return worker!.request('rotator.cancelWaiting', { terminalId: 't1' }) as never
    }
  })
  worker = await w.mount()
  w.advance(301_000)
  await worker.emit('agent.status.changed', statusEvent('t1'))
  w.advance(61_000)
  armed = true
  await w.rotator.tick()
  assert.equal(armed, false, 'the hand-off was under way')
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.deepEqual(w.rotator.snapshot().waiting, [], 'the wait is not started again')
  delete drafts.t1
  w.advance(30_000)
  await w.rotator.tick()
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  await worker.deactivate()
})

test('unsent text shown on screen: what Orca reports is the whole of it, and that is what goes with the session', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    // The screen shows one line of it in the input box.
    tails: { t1: [...fx.CLAUDE_SESSION_LIMIT, '╭──────────────╮', '│ > fix the parser', '╰──────────────╯'] },
    drafts: { t1: 'fix the parser\nthen run the tests' },
    settings: { restore_unsent_text: true }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  assert.ok(w.typed.some((t) => t.text === '\u001b[200~fix the parser\nthen run the tests\u001b[201~'), JSON.stringify(w.typed))
  await worker.deactivate()
  // Orca cannot be asked: the text on screen still counts as unsent text (and is what is known).
  const blind = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: [...fx.CLAUDE_SESSION_LIMIT, '╭──────────────╮', '│ > fix the parser', '╰──────────────╯'] },
    drafts: { t1: '!' },
    settings: { restore_unsent_text: false }
  })
  const bw = await blind.mount()
  await bw.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(blind.host.callsOf('terminal.close').length, 0)
  assert.ok(stored(blind).waiting[0]?.draftAt)
  assert.equal(stored(blind).waiting[0]?.unchecked, undefined)
  await bw.deactivate()
})

test('panel requests: a value that is no yes or no changes nothing; the arrows and Skip show at once', async () => {
  const w = world({ panes: [], tails: {}, settings: { pick: 'my-order', chain: 'claude:c3, claude:c1' } })
  const worker = await w.mount()
  await w.rotator.tick()
  // Paused stays paused when a request names no state.
  await worker.request('rotator.pause', { paused: true })
  await assert.rejects(worker.request('rotator.pause', {} as never))
  await assert.rejects(worker.request('rotator.pause', { paused: 'no' } as never))
  assert.equal(w.rotator.state.paused, true)
  await worker.request('rotator.pause', { paused: false })
  // A service's switch takes true or false only (anything else would be stored and read as on).
  await worker.request('rotator.setService', { provider: 'claude', enabled: false })
  await assert.rejects(worker.request('rotator.setService', { provider: 'claude', enabled: 'off' } as never))
  await assert.rejects(worker.request('rotator.setService', { provider: 'claude' } as never))
  assert.equal(w.host.data().settings.service_claude, false)
  assert.equal(w.rotator.services.claude, false)
  await assert.rejects(worker.request('rotator.cancelWaiting', {} as never))
  await assert.rejects(worker.request('rotator.clearCooldown', {} as never))
  await assert.rejects(worker.request('rotator.switchTo', {} as never))
  // The answer to an arrow or Skip already has the new order and the switch (no tick in between).
  assert.deepEqual(w.rotator.snapshot().order?.claude?.slice(0, 2), ['claude:c3', 'claude:c1'])
  await worker.request('rotator.moveSeat', { seatKey: 'claude:c1', by: -1 })
  assert.deepEqual(w.rotator.snapshot().order?.claude?.slice(0, 2), ['claude:c1', 'claude:c3'])
  await worker.request('rotator.setExcluded', { seatKey: 'claude:c2', excluded: true })
  assert.equal(w.rotator.snapshot().seats.find((x) => x.key === 'claude:c2')?.excluded, true)
  await worker.deactivate()
})

test('what is kept in memory per session goes once Orca no longer lists the session', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }, { terminalId: 't9', agent: 'claude', state: 'done', sessionId: 's9' }],
    tails: { t1: ['⏺ Done.'], t9: ['⏺ Done.'] },
    claudeUsage: { session: 5, weekly: 5 }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  await worker.emit('agent.status.changed', statusEvent('t9'))
  const states = (w.rotator as unknown as { paneStates: Map<string, string> }).paneStates
  assert.deepEqual([...states.keys()].sort(), ['t1', 't9'])
  // t9 is closed; the next look at the panes (at most every 10 minutes) drops it.
  w.panes.splice(1, 1)
  w.advance(11 * 60_000)
  await w.rotator.tick()
  assert.deepEqual([...states.keys()], ['t1'])
  await worker.deactivate()
})

// ---- fix round 3 (0.3.0) --------------------------------------------------------------------------

test('Skip: a session Orca started before the plugin is not handed off to the account in use when that account is one to Skip', async () => {
  const w = world({
    panes: [{ terminalId: 'old', agent: 'claude', state: 'done', sessionId: 's9' }],
    tails: { old: fx.CLAUDE_SESSION_LIMIT },
    // The account in use (c1) has plenty of room, so the limited session runs on some other one.
    claudeUsage: { session: 7, weekly: 18 },
    settings: { exclude: 'claude:c1' }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('old'))
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.equal(stored(w).paneSeat.t2, 'claude:c2')
  await worker.deactivate()
})

test('When everything is used up: Stop. A session held on screen whose account to go to fills up meanwhile does not start waiting for a reset', async () => {
  const { w } = onTab({ settings: { active_terminal: 'wait', when_all_used: 'stop' } })
  const worker = await w.mount()
  w.advance(301_000)
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.rotator.snapshot().waiting.length, 1)
  // Every other account is limited by the time the user says to hand off.
  w.rotator.state.health['claude:c2'] = { cooldownUntil: 1_000_000 + 10 * 3_600_000 }
  w.rotator.state.health['claude:c3'] = { cooldownUntil: 1_000_000 + 10 * 3_600_000 }
  assert.equal((await worker.request('rotator.handoffNow', { terminalId: 't1' })).message, 'No other Claude account has room.')
  assert.deepEqual(w.rotator.snapshot().waiting, [])
  assert.equal(lastNote(w), 'Claude: no other account has room, and When everything is used up is set to Stop. The session stays where it is.')
  assert.equal(stored(w).history.at(-1)?.result, 'failed')
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  await worker.deactivate()
})

test('a hand-off at a limit that fails before the session is closed tries the next account at the next tick', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    failSelect: ['c2']
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(stored(w).history.at(-1)?.result, 'failed')
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(w.rotator.snapshot().waiting[0]?.failures, 1)
  assert.equal(lastNote(w), 'Claude: hand-off to two failed: account c2 needs sign-in. The session was not closed; another account is tried next.')
  w.advance(30_000)
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select claude c2', 'select claude c3'])
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  assert.deepEqual(w.typed, [{ terminalId: 't2', text: 'Continue.' }])
  assert.deepEqual(w.rotator.snapshot().waiting, [])
  await worker.deactivate()
})

test('hand-offs that keep failing are not tried forever: the third failure ends the wait', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    failSelect: ['c2', 'c3']
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  w.advance(30_000)
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select claude c2', 'select claude c3'])
  assert.equal(w.rotator.snapshot().waiting[0]?.failures, 2)
  // Both are set aside for ten minutes: the session waits for the first of them.
  w.advance(30_000)
  await w.rotator.tick()
  assert.equal(selects(w).length, 2)
  w.advance(11 * MIN)
  await w.rotator.tick()
  assert.equal(selects(w).length, 3)
  assert.deepEqual(w.rotator.snapshot().waiting, [])
  assert.ok(!/another account is tried next/.test(lastNote(w)), lastNote(w))
  w.advance(11 * MIN)
  await w.rotator.tick()
  assert.equal(selects(w).length, 3)
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  await worker.deactivate()
})

test('Skip: a waiting session whose own account is one to Skip continues on it once it has room again', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_LIMIT_NO_RESET },
    settings: { exclude: 'claude:c1' },
    state: { paneSeat: { t1: 'claude:c1' }, health: { 'claude:c2': { cooldownUntil: 1_000_000 + 10 * 3_600_000 }, 'claude:c3': { cooldownUntil: 1_000_000 + 10 * 3_600_000 } } }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  // Every other account is limited: it waits, for its own account's reset (an hour away).
  assert.equal(w.rotator.snapshot().waiting[0]?.wakeAt, 1_000_000 + 3_600_000)
  w.advance(61 * MIN)
  await w.rotator.tick()
  // Nothing is closed and no account is chosen: the session goes on where it is.
  assert.deepEqual(w.typed, [{ terminalId: 't1', text: 'Continue.' }])
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.deepEqual(selects(w), [])
  assert.deepEqual(w.rotator.snapshot().waiting, [])
  assert.match(lastNote(w), /^Claude: one has reset; the session continues there\.$/)
  await worker.deactivate()
})

test('session on screen: the tick comes when a countdown runs out, not up to a tick later', async () => {
  const { w } = onTab()
  const worker = await w.mount()
  assert.equal(w.rotator.countdownDueIn(), undefined)
  w.advance(301_000)
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.rotator.countdownDueIn(), 60_000)
  w.advance(45_000)
  assert.equal(w.rotator.countdownDueIn(), 15_000)
  assert.equal(nextTickMs(30_000, w.rotator.countdownDueIn()), 15_250)
  // Paused, nothing counts down; one that has run out is the ordinary tick's.
  await w.rotator.setPaused(true)
  assert.equal(w.rotator.countdownDueIn(), undefined)
  await w.rotator.setPaused(false)
  w.advance(20_000)
  assert.equal(w.rotator.countdownDueIn(), undefined)
  assert.equal(nextTickMs(30_000, undefined), 30_000)
  assert.equal(nextTickMs(30_000, 60_000), 30_000)
  assert.equal(nextTickMs(30_000, 0), 1000)
  await worker.deactivate()
})

test('session on screen: the other pane of a split tab is on screen too, and is held like the one with the cursor', async () => {
  // t9 has the cursor; t1 is the pane beside it in the same tab.
  const { w } = onTab({ activeTerminals: ['t9'], visibleTerminals: ['t9', 't1'], focusedTerminals: ['t1', 't9'] })
  const worker = await w.mount()
  w.advance(301_000)
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.ok(w.rotator.snapshot().waiting[0]?.activeSince !== undefined, JSON.stringify(w.rotator.snapshot().waiting))
  await worker.deactivate()
})

// ---- Fix round 4 (0.3.0) ------------------------------------------------------------------------

test('unsent text: a Codex session that waits for it says so once, also with Put unsent text back on', async () => {
  // Plain text goes along only with a session that resumes as itself. A Codex session starts
  // anew, so it waits: one notice and one History line, however many ticks look at it again.
  const w = world({
    panes: [{ terminalId: 'k1', agent: 'codex', state: 'done', sessionId: 'cs1' }],
    tails: { k1: [...fx.CODEX_USAGE_LIMIT, '', '› and bump the version', '  gpt-5 default · ~/projects/demo'] },
    settings: { restore_unsent_text: true }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('k1'))
  for (let i = 0; i < 3; i++) {
    w.advance(30_000)
    await w.rotator.tick()
  }
  await worker.emit('agent.status.changed', statusEvent('k1'))
  assert.equal(w.host.callsOf('agent.launch').length, 0)
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(notes(w).filter((n) => /Send or clear/.test(n)).length, 1, notes(w).join('\n'))
  assert.equal(stored(w).history.filter((h) => h.result === 'waiting').length, 1)
  assert.ok(stored(w).waiting[0]?.draftAt !== undefined)
  // Once the text is gone the session is handed off.
  w.tails.k1 = [...fx.CODEX_USAGE_LIMIT, '', '› Ask Codex to do anything', '  gpt-5 default · ~/projects/demo']
  w.advance(30_000)
  await w.rotator.tick()
  assert.equal(w.host.callsOf('agent.launch').length, 1)
  await worker.deactivate()
})

test('Codex hand-off after a wait: the summary names the limit and never repeats its banner as a line of its own', async () => {
  // Held as the session on screen, the hand-off comes from the tick, which has no banner in hand.
  const w = world({
    panes: [{ terminalId: 'k1', agent: 'codex', state: 'done', sessionId: 'cs1' }],
    tails: { k1: fx.CODEX_USAGE_LIMIT },
    settings: { active_terminal: 'wait' },
    activeTerminals: ['k1'],
    focusedTerminals: ['k1']
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('k1'))
  assert.equal(w.host.callsOf('agent.launch').length, 0)
  assert.equal(await w.rotator.handoffNow('k1'), undefined)
  const prompt = (w.host.callsOf('agent.launch') as { prompt: string }[])[0]!.prompt
  assert.match(prompt, /It stopped because: ■ You've hit your usage limit/)
  // No line of the summary is a limit banner: echoed in the new session it must not read as a limit there.
  for (const line of prompt.split('\n')) assert.equal(classifyLine('codex', line), null, line)
  await worker.deactivate()
})

test('a waiting session that goes on where it is: a first message that cannot be typed is said, and the tick goes on', async () => {
  const usage = { session: 100, weekly: 40, sessionReset: 1_000_000 + 4 * MIN }
  let fail = false
  const w = calm(usage, { tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET] }, refuseHostSend: true, failSend: () => fail })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(stored(w).waiting[0]?.hold, 'short')
  w.advance(4 * MIN + 1000)
  usage.session = 0
  usage.sessionReset = 1_000_000 + 5 * 3_600_000
  fail = true
  await w.rotator.tick()
  assert.deepEqual(w.typed, [])
  assert.match(lastNote(w), /has reset\. The first message could not be typed, so the session is left for you to continue\.$/)
  assert.equal(stored(w).waiting.length, 0)
  assert.notEqual(stored(w).history.at(-1)?.result, 'retried')
  await worker.deactivate()
})

test('pause stops a waiting session from going on where it is, also when it comes while the accounts are read', async () => {
  const usage = { session: 100, weekly: 40, sessionReset: 1_000_000 + 4 * MIN }
  // The tick reads the accounts first; the look at the waiting session reads them again, afresh.
  let pauseNow = false
  let reads = 0
  let w!: ReturnType<typeof calm>
  w = calm(usage, {
    tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET] },
    onListAccounts: async () => {
      if (pauseNow && ++reads === 2) await w.rotator.setPaused(true)
    }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(stored(w).waiting[0]?.hold, 'short')
  w.advance(4 * MIN + 1000)
  usage.session = 0
  usage.sessionReset = 1_000_000 + 5 * 3_600_000
  pauseNow = true
  await w.rotator.tick()
  assert.equal(reads, 2)
  assert.equal(w.rotator.state.paused, true)
  assert.deepEqual(w.typed, [])
  assert.equal(stored(w).waiting.length, 1)
  // Un-paused, it goes on at the next tick.
  pauseNow = false
  await w.rotator.setPaused(false)
  w.advance(30_000)
  await w.rotator.tick()
  assert.deepEqual(w.typed, [{ terminalId: 't1', text: 'Continue.' }])
  await worker.deactivate()
})

function classifyLine(provider: 'codex' | 'claude', line: string) {
  return classify(provider, [line], 0)
}

/** A clock with timers a test fires by hand. */
function fakeClock(options: { run: () => Promise<void>; due?: () => number | undefined }) {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
  const logs: string[] = []
  const clock = ticker({
    period: async () => 30_000,
    due: () => options.due?.(),
    run: options.run,
    log: (m) => logs.push(m),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false }
      timers.push(t)
      return t
    },
    clearTimer: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    }
  })
  const pending = () => timers.filter((t) => !t.cleared)
  return {
    clock,
    logs,
    pending,
    /** Fires the one timer that is set. */
    fire() {
      const [t] = pending()
      assert.ok(t, 'no timer is set')
      t.cleared = true
      t.fn()
    },
    settle: async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve()
    }
  }
}

test('the tick clock: one timer at a time, and it goes on after a tick that fails', async () => {
  let runs = 0
  const c = fakeClock({
    run: async () => {
      if (++runs === 1) throw new Error('boom')
    }
  })
  await c.clock.schedule()
  await c.clock.schedule()
  assert.deepEqual(c.pending().map((t) => t.ms), [30_000])
  c.fire()
  await c.settle()
  assert.equal(runs, 1)
  assert.deepEqual(c.logs, ['tick failed: boom'])
  assert.deepEqual(c.pending().map((t) => t.ms), [30_000])
  c.fire()
  await c.settle()
  assert.equal(runs, 2)
  assert.equal(c.pending().length, 1)
  c.clock.stop()
})

test('the tick clock: a countdown that runs out sooner sets the tick to then', async () => {
  let due: number | undefined = 12_000
  const c = fakeClock({ run: async () => undefined, due: () => due })
  await c.clock.schedule()
  assert.deepEqual(c.pending().map((t) => t.ms), [12_250])
  due = undefined
  c.fire()
  await c.settle()
  assert.deepEqual(c.pending().map((t) => t.ms), [30_000])
  c.clock.stop()
})

test('the tick clock: two ticks never run at once; one that comes due while another runs waits for it', async () => {
  let runningNow = 0
  let most = 0
  let runs = 0
  const releases: (() => void)[] = []
  const c = fakeClock({
    run: async () => {
      runs++
      most = Math.max(most, ++runningNow)
      await new Promise<void>((resolve) => releases.push(resolve))
      runningNow--
    }
  })
  await c.clock.schedule()
  c.fire()
  await c.settle()
  assert.equal(runs, 1)
  // While that tick runs (a hand-off takes a while), the tick is set afresh twice (a setting
  // changed, a countdown began) and comes due each time.
  await c.clock.schedule()
  c.fire()
  await c.clock.schedule()
  c.fire()
  await c.settle()
  assert.equal(runs, 1)
  releases.shift()!()
  await c.settle()
  // The two that came due meanwhile are one run, after the first.
  assert.equal(runs, 2)
  assert.equal(most, 1)
  releases.shift()!()
  await c.settle()
  assert.equal(runs, 2)
  assert.equal(c.pending().length, 1)
  c.clock.stop()
})

test('the tick clock: stopped (the worker is deactivated), no timer is left and a tick under way sets none', async () => {
  let release!: () => void
  let runs = 0
  const c = fakeClock({
    run: async () => {
      runs++
      await new Promise<void>((resolve) => (release = resolve))
    }
  })
  await c.clock.schedule()
  c.fire()
  await c.settle()
  const setting = c.clock.schedule()
  c.clock.stop()
  await setting
  release()
  await c.settle()
  assert.equal(c.pending().length, 0)
  await c.clock.schedule()
  await c.clock.now()
  assert.equal(c.pending().length, 0)
  assert.equal(runs, 1)
})

test('Skip and the account order: two quick presses both count', async () => {
  const w = world({ panes: [], tails: {}, settings: { pick: 'my-order' } })
  const worker = await w.mount()
  await Promise.all([
    worker.request('rotator.setExcluded', { seatKey: 'claude:c2', excluded: true }),
    worker.request('rotator.setExcluded', { seatKey: 'claude:c3', excluded: true })
  ])
  assert.equal(w.host.data().settings.exclude, 'claude:c2, claude:c3')
  const before = w.rotator.snapshot().order!.claude!
  // The last account moved up twice ends two places higher, not one.
  const last = before.at(-1)!
  await Promise.all([worker.request('rotator.moveSeat', { seatKey: last, by: -1 }), worker.request('rotator.moveSeat', { seatKey: last, by: -1 })])
  const after = w.rotator.snapshot().order!.claude!
  assert.equal(after.indexOf(last), before.length - 3, `${before.join(',')} → ${after.join(',')}`)
  await worker.deactivate()
})

test('API error: pausing while the input box is read stops the retry', async () => {
  let w!: ReturnType<typeof world>
  let pauseNow = false
  const drafts = {
    get t1() {
      if (pauseNow) void w.rotator.setPaused(true)
      return ''
    }
  }
  w = world({ panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }], tails: { t1: fx.CLAUDE_API_ERROR }, drafts, onSleep: () => (pauseNow = true) })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.rotator.state.paused, true)
  assert.deepEqual(w.typed, [])
  await worker.deactivate()
})

test('Wait and resume: a session whose own account resets first goes on in the pane it is in; nothing is closed', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_LIMIT_NO_RESET },
    state: { health: { 'claude:c2': { cooldownUntil: 1_000_000 + 180 * MIN }, 'claude:c3': { cooldownUntil: 1_000_000 + 180 * MIN }, 'claude:system': { cooldownUntil: 1_000_000 + 180 * MIN } } }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(stored(w).waiting[0]?.fromSeat, 'claude:c1')
  w.advance(61 * MIN)
  await w.rotator.tick()
  assert.deepEqual(w.typed, [{ terminalId: 't1', text: 'Continue.' }])
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  assert.equal(stored(w).waiting.length, 0)
  assert.deepEqual(stored(w).history.at(-1), { ...stored(w).history.at(-1), reason: 'reset', result: 'retried', from: 'claude:c1', to: 'claude:c1' })
  assert.equal(lastNote(w), 'Claude: one has reset; the session continues there.')
  await worker.deactivate()
})

test('Wait and resume, a service that cannot resume: a Codex session whose own account resets keeps its conversation (no new session from a summary)', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'codex', state: 'done', sessionId: 'cs1' }],
    tails: { t1: fx.CODEX_USAGE_LIMIT },
    state: { health: { 'codex:x2': { cooldownUntil: 1_000_000 + 5 * 1440 * MIN }, 'codex:system': { cooldownUntil: 1_000_000 + 5 * 1440 * MIN } } }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(stored(w).waiting.length, 1)
  w.advance(3 * 1440 * MIN)
  await w.rotator.tick()
  assert.equal(w.host.callsOf('agent.launch').length, 0)
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.deepEqual(w.typed, [{ terminalId: 't1', text: 'Continue.' }])
  assert.equal(lastNote(w), 'Codex: one has reset; the session continues there.')
  await worker.deactivate()
})

test('Wait and resume: with text typed in the session whose own account reset, Claude is handed off as before and the text goes along; no first message set says so', async () => {
  const health = { 'claude:c2': { cooldownUntil: 1_000_000 + 180 * MIN }, 'claude:c3': { cooldownUntil: 1_000_000 + 180 * MIN }, 'claude:system': { cooldownUntil: 1_000_000 + 180 * MIN } }
  const drafts: Record<string, string> = {}
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_LIMIT_NO_RESET },
    settings: { restore_unsent_text: true },
    drafts,
    state: { health }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  drafts.t1 = 'and then the tests'
  w.advance(61 * MIN)
  await w.rotator.tick()
  // Typing "Continue." there would send the text with it: the session is resumed, and the text put back.
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  assert.ok(w.typed.some((t) => t.text.includes('and then the tests')), JSON.stringify(w.typed))
  await worker.deactivate()

  const quiet = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_LIMIT_NO_RESET },
    settings: { auto_message: '' },
    state: { health }
  })
  const qw = await quiet.mount()
  await qw.emit('agent.status.changed', statusEvent('t1'))
  quiet.advance(61 * MIN)
  await quiet.rotator.tick()
  assert.deepEqual(quiet.typed, [])
  assert.equal(quiet.host.callsOf('terminal.close').length, 0)
  assert.equal(lastNote(quiet), 'Claude: one has reset. No first message is set, so the session is left for you to continue.')
  await qw.deactivate()
})

test('restart: the state 0.2.1 stored loads as it is; its waiting session is resumed at its time', async () => {
  const old = {
    paused: false,
    health: { 'claude:c1': { cooldownUntil: 1_000_000 + 30 * MIN, reason: 'rate_limit: 5-hour limit reached', resetKnown: true }, 'claude:c2': { cooldownUntil: 1_000_000 + 10 * MIN }, 'claude:c3': { cooldownUntil: 1_000_000 + 20 * MIN }, 'claude:system': { cooldownUntil: 1_000_000 + 20 * MIN } },
    paneSeat: { t1: 'claude:c1' },
    seen: { 'session:s1': { fingerprint: classify('claude', fx.CLAUDE_SESSION_LIMIT, 1_000_000)!.fingerprint, occurrences: 1 } },
    apiRetries: {},
    modelStep: {},
    waiting: [{ terminalId: 't1', workspaceId: 'w1', agent: 'claude', sessionId: 's1', fromSeat: 'claude:c1', wakeAt: 1_000_000 + 10 * MIN }],
    history: [{ at: 1_000_000 - MIN, terminalId: 't1', provider: 'claude', from: 'claude:c1', reason: 'rate_limit', result: 'waiting', detail: 'until 9:00 am' }],
    lastAutoSwitchAt: {},
    // 0.2.1 only: the note about its `custom` mode.
    customNoticeSeen: true
  }
  const w = world({ panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }], tails: { t1: fx.CLAUDE_SESSION_LIMIT }, state: old as never })
  const worker = await w.mount()
  await w.rotator.tick()
  const snap = w.rotator.snapshot()
  assert.equal(snap.waiting.length, 1)
  assert.equal(snap.history.length, 1)
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  // The old banner is still on screen: its event is not a new limit.
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(stored(w).history.length, 1)
  w.advance(11 * MIN)
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.equal(stored(w).history.at(-1)?.result, 'resumed')
  assert.equal(stored(w).waiting.length, 0)
  await worker.deactivate()
})

test('restart: stored state with a part that is not what it should be starts that part empty, never stops the worker', async () => {
  const broken = { paused: 'yes', health: null, paneSeat: [], waiting: [{ terminalId: 't9' }, null, { terminalId: 't1', workspaceId: 'w1', agent: 'gemini', wakeAt: 1 }], history: 'none' }
  const w = world({ panes: [], tails: {}, state: broken as never })
  const worker = await w.mount()
  await w.rotator.tick()
  assert.deepEqual(w.rotator.state.waiting, [])
  assert.deepEqual(w.rotator.state.history, [])
  assert.deepEqual(w.rotator.state.health, {})
  assert.equal(w.rotator.state.paused, false)
  assert.equal(w.rotator.snapshot().seats.length > 0, true)
  await worker.deactivate()
})

test('restart while the session on screen counts down: you are taken to be here, so it is not handed off at once; the countdown starts again once you are away', async () => {
  const { w } = onTab({
    settings: { active_terminal: 'ask' },
    state: {
      health: { 'claude:c1': { cooldownUntil: 1_000_000 + 60 * MIN, reason: 'rate_limit: 5-hour limit reached', resetKnown: true } },
      paneSeat: { t1: 'claude:c1' },
      seen: { 'session:s1': { fingerprint: classify('claude', fx.CLAUDE_SESSION_LIMIT, 1_000_000)!.fingerprint, occurrences: 1 } },
      // The countdown ran out while the worker was down.
      waiting: [{ terminalId: 't1', workspaceId: 'w1', agent: 'claude', sessionId: 's1', fromSeat: 'claude:c1', wakeAt: 1_000_000 - 120_000, reason: 'rate_limit', activeSince: 1_000_000 - 120_000, asked: true, toldHeld: true, toldCountdown: true, countdownFrom: 1_000_000 - 70_000, countdownUntil: 1_000_000 - 10_000 }]
    }
  })
  const worker = await w.mount()
  await w.rotator.tick()
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(stored(w).waiting.length, 1)
  assert.equal(stored(w).waiting[0]!.countdownUntil, undefined)
  assert.equal(w.rotator.countdownDueIn(), undefined)
  // Still asked in the panel, and nothing said twice.
  assert.equal(stored(w).waiting[0]!.asked, true)
  assert.equal(bodies(w).length, 0, bodies(w).join(' | '))
  // No sign of you for 5 minutes: it counts down again, and the tick is set to its end.
  w.advance(301_000)
  await w.rotator.tick()
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(w.rotator.countdownDueIn(), 60_000)
  w.advance(61_000)
  await w.rotator.tick()
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  assert.equal(stored(w).waiting.length, 0)
  await worker.deactivate()
})

test('restart while paused: it stays paused, and waiting sessions stay where they are', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    inactiveClaude: { c2: { session: 5, weekly: 5 } },
    state: { paused: true, waiting: [{ terminalId: 't1', workspaceId: 'w1', agent: 'claude', sessionId: 's1', fromSeat: 'claude:c1', wakeAt: 1_000_000 - 1000 }] }
  })
  const worker = await w.mount()
  await w.rotator.tick()
  assert.equal(w.rotator.snapshot().paused, true)
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.deepEqual(w.typed, [])
  assert.equal(stored(w).waiting.length, 1)
  await worker.deactivate()
})

test('Custom order with a Skipped account: a limit hands off to the highest account in the order with room that is not skipped', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    settings: { pick: 'my-order', chain: 'claude:c3, claude:c2, claude:c1', exclude: 'claude:c3' },
    inactiveClaude: { c2: { session: 20, weekly: 20 }, c3: { session: 5, weekly: 5 } }
  })
  const worker = await w.mount()
  assert.deepEqual(w.rotator.snapshot().order?.claude?.slice(0, 3), ['claude:c3', 'claude:c2', 'claude:c1'])
  assert.equal(w.rotator.snapshot().seats.find((s) => s.key === 'claude:c3')?.excluded, true)
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.equal(stored(w).history.at(-1)?.to, 'claude:c2')
  // Nor is the skipped account gone back to afterwards, though it is first in the order.
  w.advance(10 * MIN)
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select claude c2'])
  await worker.deactivate()
})

test('session on screen: a held session whose own account resets is not typed into while you are using Orca; it goes on there once the hold ends', async () => {
  const usage = { session: 100, weekly: 40 }
  const { w } = onTab({ claudeUsage: usage, inactiveClaude: { c2: { session: 5, weekly: 5 } }, state: { paneSeat: { t1: 'claude:c1' } } })
  const worker = await w.mount()
  // Past the start-up (you are taken to be here for 5 minutes): the limit starts a countdown.
  w.advance(301_000)
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.ok(stored(w).waiting[0]?.countdownUntil !== undefined)
  // You come back (using the panel), and meanwhile the session's own account has reset while the
  // account it was to go to is set aside.
  w.advance(20_000)
  w.rotator.notePresence()
  usage.session = 0
  w.rotator.state.health = { 'claude:c2': { cooldownUntil: 1_000_000 + 600 * MIN }, 'claude:c3': { cooldownUntil: 1_000_000 + 600 * MIN }, 'claude:system': { cooldownUntil: 1_000_000 + 600 * MIN } }
  await w.rotator.tick()
  assert.deepEqual(w.typed, [], 'nothing is typed into the session on screen while you are here')
  assert.equal(stored(w).waiting.length, 1)
  assert.equal(stored(w).waiting[0]!.countdownUntil, undefined)
  assert.equal(lastNote(w), 'Claude: one is free again. The session on screen was left as it is. It continues there when you switch to another tab or step away, or press Hand off now in Auto Hand-off.')
  // No sign of you for 5 minutes, then the countdown: it goes on in the pane it is in.
  w.advance(301_000)
  await w.rotator.tick()
  assert.deepEqual(w.typed, [])
  w.advance(61_000)
  await w.rotator.tick()
  assert.deepEqual(w.typed, [{ terminalId: 't1', text: 'Continue.' }])
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(stored(w).waiting.length, 0)
  await worker.deactivate()
})

// ---- safety rules, checked on everything the plugin does -----------------------------------------

/** What must hold for every act of the plugin when nothing was asked for by hand (no panel
 *  switch, no command): the safety rules, as the fake Orca saw them at the moment of each act. */
function checkActs(w: ReturnType<typeof world>, restore: boolean, where: string): void {
  const says = (a: Act, rule: string) => `${where}: ${rule}: ${JSON.stringify(a)}\nall acts: ${JSON.stringify(w.acts)}`
  const between = (a: Act) => a.state === 'waiting' || a.state === 'done'
  /** What the session's input box held: text, '' when empty, or undefined when Orca could not say. */
  const box = (a: Act): string | undefined => {
    if (a.screenDraft) return a.draft && a.draft !== '!' && a.draft !== '?' ? a.draft : a.screenDraft
    return a.draft === '!' || a.draft === '?' ? undefined : (a.draft ?? '')
  }
  const plain = (text: string) => !/\[(Image|Pasted text)[^\]]*#\d+/.test(text) && !/press up to edit queued messages/i.test(text) && text.length <= 4000 && !text.includes('\u001b')
  // Nothing was asked of Orca that it refuses for its size (a notification never shown, a first
  // message never sent), and what is stored and what the panel is sent stay within Orca's limits.
  assert.deepEqual(w.refused, [], `${where}: Orca would have refused these`)
  assert.ok(JSON.stringify(w.host.data().storage.state ?? null).length * 3 <= 256 * 1024, `${where}: the stored state is too large for Orca's storage`)
  assert.ok(JSON.stringify(w.rotator.snapshot()).length * 3 <= 64 * 1024, `${where}: the snapshot is too large for a panel message`)
  w.acts.forEach((a, i) => {
    // Pause, and a service's Automatic hand-off off, stop every automatic action.
    assert.equal(a.paused, false, says(a, 'acted while paused'))
    assert.equal(a.serviceOn, true, says(a, 'acted for a service whose automatic hand-off is off'))
    if (a.kind === 'close') {
      // Never mid-turn; never over unsent text or queued messages, nor when Orca cannot say.
      assert.ok(between(a), says(a, 'closed a session in the middle of a turn'))
      const text = box(a)
      assert.notEqual(text, undefined, says(a, 'closed a session whose input box Orca could not report'))
      if (text) {
        assert.ok(restore && a.agent === 'claude' && !!a.sessionId && plain(text), says(a, 'closed a session over unsent text that cannot go along'))
        // Text that went along is put back, or kept in History.
        const back = w.acts.slice(i + 1).some((b) => b.kind === 'paste' && (b.text ?? '').includes(text))
        const kept = w.rotator.state.history.some((h) => h.unsent === text)
        assert.ok(back || kept, says(a, 'unsent text neither put back nor kept in History'))
      }
      // The same session, on the same service: resumed as itself right after, or started anew
      // right before, by an agent of that service.
      const next = w.acts[i + 1]
      const prev = w.acts[i - 1]
      if (next?.kind === 'resume') {
        assert.equal(next.agent, a.agent, says(a, 'resumed with another service'))
        assert.equal(next.sessionId, a.sessionId, says(a, 'resumed another session'))
      } else assert.ok(prev?.kind === 'launch' && prev.agent === a.agent, says(a, 'closed without a new session of the same service'))
    }
    if (a.kind === 'resume') assert.equal(w.acts[i - 1]?.kind, 'close', says(a, 'resumed without closing'))
    if (a.kind === 'type') {
      // Typing with Enter sends whatever is in the input box, and lands in a running turn.
      assert.ok(between(a), says(a, 'typed into a session in the middle of a turn'))
      assert.equal(box(a), '', says(a, 'typed into a session whose input box was not known to be empty'))
    }
    if (a.kind === 'paste') assert.equal(box(a), '', says(a, 'put text into an input box that was not known to be empty'))
    if (a.kind === 'select') {
      // Only ever an account of the same service.
      const family = a.accountId === 'system' ? a.agent : a.accountId?.startsWith('c') ? 'claude' : a.accountId?.startsWith('x') ? 'codex' : undefined
      assert.equal(family, a.agent, says(a, 'selected an account of another service'))
    }
  })
}

/** A small seeded generator (mulberry32), so a failing case can be run again by its seed. */
function seeded(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
  return { next, pick, chance: (p: number) => next() < p }
}

/** One made-up situation: sessions of Claude and Codex in any state, limits, API errors and model
 *  limits on their screens, text (or queued messages, or no answer from Orca) in their input boxes,
 *  any settings, sessions already waiting; then events, ticks and time, with the user typing,
 *  starting turns, pausing and switching services on and off in between, and in the seconds a
 *  hand-off takes. Nothing is asked for by hand, so every act is the plugin's own. */
async function madeUp(seed: number, hard = false) {
  const r = seeded(seed)
  const DRAFTS = ['', '', '', '', 'half a prompt', 'fix the\nparser', '[Image #1] look at this', 'Press up to edit queued messages', '!', '?']
  // `hard`: also text in other scripts and with shell syntax, text too long to go along or with a
  // control sequence in it, accounts set to Skip, an account list that changes under the plugin
  // (accounts removed, an empty or broken answer, no answer), settings changed in Orca while
  // sessions wait, the same event many times over, and events and ticks at the same moment.
  if (hard) DRAFTS.push('修正 parser 🐛 "q" $(id) `x` \\ --enter', 'y'.repeat(4500), 'odd\u001b[201~\nrm -rf build')
  const LISTS = ['ok', 'ok', 'ok', 'ok', 'empty', 'null', 'fails', 'no-c1', 'no-c2', 'only-c1', 'rows', 'nothing-selected'] as const
  let listing: (typeof LISTS)[number] = 'ok'
  // …and Orca, for a while, not saying which agents run.
  let agentsDown = false
  const listed = (list: Record<string, any>): any => {
    const claude = (change: Record<string, unknown>) => ({ ...list, claude: { ...list.claude, ...change } })
    const without = (id: string) => list.claude.accounts.filter((a: any) => a.id !== id)
    switch (listing) {
      case 'empty':
        return {}
      case 'null':
        return null
      case 'fails':
        throw new Error('orca account list: runtime_unavailable')
      case 'no-c1':
        return claude({ accounts: without('c1'), ...(list.claude.activeAccountId === 'c1' ? { activeAccountId: 'c2' } : {}) })
      case 'no-c2':
        return claude({ accounts: without('c2'), ...(list.claude.activeAccountId === 'c2' ? { activeAccountId: null } : {}) })
      case 'only-c1':
        return claude({ accounts: list.claude.accounts.slice(0, 1), activeAccountId: 'c1', systemDefaultHome: null })
      case 'rows':
        return claude({ accounts: [null, 7, { email: 'no-id@example.test' }, { id: 42 }, ...list.claude.accounts.map((a: any) => (a.id === 'c2' ? { ...a, email: { odd: true } } : a))] })
      case 'nothing-selected':
        return claude({ activeAccountId: 'c9' })
      default:
        return list
    }
  }
  const TAILS: Record<string, string[][]> = {
    claude: [fx.CLAUDE_SESSION_LIMIT, fx.CLAUDE_LIMIT_NO_RESET, fx.CLAUDE_MODEL_CAP, fx.CLAUDE_API_ERROR, fx.CLAUDE_TALKING_ABOUT_LIMITS, [...fx.CLAUDE_LIMIT_NO_RESET, '❯ typed on screen']],
    codex: [fx.CODEX_USAGE_LIMIT, fx.CODEX_OLLAMA_CREDITS, ['• Edited src/app.ts (+4 -1)', '', '› Ask Codex to do anything']]
  }
  const STATES = ['done', 'done', 'done', 'waiting', 'working', 'blocked'] as const
  const panes: Pane[] = []
  const tails: Record<string, string[]> = {}
  const drafts: Record<string, string> = {}
  const count = 1 + Math.floor(r.next() * 3)
  for (let i = 1; i <= count; i++) {
    const agent = r.chance(0.65) ? 'claude' : 'codex'
    const id = `p${i}`
    panes.push({ terminalId: id, agent, state: r.pick(STATES), ...(r.chance(0.85) ? { sessionId: `s-${id}` } : {}) })
    tails[id] = r.pick(TAILS[agent]!)
    const text = r.pick(DRAFTS)
    if (text) drafts[id] = text
  }
  const ids = panes.map((p) => p.terminalId)
  const restore = r.chance(0.5)
  const settings: Record<string, string | number | boolean> = {
    timing: r.pick(['early', 'early', 'at-limit']),
    pick: r.pick(['smart', 'smart', 'my-order']),
    chain: r.chance(0.3) ? 'claude:c2, claude:c1, claude:c3' : '',
    when_all_used: r.pick(['wait', 'wait', 'stop']),
    active_terminal: r.pick(['ask', 'careful', 'wait', 'now']),
    restore_unsent_text: restore,
    away_minutes: r.pick([0, 0, 10]),
    idle_minutes: r.pick([15, 15, 0]),
    model_fallback: r.chance(0.4) ? 'claude=sonnet,haiku' : '',
    auto_message: r.chance(0.85) ? 'Continue.' : '',
    max_api_retries: r.pick([6, 6, 0]),
    service_claude: r.chance(0.8),
    service_codex: r.chance(0.8),
    ...(hard ? { exclude: r.pick(['', '', 'claude:c2', 'claude:c2, claude:c3', 'claude:*', 'claude:c1', 'codex:x2, codex:system', 'two@example.test']) } : {})
  }
  const cooling = () => ({ cooldownUntil: 1_000_000 + r.pick([5, 30, 90, 400]) * MIN, ...(r.chance(0.5) ? { resetKnown: true } : {}) })
  const health: RotatorState['health'] = {}
  for (const key of ['claude:c2', 'claude:c3', 'claude:system', 'codex:x2', 'codex:system']) if (r.chance(0.35)) health[key] = cooling()
  const paneSeat: Record<string, string> = {}
  for (const p of panes) if (r.chance(0.7)) paneSeat[p.terminalId] = p.agent === 'claude' ? 'claude:c1' : 'codex:x1'
  const waiting: RotatorState['waiting'] = []
  for (const p of panes) {
    if (!r.chance(0.3)) continue
    const from = p.agent === 'claude' ? 'claude:c1' : 'codex:x1'
    const base = { terminalId: p.terminalId, workspaceId: 'w1', agent: p.agent as 'claude' | 'codex', ...(p.sessionId ? { sessionId: p.sessionId } : {}), fromSeat: from, wakeAt: 1_000_000 + r.pick([-1000, 5 * MIN, 61 * MIN]) }
    waiting.push(
      r.pick([
        base,
        { ...base, hold: 'short' as const },
        { ...base, reason: 'rate_limit' as const, draftAt: 1_000_000 - 1000 },
        { ...base, reason: 'rate_limit' as const, draftAt: 1_000_000 - 1000, unchecked: true },
        { ...base, reason: 'rate_limit' as const, activeSince: 1_000_000 - 120_000, countdownFrom: 1_000_000 - 70_000, countdownUntil: 1_000_000 - 10_000 },
        { ...base, reason: 'rate_limit' as const, activeSince: 1_000_000 - 120_000, asked: true, declined: true },
        { ...base, reason: 'model_cap' as const, model: 'fable' }
      ])
    )
  }
  const claudeUsage = r.pick([{ session: 100, weekly: 40 }, { session: 98, weekly: 40 }, { session: 50, weekly: 20 }, { session: 5, weekly: 5 }])
  const shown = ids.filter(() => r.chance(0.4))
  // The user, in the seconds a hand-off takes: starts a turn, types, or Orca stops answering.
  // Only in the waits the plugin looks again after: not in the 1.5 s after its own message (waited
  // out, not looked at again), and not in the waits of the usage read that follows a switch in
  // the background (8 s and 62 s), which end at any moment of whatever else is going on.
  let meddle = r.chance(0.5)
  let w!: ReturnType<typeof world>
  const options: Parameters<typeof world>[0] = {
    panes,
    tails,
    drafts,
    settings,
    claudeUsage,
    ...(r.chance(0.5) ? { inactiveClaude: { c2: r.pick([{ session: 5, weekly: 5 }, { session: 100, weekly: 50 }, { session: 60, weekly: 96 }]) } } : {}),
    activeTerminals: shown,
    focusedTerminals: r.chance(0.8) ? shown : ids,
    ...(r.chance(0.3) ? { visibleTerminals: ids } : {}),
    refuseHostSend: r.chance(0.2),
    redraw: r.pick([false, true, 'late'] as const),
    state: { paused: r.chance(0.25), health, paneSeat, waiting },
    ...(hard ? { accounts: listed, agentsListFails: () => agentsDown } : {}),
    onSleep: (ms) => {
      if (!meddle || ms === 1500 || ms === 8000 || ms === 62_000 || !r.chance(0.3)) return
      const p = r.pick(w.panes)
      if (!p) return
      if (r.chance(0.5)) p.state = r.pick(['working', 'blocked'] as const)
      else drafts[p.terminalId] = r.pick(DRAFTS.filter(Boolean))
    }
  }
  w = world(options)
  const worker = await w.mount()
  const steps = 8 + Math.floor(r.next() * 8)
  /** A turn of `p` ends, or the timer comes: what can happen at the same moment as another. */
  const eventOrTick = async (i: number): Promise<void> => {
    const p = w.panes.length ? r.pick(w.panes) : undefined
    if (!p || r.chance(0.4)) return w.rotator.tick()
    const event = { ...statusEvent(p.terminalId, r.pick(['done', 'waiting'] as const), i + 2), ...(p.sessionId ? { sessionId: p.sessionId } : {}) }
    // Sometimes the same event several times over.
    await Promise.all(Array.from({ length: r.chance(0.3) ? 4 : 1 }, () => worker.emit('agent.status.changed', event)))
  }
  for (let i = 0; i < steps; i++) {
    const p = w.panes.length ? r.pick(w.panes) : undefined
    const what = r.next()
    if (hard && r.chance(0.35)) {
      const kind = r.next()
      if (kind < 0.45) await Promise.all([eventOrTick(i), eventOrTick(i + 50), ...(r.chance(0.5) ? [eventOrTick(i + 100)] : [])])
      else if (kind < 0.65) listing = r.pick(LISTS)
      else if (kind < 0.72) agentsDown = !agentsDown
      else {
        const [key, value] = r.pick([
          ['timing', 'early'],
          ['timing', 'at-limit'],
          ['pick', 'smart'],
          ['pick', 'my-order'],
          ['when_all_used', 'wait'],
          ['when_all_used', 'stop'],
          ['active_terminal', 'ask'],
          ['active_terminal', 'careful'],
          ['active_terminal', 'wait'],
          ['active_terminal', 'now'],
          ['exclude', ''],
          ['exclude', 'claude:c2'],
          ['exclude', 'claude:c3, claude:c2'],
          ['exclude', 'claude:*, codex:*'],
          ['chain', 'claude:c3, claude:c1']
        ] as const)
        await w.set(key, value)
      }
      continue
    }
    if (what < 0.3 && p) {
      // A turn ends (often on a new copy of what its screen showed).
      if (r.chance(0.4)) w.tails[p.terminalId] = [...(w.tails[p.terminalId] ?? []), '❯ continue', ...(w.tails[p.terminalId] ?? r.pick(TAILS.claude!))]
      if (r.chance(0.7)) p.state = r.pick(['done', 'waiting'] as const)
      await worker.emit('agent.status.changed', { ...statusEvent(p.terminalId, r.pick(['done', 'waiting'] as const), i + 2), ...(p.sessionId ? { sessionId: p.sessionId } : {}) })
    } else if (what < 0.6) {
      await w.rotator.tick()
    } else if (what < 0.75) {
      w.advance(r.pick([30_000, 61_000, 5 * MIN + 1000, 16 * MIN, 61 * MIN, 6 * 60 * MIN]))
    } else if (what < 0.82 && p) {
      p.state = r.pick(STATES)
      w.touch(p.terminalId)
    } else if (what < 0.89 && p) {
      const text = r.pick(DRAFTS)
      if (text) drafts[p.terminalId] = text
      else delete drafts[p.terminalId]
    } else if (what < 0.93) {
      options.activeTerminals = w.panes.map((x) => x.terminalId).filter(() => r.chance(0.4))
      options.focusedTerminals = options.activeTerminals
    } else if (what < 0.96) {
      await worker.request('rotator.pause', { paused: !w.rotator.state.paused })
    } else if (what < 0.98) {
      const provider = r.pick(['claude', 'codex'] as const)
      await worker.request('rotator.setService', { provider, enabled: w.host.data().settings[`service_${provider}`] === false })
    } else meddle = !meddle
  }
  checkActs(w, restore, `seed ${seed}${hard ? ' (hard)' : ''}`)
  // A session is closed at most once (its pane is gone after that), and resumed once per close.
  const closedIds = w.acts.filter((a) => a.kind === 'close').map((a) => a.terminalId)
  assert.equal(new Set(closedIds).size, closedIds.length, `seed ${seed}${hard ? ' (hard)' : ''}: a session was closed twice: ${closedIds.join(',')}`)
  const acts = w.acts
  await worker.deactivate()
  return acts
}

test('safety, in 1000 made-up situations: nothing is ever closed mid-turn or over text that cannot go along, typed into a busy session or a full input box, handed to another service, or done at all while paused or with the service off', async () => {
  const done: Record<string, number> = {}
  for (let seed = 1; seed <= 1000; seed++) for (const a of await madeUp(seed)) done[a.kind] = (done[a.kind] ?? 0) + 1
  // The situations are not idle ones: the rules above were checked on plenty of each kind of act.
  for (const kind of ['select', 'close', 'resume', 'launch', 'type', 'paste']) assert.ok((done[kind] ?? 0) >= 10, `only ${done[kind] ?? 0} × ${kind}: ${JSON.stringify(done)}`)
})

test('session on screen, Not now: the session stays as it is when its own account resets, until another tab is shown', async () => {
  const usage = { session: 100, weekly: 40 }
  const { options, w } = onTab({ claudeUsage: usage, inactiveClaude: { c2: { session: 5, weekly: 5 } }, settings: { active_terminal: 'ask' }, state: { paneSeat: { t1: 'claude:c1' } } })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  await worker.request('rotator.declineHandoff', { terminalId: 't1' })
  usage.session = 0
  w.rotator.state.health = { 'claude:c2': { cooldownUntil: 1_000_000 + 600 * MIN }, 'claude:c3': { cooldownUntil: 1_000_000 + 600 * MIN }, 'claude:system': { cooldownUntil: 1_000_000 + 600 * MIN } }
  for (let i = 0; i < 4; i++) {
    w.advance(10 * MIN)
    await w.rotator.tick()
  }
  assert.deepEqual(w.typed, [])
  assert.equal(stored(w).waiting.length, 1)
  // Another tab is shown: it goes on where it is, on its own account. Nothing is closed.
  options.activeTerminals = ['t9']
  await w.rotator.tick()
  assert.deepEqual(w.typed, [{ terminalId: 't1', text: 'Continue.' }])
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(stored(w).waiting.length, 0)
  await worker.deactivate()
})

test('an early hand-off that the switch cooldown or the room on the other account rules out starts no orca process to look at the session', async () => {
  // Low, and the account was changed a moment ago: within the cooldown nothing moves early.
  const w = calm({ session: 97, weekly: 40 }, { state: { paneSeat: { t1: 'claude:c1' }, lastAutoSwitchAt: { claude: 1_000_000 - 1000 } } })
  const worker = await w.mount()
  const before = w.lookups.length
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(w), [])
  // (One look at the layout per event, for the service in focus: as in 0.2.)
  assert.deepEqual(w.lookups.slice(before), ['terminals'])
  // After the cooldown the session is looked at, and handed off.
  w.advance(6 * MIN)
  await worker.emit('agent.status.changed', statusEvent('t1', 'done', 2))
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.ok(w.lookups.some((l) => l === 'draft t1'))
  await worker.deactivate()
})

test('restart: one stored entry that is not what it should be is dropped; the tick and a limit go on as usual', async () => {
  const broken = { health: { 'claude:c2': null, 'claude:c3': 'limited', 'claude:system': { cooldownUntil: 1_000_000 + 60 * MIN } }, seen: { t7: null }, probation: { claude: null }, leftLow: { 'claude:c2': 5 } }
  const w = world({ panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }], tails: { t1: fx.CLAUDE_SESSION_LIMIT }, state: broken as never })
  const worker = await w.mount()
  await w.rotator.tick()
  // What was valid is kept.
  assert.deepEqual(Object.keys(w.rotator.state.health), ['claude:system'])
  assert.deepEqual(w.rotator.state.probation, {})
  assert.deepEqual(w.rotator.state.leftLow, {})
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  await worker.deactivate()
})

test('upgrade: "Switch at usage threshold" off in 0.2 carries over as At limit, where 0.2 ran it', () => {
  assert.equal(up({ auto_switch_on_threshold: false }).timing, 'at-limit')
  assert.equal(up({ mode: 'custom', auto_switch_on_threshold: false }).timing, 'at-limit')
  assert.equal(configFrom(up({ mode: 'custom', auto_switch_on_threshold: false })).runningSessions, 'limit')
  // Smart or My order chosen in 0.2 overrode it.
  assert.equal(up({ mode: 'smart', auto_switch_on_threshold: false }).timing, 'early')
  assert.equal(up({ auto_switch_on_threshold: false, timing: 'early' }).timing, 'at-limit', 'early is the default: untouched')
  assert.equal(up({ auto_switch_on_threshold: true }).timing, 'early')
})

test('pause, and a service’s Automatic hand-off off, stop every automatic path: each one acts when on, and does nothing to any session or to the selection when stopped', async () => {
  type W = ReturnType<typeof world>
  type Worker = Awaited<ReturnType<W['mount']>>
  type Path = { name: string; service?: 'claude' | 'codex'; make: () => W; arm?: (w: W, worker: Worker) => Promise<void>; fire: (w: W, worker: Worker) => Promise<void> }
  const claude = (tail: string[], extra: Partial<Parameters<typeof world>[0]> = {}) => world({ panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }], tails: { t1: tail }, ...extra })
  const turnEnds = async (_w: W, worker: Worker) => {
    await worker.emit('agent.status.changed', statusEvent('t1'))
  }
  const later = (ms: number) => async (w: W) => {
    w.advance(ms)
    await w.rotator.tick()
  }
  const othersCooling = { 'claude:c2': { cooldownUntil: 1_000_000 + 180 * MIN }, 'claude:c3': { cooldownUntil: 1_000_000 + 180 * MIN }, 'claude:system': { cooldownUntil: 1_000_000 + 180 * MIN } }
  const shortReset = { session: 100, weekly: 40, sessionReset: 1_000_000 + 4 * MIN }
  const drafts: Record<string, string> = {}
  const paths: Path[] = [
    { name: 'a limit at a turn end (Claude: resumed)', make: () => claude(fx.CLAUDE_SESSION_LIMIT), fire: turnEnds },
    { name: 'a limit at a turn end (Codex: a new session)', service: 'codex', make: () => world({ panes: [{ terminalId: 't1', agent: 'codex', state: 'done' }], tails: { t1: fx.CODEX_USAGE_LIMIT }, state: { paneSeat: { t1: 'codex:x1' } } }), fire: turnEnds },
    { name: 'an API error (retried)', make: () => claude(fx.CLAUDE_API_ERROR), fire: turnEnds },
    { name: 'a model limit (the fallback model)', make: () => claude(fx.CLAUDE_MODEL_CAP, { settings: { model_fallback: 'claude=sonnet' } }), fire: turnEnds },
    { name: 'early: a turn ends on an account that is running low', make: () => calm({ session: 97, weekly: 40 }), fire: turnEnds },
    { name: 'early: an idle session on an account that is running low', make: () => calm({ session: 97, weekly: 40 }), fire: later(16 * MIN) },
    { name: 'Custom order: back to a higher account', make: () => behind({ health: { 'claude:c2': { resetKnown: true, freedAt: 1_000_000 - 1000 } } }), fire: turnEnds },
    {
      name: 'the account for new sessions, while a session is mid-turn on one that is running low',
      make: () => world({ panes: [{ terminalId: 't1', agent: 'claude', state: 'working', sessionId: 's1' }], tails: { t1: ['⏺ Working on it…'] }, claudeUsage: { session: 97, weekly: 40 }, inactiveClaude: { c2: { session: 5, weekly: 5 } }, state: { paneSeat: { t1: 'claude:c1' } } }),
      fire: later(30_000)
    },
    { name: 'a waiting session whose time has come (handed off)', make: () => parkedWorld(), arm: turnEnds, fire: later(11 * MIN) },
    { name: 'a waiting session whose own account reset (goes on where it is)', make: () => claude(fx.CLAUDE_LIMIT_NO_RESET, { state: { health: othersCooling } }), arm: turnEnds, fire: later(61 * MIN) },
    { name: 'a short wait for its own account', make: () => calm({ ...shortReset }, { tails: { t1: [...fx.CLAUDE_LIMIT_NO_RESET] }, laterClaudeUsage: { session: 5, weekly: 5 }, state: { paneSeat: { t1: 'claude:c1' }, health: { 'claude:c1': { cooldownUntil: 1_000_000 + 4 * MIN, resetKnown: true } } } }), arm: turnEnds, fire: later(4 * MIN + 1000) },
    {
      name: 'a hand-off that waited for unsent text, once the text is gone',
      make: () => {
        drafts.t1 = 'half a prompt'
        return claude(fx.CLAUDE_SESSION_LIMIT, { drafts, state: { paneSeat: { t1: 'claude:c1' } } })
      },
      arm: turnEnds,
      fire: async (w) => {
        delete drafts.t1
        w.advance(30_000)
        await w.rotator.tick()
      }
    },
    {
      name: 'the session on screen, once its countdown has run out',
      make: () => onTab().w,
      arm: async (w, worker) => {
        w.advance(301_000)
        await worker.emit('agent.status.changed', statusEvent('t1'))
      },
      fire: later(61_000)
    }
  ]
  for (const path of paths) {
    for (const stop of ['on', 'paused', 'service off'] as const) {
      const w = path.make()
      const worker = await w.mount()
      await path.arm?.(w, worker)
      const before = w.acts.length
      const waiting = stored(w)?.waiting.length ?? 0
      if (stop === 'paused') await worker.request('rotator.pause', { paused: true })
      if (stop === 'service off') await worker.request('rotator.setService', { provider: path.service ?? 'claude', enabled: false })
      await path.fire(w, worker)
      // Twice more, later: nothing that was put off comes through either.
      if (stop !== 'on') for (let i = 0; i < 2; i++) await later(20 * MIN)(w)
      const acts = w.acts.slice(before)
      if (stop === 'on') assert.ok(acts.length > 0, `${path.name}: nothing was done with automatic hand-off on`)
      else {
        assert.deepEqual(acts, [], `${path.name}, ${stop}`)
        // A session that was waiting still waits, for when automatic hand-off is on again.
        assert.equal(stored(w)?.waiting.length ?? 0, waiting, `${path.name}, ${stop}: waiting sessions`)
      }
      await worker.deactivate()
    }
  }
})

test('upgrade: runs once at the first start of 0.3: 0.2 settings (read by name) become the new ones, then are never read again', async () => {
  // Real Orca: get() returns declared settings with their defaults and leaves 0.2 keys out; get(key) still has them.
  const stored: Record<string, unknown> = { switch_early: 'earlier' }
  const declared = { pick: 'smart', timing: 'early', early_minutes: 10, chain: 'claude:c2, claude:c1' }
  const sets: [string, unknown][] = []
  const fakeSettings = {
    get: async (key?: string) => (key === undefined ? { ...declared } : (stored[key] ?? (declared as Record<string, unknown>)[key])),
    set: async (key: string, value: unknown) => {
      sets.push([key, value])
      ;(declared as Record<string, unknown>)[key] = value
    },
    onDidChange: () => ({ dispose() {} })
  }
  const { storedSettings } = await import('./worker')
  const s = await storedSettings({ settings: fakeSettings } as never)
  assert.equal(s.switch_early, 'earlier', 'a 0.2 key is read by name')
  const changes = upgradedValues(s)
  assert.deepEqual(changes, { pick: 'my-order', early_minutes: 25 })
  for (const [k, v] of Object.entries(changes)) await fakeSettings.set(k, v)
  assert.deepEqual(sets, [['pick', 'my-order'], ['early_minutes', 25]])
  // Later, the user picks Auto (the default): the stored 0.2 order must not bring My order back,
  // because the upgrade never runs again (worker.ts keeps an "upgraded" flag in storage).
  await fakeSettings.set('pick', 'smart')
  assert.equal(settingValues(await fakeSettings.get() as Record<string, unknown>).pick, 'smart')
})

// ---- review round 7: settings as live Orca serves them (fixtures.ts `likeOrca`) -----------------

const limitedClaude = (extra: Partial<Parameters<typeof world>[0]> = {}) =>
  world({ panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }], tails: { t1: fx.CLAUDE_SESSION_LIMIT }, ...extra })
const soon = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

test('upgrade, through the worker: 0.2 settings Orca no longer lists are read by name, written as the new ones, and never read again', async () => {
  const w = limitedClaude({
    settings: { switch_early: 'at-limit', strategy: 'priority', chain: 'claude:c2, claude:c1', wait_for_reset: false, retry_on_api_error: false, auto_swap_idle_after_seconds: 1800 }
  })
  let worker = await w.mount()
  const s = w.host.data().settings
  assert.deepEqual([s.pick, s.timing, s.when_all_used, s.max_api_retries, s.idle_minutes], ['my-order', 'at-limit', 'stop', 0, 30])
  assert.equal(w.host.data().storage['upgraded-0.3'], true)
  // The panel is told what was carried over, at once.
  assert.equal(w.rotator.snapshot().mode, 'my-order')
  assert.equal(w.rotator.snapshot().atLimitOnly, true)
  assert.deepEqual(await worker.request('rotator.settings', {}).then((v) => [v.pick, v.timing, v.when_all_used]), ['my-order', 'at-limit', 'stop'])
  // Later the user goes back to the defaults: at the next start the 0.2 values do not return.
  await worker.request('rotator.settings', { key: 'pick', value: 'smart' })
  await worker.request('rotator.settings', { key: 'timing', value: 'early' })
  assert.equal(w.rotator.snapshot().mode, 'smart', 'a change in the Settings tab reaches the badge without waiting for Orca to report it')
  assert.equal(w.rotator.snapshot().atLimitOnly, undefined)
  await worker.deactivate()
  worker = await w.mount()
  assert.deepEqual([w.host.data().settings.pick, w.host.data().settings.timing], ['smart', 'early'])
  await worker.deactivate()
})

test('upgrade: a setup with nothing from 0.2 writes no setting and is marked done; "manual" pauses even when a setting cannot be written', async () => {
  // (The test world itself sets three settings; none of them is a 0.2 one.)
  const fresh = world({ panes: [], tails: {}, settings: {} })
  let worker = await fresh.mount()
  assert.deepEqual(fresh.host.callsOf('settings.set'), [])
  assert.equal(fresh.host.data().storage['upgraded-0.3'], true)
  await worker.deactivate()

  let broken = true
  const faults: SettingsFaults = { set: () => broken }
  const w = limitedClaude({ settings: { mode: 'manual', switch_early: 'at-limit' }, storage: { 'migrated-manual': false }, settingsFaults: faults })
  worker = await w.mount()
  assert.equal(stored(w).paused, true, 'the pause does not depend on the settings being written')
  assert.equal(w.host.data().storage['upgraded-0.3'], undefined, 'not done: the At limit choice was not stored')
  broken = false
  faults.changed?.('timing')
  await soon()
  assert.equal(w.host.data().settings.timing, 'at-limit')
  assert.equal(w.host.data().storage['upgraded-0.3'], true)
  assert.equal(w.host.callsOf('notifications.show').filter((n: any) => /kept Auto Hand-off from handing/.test(String(n.body))).length, 1, 'told once')
  await worker.deactivate()
})

test('fail closed: while Orca cannot say what the 0.2 settings were, nothing is handed off; once it can, the upgrade is done and hand-offs go on', async () => {
  let down = true
  const faults: SettingsFaults = { get: () => down }
  const w = limitedClaude({ settings: { switch_early: 'at-limit' }, settingsFaults: faults })
  const worker = await w.mount()
  assert.equal(w.host.data().storage['upgraded-0.3'], undefined)
  assert.deepEqual(Object.values(w.rotator.snapshot().services ?? {}).filter(Boolean), [], 'every service counts as off')
  await worker.emit('agent.status.changed', statusEvent('t1'))
  await w.rotator.tick()
  assert.deepEqual(w.acts, [], 'no hand-off on settings nobody chose')
  await worker.deactivate()

  // Orca answers again before the limit: the upgrade is done at the next settings change (or tick).
  const again: SettingsFaults = { get: () => down }
  const later = limitedClaude({ settings: { switch_early: 'at-limit' }, settingsFaults: again })
  const second = await later.mount()
  down = false
  again.changed?.('timing')
  await soon()
  assert.equal(later.host.data().storage['upgraded-0.3'], true)
  assert.equal(later.host.data().settings.timing, 'at-limit')
  assert.equal(later.rotator.snapshot().services?.claude, true)
  await second.emit('agent.status.changed', statusEvent('t1'))
  assert.ok(later.cliCalls.includes('select claude c2'), later.cliCalls.join(','))
  await second.deactivate()
})

test('fail closed: settings that cannot be read stay as last read; a service that was off is not turned on by the failure', async () => {
  const { configReader } = await import('./worker')
  let fail = false
  let value: Record<string, unknown> = { service_claude: false, timing: 'at-limit' }
  const logged: string[] = []
  const read = configReader({ settings: { get: async () => (fail ? Promise.reject(new Error('no host')) : value) } } as never, () => false, (m) => logged.push(m))
  assert.equal((await read()).services.claude, false)
  fail = true
  value = {}
  const stale = await read()
  await read()
  assert.equal(stale.services.claude, false)
  assert.equal(stale.runningSessions, 'limit')
  assert.equal(logged.length, 1, 'said once')
  // What the worker itself stored meanwhile counts, though it cannot be read back.
  read.wrote('service_codex', false)
  assert.deepEqual([(await read()).services.codex, (await read()).services.claude, (await read()).services.devin], [false, false, true])
  // Never read at all: every service off, so no automatic action runs on defaults.
  const blind = await configReader({ settings: { get: async () => Promise.reject(new Error('no host')) } } as never)()
  assert.deepEqual(Object.values(blind.services), [false, false, false, false, false])
})

test('upgrade: "Wait for reset" off and an order followed in 0.2 custom mode carry over; leftovers under Smart do not', () => {
  assert.equal(up({ wait_for_reset: false }).when_all_used, 'stop')
  assert.equal(up({ mode: 'custom', wait_for_reset: false }).when_all_used, 'stop')
  assert.equal(up({ mode: 'smart', wait_for_reset: false }).when_all_used, 'wait', '0.2 Smart ran "When everything is used up", not the old switch')
  assert.equal(up({ mode: 'custom', chain: 'claude:c2, claude:c1' }).pick, 'my-order')
  assert.equal(up({ mode: 'custom', chain: 'claude:c2', strategy: 'soonest-reset' }).pick, 'smart')
  assert.equal(up({ mode: 'smart', chain: 'claude:c2, claude:c1' }).pick, 'smart')
})

test('"Hand off this workspace\'s session": a background pane Orca lists without a terminal id is not the one meant', async () => {
  const w = world({ panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1', unlisted: true }], tails: { t1: ['❯ '] } })
  const worker = await w.mount()
  assert.equal(await worker.command('rotator.swapThisPane'), 'No agent in the focused workspace')
  assert.deepEqual(w.acts, [])
  await worker.deactivate()
})

// ---- review round 8: the hold on the settings is said in the panel, and ends by itself ----------

test('fail closed, said: while the settings cannot be read the snapshot says why every service is off; the first read that works ends it', async () => {
  let down = true
  let fire: (() => void) | undefined
  const timers = { setTimer: (fn: () => void) => ((fire = fn), 1), clearTimer: () => undefined }
  const w = limitedClaude({ settings: {}, settingsFaults: { get: () => down }, timers })
  const worker = await w.mount()
  await soon()
  assert.equal(w.rotator.snapshot().held, 'settings')
  assert.deepEqual(Object.values(w.rotator.snapshot().services).filter(Boolean), [])
  // The Settings tab is not given the defaults as if they were chosen.
  await assert.rejects(worker.request('rotator.settings', {}))
  // Skip and the custom order start from the stored lists: no change while they cannot be read.
  await assert.rejects(worker.request('rotator.setExcluded', { seatKey: 'claude:c2', excluded: true }), /could not be read yet/)
  await assert.rejects(worker.request('rotator.moveSeat', { seatKey: 'claude:c2', by: -1 }), /could not be read yet/)
  assert.deepEqual(w.host.callsOf('settings.set'), [])
  // The worker's next tick asks again (the upgrade check waited on the same answer).
  down = false
  fire!()
  await soon()
  assert.equal(w.rotator.snapshot().held, undefined)
  assert.equal(w.rotator.snapshot().services.claude, true)
  assert.equal(w.host.data().storage['upgraded-0.3'], true)
  assert.equal((await worker.request('rotator.settings', {})).timing, 'early')
  await worker.deactivate()
})

test('fail closed, said: an upgrade that cannot be finished is said in the snapshot, tried again by the worker\'s own tick, and over once it is done', async () => {
  let broken = true
  let fire: (() => void) | undefined
  const timers = { setTimer: (fn: () => void) => ((fire = fn), 1), clearTimer: () => undefined }
  const faults: SettingsFaults = { set: () => broken }
  const w = limitedClaude({ settings: { switch_early: 'at-limit' }, settingsFaults: faults, timers })
  const worker = await w.mount()
  await soon()
  assert.equal(w.rotator.snapshot().held, 'upgrade')
  assert.equal(w.host.data().storage['upgraded-0.3'], undefined)
  // *Hand off now* does not say "turn it on": nobody turned it off.
  w.rotator.state.waiting.push({ terminalId: 't1', workspaceId: 'w1', agent: 'claude', wakeAt: 2_000_000 })
  assert.equal(await w.rotator.handoffNow('t1'), 'Auto Hand-off is finishing the upgrade. Nothing is handed off until then.')
  w.rotator.state.waiting.length = 0
  // A hand-off by hand still works, and the choice is kept for when the hold ends: the service's
  // automatic hand-off is stored as off (that setting can be written here; the 0.2 ones cannot).
  broken = false
  const failing = new Set(['timing'])
  faults.set = (key) => failing.has(key)
  const said = await worker.request('rotator.switchTo', { seatKey: 'claude:c2' })
  assert.match(said.message, /automatic hand-off is now off, because you chose an account yourself/)
  assert.equal(w.host.data().settings.service_claude, false)
  assert.ok(w.cliCalls.includes('select claude c2'), w.cliCalls.join(','))
  assert.equal(w.rotator.snapshot().held, 'upgrade')
  w.acts.length = 0
  // Still failing at the next tick: still held, nothing done.
  fire!()
  await soon()
  assert.equal(w.rotator.snapshot().held, 'upgrade')
  assert.deepEqual(w.acts, [])
  // Orca takes the settings again: the next tick finishes the upgrade, with no settings change needed.
  failing.clear()
  fire!()
  await soon()
  assert.equal(w.host.data().storage['upgraded-0.3'], true)
  assert.equal(w.host.data().settings.timing, 'at-limit')
  assert.equal(w.rotator.snapshot().held, undefined)
  // The hold is over: Codex is on again, Claude stays off as chosen by hand.
  assert.equal(w.rotator.snapshot().services.codex, true)
  assert.equal(w.rotator.snapshot().services.claude, false)
  await worker.deactivate()
})

test('fail closed: a service turned off in the panel while the settings cannot be read back is off at once', async () => {
  let down = false
  const w = limitedClaude({ settings: {}, settingsFaults: { get: () => down } })
  const worker = await w.mount()
  assert.equal(w.rotator.snapshot().services.claude, true)
  down = true
  const { services } = await worker.request('rotator.setService', { provider: 'claude', enabled: false })
  assert.equal(services.claude, false)
  assert.equal(w.rotator.snapshot().held, undefined, 'the settings as last read stay in effect: no hold')
  await worker.emit('agent.status.changed', statusEvent('t1'))
  await w.rotator.tick()
  assert.deepEqual(w.acts, [], 'nothing is handed off for a service that was turned off')
  // Skip likewise: the account is skipped though the list cannot be read back.
  await worker.request('rotator.setExcluded', { seatKey: 'claude:c2', excluded: true })
  assert.equal(w.rotator.snapshot().seats.find((x) => x.key === 'claude:c2')?.excluded, true)
  await worker.deactivate()
})

// ---- round 9: combinations meant to break a safety rule ------------------------------------------

/** What Orca's host API takes (1.4.263, its own schemas): a notification body, a text typed into a
 *  terminal and an agent's first message; and one stored value. */
const ORCA_NOTE_MAX = 1000
const ORCA_TEXT_MAX = 4096
const ORCA_VALUE_MAX_BYTES = 256 * 1024
const closed = (w: { acts: Act[] }) => w.acts.filter((a) => a.kind === 'close').map((a) => a.terminalId)

test('a service that starts a new session: the summary is never longer than Orca takes as a first message, whatever the setting', async () => {
  const output = Array.from({ length: 60 }, (_, i) => `• Edited src/file-${i}.ts ${'x'.repeat(150)}`)
  for (const max of [6000, 50000]) {
    const w = world({
      panes: [{ terminalId: 't1', agent: 'codex', state: 'done', sessionId: 'cs1', title: 'fix parser' }],
      tails: { t1: [...output, ...fx.CODEX_USAGE_LIMIT] },
      settings: { handoff_max_chars: max }
    })
    const worker = await w.mount()
    await worker.emit('agent.status.changed', statusEvent('t1'))
    const launches = w.host.callsOf('agent.launch') as { prompt: string }[]
    assert.equal(launches.length, 1, `${max}: ${bodies(w).join(' | ')}`)
    assert.ok(launches[0]!.prompt.length <= ORCA_TEXT_MAX, `${max}: ${launches[0]!.prompt.length} characters`)
    // Cut from the middle of the old output, so what tells the new session what to do stays.
    assert.match(launches[0]!.prompt, /^You are taking over a coding session/)
    assert.match(launches[0]!.prompt, /Do not redo finished work\.$/)
    assert.equal(stored(w).history.at(-1)?.result, 'handoff')
    await worker.deactivate()
  }
})

test('unsent text that could not be put back: the notification is one Orca shows (not over its size), and says where the text is', async () => {
  const text = `please ${'look at the parser and the tests '.repeat(60)}end` // about 2000 characters
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    // The new pane's box is not empty (the user is typing there already): nothing is put back.
    drafts: { t1: text, t2: 'already typing here' },
    settings: { restore_unsent_text: true }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  assert.equal(stored(w).history.find((h) => h.unsent)?.unsent, text, 'kept in full in History')
  const notes = w.host.callsOf('notifications.show') as { title: string; body: string }[]
  const said = notes.find((n) => n.body.includes('could not be put back'))
  assert.ok(said, notes.map((n) => n.body).join(' | '))
  for (const n of notes) assert.ok(n.body.length <= ORCA_NOTE_MAX, `${n.body.length} characters: ${n.body.slice(0, 80)}`)
  assert.match(said!.body, /kept in History/)
  await worker.deactivate()
})

test('fail closed: a limit on an SSH target while Orca cannot list the workspaces is not taken for one on this computer', async () => {
  let down = false
  const w = sshWorld({ workspaceListFails: () => down })
  const worker = await w.mount()
  // Orca stops answering where the workspaces run: nobody knows this session is on an SSH target.
  down = true
  await worker.emit('agent.status.changed', w.event(2))
  assert.deepEqual(w.cliCalls, [], 'no account of this computer is selected for it')
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  // Orca answers again: the limit is noted as one on an SSH target, and the session left alone.
  down = false
  await worker.emit('agent.status.changed', w.event(3))
  assert.deepEqual(w.cliCalls, [])
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.ok((w.host.callsOf('notifications.show') as { body: string }[]).some((n) => /SSH target build-box/.test(n.body)))
  await worker.deactivate()
})

test('two sessions of one service hit a limit at once, one of them on screen: the other is handed off, the one on screen is held, and each is closed once', async () => {
  const options: Parameters<typeof world>[0] = {
    panes: [
      { terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' },
      { terminalId: 't2', agent: 'claude', state: 'done', sessionId: 's2' }
    ],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT, t2: fx.CLAUDE_SESSION_LIMIT },
    activeTerminals: ['t1'],
    focusedTerminals: ['t1']
  }
  const w = world(options)
  const worker = await w.mount()
  w.advance(301_000)
  // Both events and a tick in the same moment.
  await Promise.all([
    worker.emit('agent.status.changed', { ...statusEvent('t1'), sessionId: 's1' }),
    worker.emit('agent.status.changed', { ...statusEvent('t2'), sessionId: 's2' }),
    w.rotator.tick()
  ])
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.deepEqual(closed(w), ['t2'])
  assert.deepEqual(w.rotator.snapshot().waiting.map((x) => [x.terminalId, x.asked]), [['t1', true]])
  // The same events again, and ticks, while it is held: nothing more.
  await Promise.all([worker.emit('agent.status.changed', { ...statusEvent('t1', 'done', 2), sessionId: 's1' }), w.rotator.tick(), w.rotator.tick()])
  assert.deepEqual(closed(w), ['t2'])
  // Another tab is shown: the held session follows, onto the account already selected.
  options.activeTerminals = []
  options.focusedTerminals = []
  await Promise.all([w.rotator.tick(), w.rotator.tick()])
  assert.deepEqual(closed(w), ['t2', 't1'])
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.deepEqual(w.acts.filter((a) => a.kind === 'resume').map((a) => a.sessionId), ['s2', 's1'])
  assert.deepEqual(w.rotator.snapshot().waiting, [])
  checkActs(w, false, 'two at once')
  await worker.deactivate()
})

test('a session is handed off while another of the same service waits over text that cannot go along, with ticks in the seconds that takes: the waiting one is never closed', async () => {
  const drafts: Record<string, string> = { t2: '[Image #1] what is wrong here?' }
  const ticks: Promise<void>[] = []
  let w!: ReturnType<typeof world>
  w = world({
    panes: [
      { terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' },
      { terminalId: 't2', agent: 'claude', state: 'done', sessionId: 's2' }
    ],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT, t2: fx.CLAUDE_SESSION_LIMIT },
    drafts,
    settings: { restore_unsent_text: true },
    // Each wait of the hand-off (the last look, the resumed pane getting ready) lets a tick in.
    onSleep: () => {
      if (ticks.length < 6) ticks.push(w.rotator.tick())
    }
  })
  const worker = await w.mount()
  await Promise.all([
    worker.emit('agent.status.changed', { ...statusEvent('t2'), sessionId: 's2' }),
    worker.emit('agent.status.changed', { ...statusEvent('t1'), sessionId: 's1' })
  ])
  await Promise.all(ticks)
  await w.rotator.tick()
  assert.deepEqual(closed(w), ['t1'])
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.ok(w.rotator.snapshot().waiting.find((x) => x.terminalId === 't2')?.draftAt, JSON.stringify(w.rotator.snapshot().waiting))
  // One notice for the waiting session, however many looks there were.
  assert.equal(bodies(w).filter((b) => /Send or clear the text you were typing/.test(b)).length, 1, bodies(w).join(' | '))
  // The text is sent or cleared: now it follows, once.
  delete drafts.t2
  await Promise.all([w.rotator.tick(), w.rotator.tick()])
  assert.deepEqual(closed(w), ['t1', 't2'])
  assert.deepEqual(w.acts.filter((a) => a.kind === 'resume').map((a) => a.sessionId), ['s1', 's2'])
  checkActs(w, true, 'one moves, one waits')
  await worker.deactivate()
})

test('Skip on every other account (Custom order too), or on all of them: a limit selects nothing and closes nothing; the session goes on where it is once its own account resets', async () => {
  for (const exclude of ['claude:c2, claude:c3', 'claude:c1, claude:c2, claude:c3', 'claude:*']) {
    for (const pick of ['smart', 'my-order']) {
      const w = world({
        panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
        tails: { t1: fx.CLAUDE_LIMIT_NO_RESET },
        settings: { exclude, pick, ...(pick === 'my-order' ? { chain: 'claude:c3, claude:c2, claude:c1' } : {}) }
      })
      const where = `${pick}, Skip ${exclude}`
      const worker = await w.mount()
      await worker.emit('agent.status.changed', statusEvent('t1'))
      await w.rotator.tick()
      assert.equal(w.acts.length, 0, where)
      assert.equal(stored(w).waiting.length, 1, where)
      w.advance(61 * MIN)
      await w.rotator.tick()
      assert.deepEqual(w.acts.map((a) => [a.kind, a.terminalId, a.text]), [['type', 't1', 'Continue.']], where)
      assert.equal(stored(w).waiting.length, 0, where)
      checkActs(w, false, where)
      await worker.deactivate()
    }
  }
  // With "When everything is used up: Stop" it is said, and the session is left as it is.
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_LIMIT_NO_RESET },
    settings: { exclude: 'claude:*', when_all_used: 'stop' }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  w.advance(61 * MIN)
  await w.rotator.tick()
  assert.equal(w.acts.length, 0, JSON.stringify(w.acts))
  assert.equal(stored(w).waiting.length, 0)
  assert.equal(bodies(w).filter((b) => /set to Stop/.test(b)).length, 1, bodies(w).join(' | '))
  await worker.deactivate()
})

/** `orca account list` with one Claude account only, and no login of Claude's own. */
const onlyOne = (list: Record<string, any>) => ({ ...list, claude: { ...list.claude, accounts: list.claude.accounts.slice(0, 1), systemDefaultHome: null, systemDefaultEmail: null } })

test('one account only: a limit selects nothing, closes nothing and never goes to another service; the session waits and goes on there', async () => {
  const w = world({
    panes: [
      { terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' },
      { terminalId: 't9', agent: 'codex', state: 'done', sessionId: 'cs9' }
    ],
    tails: { t1: fx.CLAUDE_LIMIT_NO_RESET, t9: ['• Edited src/app.ts (+4 -1)', '', '› Ask Codex to do anything'] },
    codexUsage: { session: 5, weekly: 5 },
    accounts: onlyOne
  })
  const worker = await w.mount()
  assert.deepEqual(w.rotator.snapshot().seats.filter((s) => s.provider === 'claude').map((s) => s.key), ['claude:c1'])
  await worker.emit('agent.status.changed', statusEvent('t1'))
  await w.rotator.tick()
  assert.equal(w.acts.length, 0, JSON.stringify(w.acts))
  assert.equal(stored(w).waiting[0]?.terminalId, 't1')
  assert.ok(bodies(w).some((b) => /Claude: every account is used up\. The session continues at /.test(b)), bodies(w).join(' | '))
  w.advance(61 * MIN)
  await w.rotator.tick()
  assert.deepEqual(w.acts.map((a) => [a.kind, a.terminalId]), [['type', 't1']])
  checkActs(w, false, 'one account')
  await worker.deactivate()
})

test('the account a session runs on is removed from Orca: its limit hands it off to an account that is still there, of the same service', async () => {
  let gone = false
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    state: { paneSeat: { t1: 'claude:c1' } },
    // c1 is removed; Orca then has c2 selected.
    accounts: (list) => (gone ? { ...list, claude: { ...list.claude, accounts: list.claude.accounts.filter((a: any) => a.id !== 'c1'), activeAccountId: 'c2' } } : list)
  })
  const worker = await w.mount()
  gone = true
  await w.rotator.tick()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(closed(w), ['t1'])
  const moved = stored(w).history.at(-1)
  assert.equal(moved?.result, 'resumed')
  assert.ok(moved?.to === 'claude:c2' || moved?.to === 'claude:c3', JSON.stringify(moved))
  assert.ok(selects(w).every((c) => !c.endsWith(' c1') && c.startsWith('select claude ')), selects(w).join(','))
  // Nothing is remembered against an account that is not there.
  assert.equal(stored(w).health['claude:c1'], undefined)
  checkActs(w, false, 'account removed')
  await worker.deactivate()
})

test('a waiting session whose own account is removed from Orca meanwhile is handed off to one that is there when it frees up', async () => {
  let gone = false
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    state: { health: { 'claude:c2': { cooldownUntil: 1_000_000 + 10 * MIN }, 'claude:c3': { cooldownUntil: 1_000_000 + 20 * MIN } } },
    accounts: (list) => (gone ? { ...list, claude: { ...list.claude, accounts: list.claude.accounts.filter((a: any) => a.id !== 'c1'), activeAccountId: null, systemDefaultHome: null } } : list)
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.equal(stored(w).waiting[0]?.fromSeat, 'claude:c1')
  gone = true
  w.advance(5 * MIN)
  await w.rotator.tick()
  assert.equal(w.acts.length, 0, JSON.stringify(w.acts))
  w.advance(6 * MIN)
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.deepEqual(closed(w), ['t1'])
  checkActs(w, false, 'own account removed while waiting')
  await worker.deactivate()
})

test('an account list that is empty or broken is never taken for "no accounts": nothing is forgotten, nothing odd is selected, and the tick goes on', async () => {
  const broken: unknown[] = [
    null,
    undefined,
    {},
    [],
    'not json at all',
    42,
    { claude: 'x', codex: 7 },
    { rateLimits: { claude: { status: 'ok' } } }
  ]
  for (const answer of broken) {
    let bad = false
    const w = world({
      panes: [{ terminalId: 't1', agent: 'claude', state: 'working', sessionId: 's1' }],
      tails: { t1: fx.CLAUDE_SESSION_LIMIT },
      claudeUsage: { session: 50, weekly: 20 },
      inactiveClaude: { c2: { session: 5, weekly: 5 } },
      state: { leftLow: { 'claude:c2': { at: 1_000_000 - 1000, until: 1_000_000 + 4 * 60 * MIN } }, health: { 'claude:c3': { cooldownUntil: 1_000_000 + 60 * MIN } } },
      accounts: (list) => (bad ? answer : list)
    })
    const what = JSON.stringify(answer) ?? 'undefined'
    const worker = await w.mount()
    const before = JSON.stringify(w.host.data().storage['usage-samples'])
    assert.ok(before && before.includes('claude:c1'), what)
    bad = true
    w.advance(2 * MIN)
    await w.rotator.tick()
    await worker.request('rotator.snapshot', { refresh: true })
    const snap = w.rotator.snapshot()
    // The accounts as last read stay, with the reason said; what is known about them stays too.
    assert.deepEqual(snap.seats.filter((s) => s.provider === 'claude').map((s) => s.key), ['claude:c1', 'claude:c2', 'claude:c3'], what)
    assert.match(snap.error ?? '', /orca account list failed/, what)
    assert.equal(JSON.stringify(w.host.data().storage['usage-samples']), before, what)
    assert.ok(stored(w).leftLow?.['claude:c2'], what)
    assert.equal(w.acts.length, 0, what)
    // The answer is good again: the error goes.
    bad = false
    await worker.request('rotator.snapshot', { refresh: true })
    assert.equal(w.rotator.snapshot().error, undefined, what)
    await worker.deactivate()
  }
})

test('an account list with broken rows: only accounts that have an id become accounts, names are text, and a limit is handed off to one of them', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    settings: { pick: 'my-order', chain: 'claude:c2, claude:c1', exclude: 'nobody@example.test' },
    accounts: (list) => ({
      ...list,
      claude: {
        ...list.claude,
        accounts: [null, 7, 'c9', { email: 'no-id@example.test' }, { id: null }, { id: '' }, { id: 42 }, list.claude.accounts[0], { id: 'c2', email: { odd: true } }]
      },
      rateLimits: { ...list.rateLimits, inactiveClaudeAccounts: [null, 'x', { accountId: 'c2', rateLimits: 'broken' }] }
    })
  })
  const worker = await w.mount()
  const claude = w.rotator.snapshot().seats.filter((s) => s.provider === 'claude')
  assert.deepEqual(claude.map((s) => [s.key, s.label]), [['claude:c1', 'one@example.test'], ['claude:c2', 'c2'], ['claude:system', 'system (me@example.test)']])
  await worker.emit('agent.status.changed', statusEvent('t1'))
  await w.rotator.tick()
  // (Neither has numbers, so they are tried in turn: the one after c1 in the order.)
  assert.deepEqual(selects(w), ['select claude system'])
  assert.deepEqual(closed(w), ['t1'])
  checkActs(w, false, 'broken rows')
  await worker.deactivate()
})

test('a paired server that cannot be reached: a limit in a session there selects no account of this computer and closes nothing; it is handed off there once the server answers', async () => {
  let down = false
  const w = twoServers({
    panes: [{ terminalId: 'tr1', agent: 'claude', state: 'done', sessionId: 'sr1', ws: 'w-remote' }],
    tails: { tr1: [...fx.CLAUDE_SESSION_LIMIT] },
    onList: async (server) => {
      if (server && down) throw new Error('remote-box is unreachable')
    }
  })
  const worker = await w.mount()
  down = true
  await worker.emit('agent.status.changed', w.event('tr1', 'w-remote'))
  await w.rotator.tick()
  assert.deepEqual(selects(w), [], 'nothing is selected, here or there')
  assert.equal(w.host.callsOf('terminal.close').length, 0)
  assert.equal(stored(w).waiting[0]?.server, 'remote-box')
  down = false
  w.advance(2 * MIN)
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select@remote-box claude c2'])
  assert.deepEqual(w.host.callsOf('agent.resume'), [{ workspaceId: 'w-remote', agent: 'claude', sessionId: 'sr1' }])
  await worker.deactivate()
})

test('session on screen: leaving it and coming back during the countdown is a sign of you, so the countdown does not hand it off; it starts again once you are away', async () => {
  const { w, options } = onTab({
    panes: [
      { terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' },
      { terminalId: 't2', agent: 'claude', state: 'working', sessionId: 's2' }
    ],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT, t2: ['⏺ Working on it…'] }
  })
  const worker = await w.mount()
  w.advance(301_000)
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.ok(w.rotator.snapshot().waiting[0]?.countdownUntil)
  // Ten seconds in, the other tab is looked at for a moment (a panel poll sees it), then this one again.
  w.advance(10_000)
  options.activeTerminals = ['t2']
  options.focusedTerminals = ['t2']
  await worker.request('rotator.snapshot', {})
  options.activeTerminals = ['t1']
  options.focusedTerminals = ['t1']
  await worker.request('rotator.snapshot', {})
  // The countdown's time comes: not handed off.
  w.advance(55_000)
  await w.rotator.tick()
  assert.deepEqual(w.acts.filter((a) => a.kind !== 'select'), [])
  assert.equal(w.rotator.snapshot().waiting[0]?.countdownUntil, undefined)
  // No sign of you for five minutes: a new countdown, and then it goes.
  w.advance(301_000)
  await w.rotator.tick()
  assert.ok(w.rotator.snapshot().waiting[0]?.countdownUntil, JSON.stringify(w.rotator.snapshot().waiting))
  assert.deepEqual(closed(w), [])
  w.advance(61_000)
  await w.rotator.tick()
  assert.deepEqual(closed(w), ['t1'])
  checkActs(w, false, 'back during the countdown')
  await worker.deactivate()
})

test('settings changed while a session on screen is held: Session on screen and Skip count from the next look on', async () => {
  const { w } = onTab()
  const worker = await w.mount()
  w.advance(301_000)
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.ok(w.rotator.snapshot().waiting[0]?.countdownUntil)
  // (Using the panel is a sign of you; these changes are made in Orca's own settings.)
  await w.set('active_terminal', 'wait')
  w.advance(61_000)
  await w.rotator.tick()
  assert.deepEqual(closed(w), [], '"Wait for me": the countdown that ran is not acted on')
  assert.equal(w.rotator.snapshot().waiting[0]?.countdownUntil, undefined)
  // The account it was going to is set to Skip, then "Move right away": it goes to another one.
  await w.set('exclude', 'claude:c2')
  await w.set('active_terminal', 'now')
  await w.rotator.tick()
  assert.deepEqual(closed(w), ['t1'])
  assert.equal(stored(w).history.at(-1)?.to, 'claude:c3')
  assert.ok(!selects(w).includes('select claude c2'), selects(w).join(','))
  checkActs(w, false, 'settings changed while held')
  await worker.deactivate()
})

test('Skip turned on for the account a session is being handed off to, in the seconds that takes: not handed off there; the next tick takes another account', async () => {
  let w!: ReturnType<typeof world>
  let skipped = false
  w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    onSleep: (ms) => {
      // The last look's pause, a second before the session would be closed.
      if (ms !== 1000 || skipped) return
      skipped = true
      return w.set('exclude', 'claude:c2') as unknown as void
    }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(closed(w), [], 'not closed for an account that is now one to Skip')
  assert.equal(stored(w).waiting.length, 1)
  await w.rotator.tick()
  assert.deepEqual(closed(w), ['t1'])
  assert.equal(stored(w).history.at(-1)?.to, 'claude:c3')
  assert.equal(stored(w).paneSeat.t2, 'claude:c3')
  checkActs(w, false, 'Skip in the last second')
  await worker.deactivate()
})

test('very long unsent text: up to 4000 characters it goes along whole; longer, the session is kept where it is and nothing large is stored or said', async () => {
  const exact = `first line\n${'é'.repeat(4000 - 11)}`
  assert.equal(exact.length, 4000)
  const fits = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    drafts: { t1: exact },
    settings: { restore_unsent_text: true }
  })
  const a = await fits.mount()
  await a.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(closed(fits), ['t1'])
  assert.equal(fits.acts.find((x) => x.kind === 'paste')?.text, `\u001b[200~${exact}\u001b[201~`)
  checkActs(fits, true, '4000 characters')
  await a.deactivate()

  for (const text of [`${exact}!`, 'x'.repeat(300_000)]) {
    const w = world({
      panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
      tails: { t1: fx.CLAUDE_SESSION_LIMIT },
      drafts: { t1: text },
      settings: { restore_unsent_text: true }
    })
    const worker = await w.mount()
    await worker.emit('agent.status.changed', statusEvent('t1'))
    await w.rotator.tick()
    assert.deepEqual(closed(w), [], `${text.length} characters`)
    assert.ok(stored(w).waiting[0]?.draftAt)
    assert.ok(bodies(w).some((b) => /Send or clear the text you were typing/.test(b)), bodies(w).join(' | '))
    assert.ok(JSON.stringify(stored(w)).length < 20_000, 'the text is not stored')
    // By hand the panel asks first, as for a pasted image: the text comes back to be shown.
    const asked = await worker.request('rotator.switchTo', { seatKey: 'claude:c2' })
    assert.deepEqual(closed(w), [])
    assert.equal(w.rotator.snapshot().waiting.length, 1)
    assert.ok(asked.draft === undefined || asked.draft.text.length === text.length)
    checkActs(w, true, `${text.length} characters`)
    await worker.deactivate()
  }
})

test('unsent text with emoji, other scripts, quotes, backslashes and shell syntax goes along exactly as typed; text that holds an escape sequence does not go along', async () => {
  const text = '修正 parser 🐛 — “quotes” \'single\' "double" \\n \\ $(rm -rf ~) `id` ${HOME} %s --enter\n第二行 👩‍👩‍👧 ✅'
  const label = '二號 🐙 "work" $(id) \\@example.test'
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    drafts: { t1: text },
    settings: { restore_unsent_text: true },
    // Outside the focused workspace: everything goes through the `orca` CLI.
    refuseHostSend: true,
    accounts: (list) => ({ ...list, claude: { ...list.claude, accounts: list.claude.accounts.map((a: any) => (a.id === 'c2' ? { ...a, email: label } : a)) } })
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(closed(w), ['t1'])
  assert.deepEqual(w.typed.map((t) => t.text), ['Continue.', `\u001b[200~${text}\u001b[201~`])
  // (The panel's short name: the part before the @.)
  assert.ok(bodies(w).some((b) => b.includes(`handed off to ${label.split('@')[0]}.`) && b.includes('Your unsent text was put back')), bodies(w).join(' | '))
  assert.equal(stored(w).history.at(-1)?.to, 'claude:c2')
  checkActs(w, true, 'unicode')
  await worker.deactivate()

  // A notification never ends in half an emoji.
  const cutAt = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    drafts: { t1: `${'x'.repeat(78)}🐛🐛🐛 and more` },
    settings: { restore_unsent_text: true }
  })
  const c = await cutAt.mount()
  await c.emit('agent.status.changed', statusEvent('t1'))
  for (const b of bodies(cutAt)) assert.equal(/[\ud800-\udbff](?![\udc00-\udfff])/.test(b), false, b)
  assert.ok(bodies(cutAt).some((b) => b.includes(`“${'x'.repeat(78)}…”`)), bodies(cutAt).join(' | '))
  await c.deactivate()

  // The end-of-paste mark inside the text would end the paste early; the line after it would be sent.
  for (const odd of ['harmless\u001b[201~\nrm -rf build', 'escape \u001b[2J']) {
    const held = world({
      panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
      tails: { t1: fx.CLAUDE_SESSION_LIMIT },
      drafts: { t1: odd },
      settings: { restore_unsent_text: true }
    })
    const h = await held.mount()
    await h.emit('agent.status.changed', statusEvent('t1'))
    assert.equal(held.acts.length, 0, JSON.stringify(odd))
    assert.ok(held.rotator.snapshot().waiting[0]?.draftAt, JSON.stringify(odd))
    await h.deactivate()
  }
})

test('the same status event many times over, with ticks in between: one hand-off, one first message', async () => {
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    redraw: true
  })
  const worker = await w.mount()
  const burst = (from: number) =>
    Promise.all([
      ...Array.from({ length: 25 }, (_, i) => worker.emit('agent.status.changed', { ...statusEvent('t1', i % 2 ? 'done' : 'waiting', from + i), sessionId: 's1' })),
      w.rotator.tick(),
      w.rotator.tick(),
      w.rotator.tick()
    ])
  await burst(1)
  // The resumed pane redraws the old banner, and events for both panes keep coming.
  await burst(100)
  await Promise.all(Array.from({ length: 10 }, (_, i) => worker.emit('agent.status.changed', { ...statusEvent('t2', 'done', 200 + i), sessionId: 's1' })))
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.deepEqual(closed(w), ['t1'])
  assert.deepEqual(w.typed, [{ terminalId: 't2', text: 'Continue.' }])
  assert.equal(stored(w).history.filter((h) => h.result === 'resumed').length, 1)
  assert.equal(bodies(w).length, 1, bodies(w).join(' | '))
  checkActs(w, false, 'event burst')
  await worker.deactivate()
})

test('safety, in 400 harder made-up situations: Skip, an account list that changes or breaks, settings changed while sessions wait, odd and long unsent text, and events and ticks at the same moment', async () => {
  const done: Record<string, number> = {}
  // (More of them, or others, when looking for trouble: HANDOFF_SEEDS=20000 HANDOFF_SEED_FROM=1 orca plugin test)
  const from = Number(process.env.HANDOFF_SEED_FROM ?? 1)
  const count = Number(process.env.HANDOFF_SEEDS ?? 400)
  for (let seed = from; seed < from + count; seed++) for (const a of await madeUp(seed, true)) done[a.kind] = (done[a.kind] ?? 0) + 1
  for (const kind of ['select', 'close', 'resume', 'launch', 'type', 'paste']) assert.ok((done[kind] ?? 0) >= 10, `only ${done[kind] ?? 0} × ${kind}: ${JSON.stringify(done)}`)
})

test('a waiting session shows a new limit just as the tick comes for it: it is handed off once, not twice (no second session is started)', async () => {
  for (const agent of ['codex', 'claude'] as const) {
    const from = agent === 'codex' ? 'codex:x1' : 'claude:c1'
    const w = world({
      panes: [{ terminalId: 't1', agent, state: 'done', sessionId: 's1' }],
      tails: { t1: agent === 'codex' ? fx.CODEX_USAGE_LIMIT : fx.CLAUDE_SESSION_LIMIT },
      // It waited (for unsent text that is gone now), and its time has come.
      state: { paneSeat: { t1: from }, waiting: [{ terminalId: 't1', workspaceId: 'w1', agent, sessionId: 's1', fromSeat: from, wakeAt: 1_000_000 - 1000, reason: 'rate_limit' }] }
    })
    const worker = await w.mount()
    // The tick's look and the event's are both under way; one waits for the other.
    await Promise.all([w.rotator.tick(), worker.emit('agent.status.changed', { ...statusEvent('t1'), sessionId: 's1' }), w.rotator.tick()])
    assert.deepEqual(closed(w), ['t1'], agent)
    assert.equal(w.acts.filter((a) => a.kind === 'launch' || a.kind === 'resume').length, 1, `${agent}: ${JSON.stringify(w.acts)}`)
    assert.equal(selects(w).length, 1, agent)
    assert.equal(stored(w).history.filter((h) => h.result === 'failed').length, 0, agent)
    assert.equal(bodies(w).length, 1, bodies(w).join(' | '))
    checkActs(w, false, `waiting and limited at once (${agent})`)
    await worker.deactivate()
  }
})

test('a state that has grown for months still fits what Orca stores, and its History what the panel is sent; the newest entries and every waiting session stay', async () => {
  const why = 'one hit its 5-hour limit and two had the most room left at the pace it is being used; '.repeat(3).slice(0, 240)
  const history = Array.from({ length: 1000 }, (_, i) => ({
    at: 1_000_000 - (1000 - i) * 1000,
    provider: 'claude' as const,
    terminalId: `terminal-0000-${i}`,
    reason: 'rate_limit' as const,
    result: 'resumed' as const,
    from: 'claude:00000000-0000-4000-8000-000000000001',
    to: 'claude:00000000-0000-4000-8000-000000000002',
    why,
    ...(i % 100 === 99 ? { unsent: `第${i}段 ${'文字'.repeat(1500)}` } : {})
  }))
  const banner = (n: number) => ({ fingerprint: `rate_limit:5-hour limit reached ∙ resets ${n}pm`, occurrences: 1, line: `  ⎿  5-hour limit reached ∙ resets ${n}pm` })
  const seen = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`session:00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, { ...banner(0), earlier: Array.from({ length: 12 }, (_, n) => banner(n + 1)) }]))
  const waiting = [{ terminalId: 't1', workspaceId: 'w1', agent: 'claude' as const, sessionId: 's1', fromSeat: 'claude:c1', wakeAt: 1_000_000 + 60 * MIN }]
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    state: { history, seen, waiting, health: { 'claude:c2': { cooldownUntil: 1_000_000 + 60 * MIN }, 'claude:c3': { cooldownUntil: 1_000_000 + 60 * MIN } } }
  })
  const worker = await w.mount()
  const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length
  assert.ok(bytes({ state: { history, seen, waiting } }) > 1024 * 1024, 'as loaded it is far over')
  // Any change is stored (here: pausing and resuming).
  await worker.request('rotator.pause', { paused: true })
  await worker.request('rotator.pause', { paused: false })
  const state = stored(w)
  assert.ok(bytes(state) <= ORCA_VALUE_MAX_BYTES, `${bytes(state)} bytes stored`)
  assert.deepEqual(state.waiting, waiting)
  assert.equal(state.history.at(-1)?.terminalId, 'terminal-0000-999')
  assert.ok(state.history.length >= 20)
  // The panel is sent less than a message may hold, newest entries first to stay, with their unsent text whole.
  const snap = await worker.request('rotator.snapshot', {})
  assert.ok(bytes(snap) <= 64 * 1024, `${bytes(snap)} bytes sent`)
  assert.equal(snap.history.at(-1)?.terminalId, 'terminal-0000-999')
  assert.equal(snap.history.at(-1)?.unsent, history.at(-1)!.unsent)
  assert.ok(snap.history.length >= 10, `${snap.history.length} entries`)
  // And it still works: the waiting session is looked at, and a limit is handled.
  await w.rotator.tick()
  assert.equal(stored(w).waiting.length, 1)
  await worker.deactivate()
})

test('a session that is open in two panes is not closed at a limit: Orca would not resume it while the other pane runs it', async () => {
  const w = world({
    panes: [
      { terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' },
      { terminalId: 't2', agent: 'claude', state: 'working', sessionId: 's1' }
    ],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT, t2: ['⏺ Working on it…'] },
    state: { paneSeat: { t1: 'claude:c1', t2: 'claude:c1' } }
  })
  const worker = await w.mount()
  await worker.emit('agent.status.changed', { ...statusEvent('t1'), sessionId: 's1' })
  await w.rotator.tick()
  assert.deepEqual(closed(w), [])
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  assert.equal(stored(w).history.filter((h) => h.result === 'failed').length, 0)
  checkActs(w, false, 'one session, two panes')
  await worker.deactivate()
})

// ---- review round 10 ---------------------------------------------------------------------------

/** The test world's one workspace, with Orca unable to list the workspaces while `down()` says so. */
function workspacesDown(w: ReturnType<typeof world>, down: () => boolean): void {
  const listed = { workspaces: [{ id: 'w1', kind: 'worktree', name: 'w1', path: '/repo', branch: 'feat/x', hostId: 'local' }], truncated: false }
  w.host.respond('workspace.list', () => {
    if (down()) throw Object.assign(new Error('runtime_unavailable'), { code: 'action_failed' })
    return listed
  })
}

test('fail closed, then looked at again: a limit that came while Orca could not say where the workspace runs is handed off at the first tick after Orca answers, once', async () => {
  const w = limitedClaude()
  const worker = await w.mount()
  let down = true
  workspacesDown(w, () => down)
  // No further event comes from a session that sits at its limit: this one is all there is.
  await worker.emit('agent.status.changed', { ...statusEvent('t1'), sessionId: 's1' })
  assert.deepEqual(selects(w), [], 'nothing is selected while nobody knows where the session runs')
  assert.deepEqual(closed(w), [])
  // Still down at the next tick: still left alone, and still remembered.
  await w.rotator.tick()
  assert.deepEqual(closed(w), [])
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  // Orca answers again: the tick looks at the session, and hands it off.
  down = false
  await w.rotator.tick()
  assert.deepEqual(selects(w), ['select claude c2'])
  assert.deepEqual(closed(w), ['t1'])
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  // Once: later ticks have nothing left to look at.
  await w.rotator.tick()
  await w.rotator.tick()
  assert.equal(w.host.callsOf('agent.resume').length, 1)
  assert.deepEqual(selects(w), ['select claude c2'])
  checkActs(w, false, 'placed late')
  await worker.deactivate()
})

test('fail closed, then looked at again: not when the user went on in the session meanwhile, and paused it is only noted', async () => {
  // The user sends a prompt before Orca answers: the turn that runs is never closed.
  const w = limitedClaude()
  let worker = await w.mount()
  let down = true
  workspacesDown(w, () => down)
  await worker.emit('agent.status.changed', { ...statusEvent('t1'), sessionId: 's1' })
  w.panes[0]!.state = 'working'
  await worker.emit('agent.status.changed', { ...statusEvent('t1'), state: 'working', sessionId: 's1' } as never)
  down = false
  await w.rotator.tick()
  // (The account for new sessions may change, as for any account that is used up while a turn
  // runs on it; the session itself is not touched.)
  assert.deepEqual(closed(w), [])
  assert.equal(w.host.callsOf('agent.resume').length, 0)
  assert.equal(stored(w).waiting.length, 0)
  await worker.deactivate()

  // Paused before Orca answers: the banner is noted, nothing is handed off, and turning
  // automatic hand-off on again does not act on it either.
  const p = limitedClaude()
  worker = await p.mount()
  down = true
  workspacesDown(p, () => down)
  await worker.emit('agent.status.changed', { ...statusEvent('t1'), sessionId: 's1' })
  await worker.request('rotator.pause', { paused: true })
  down = false
  await p.rotator.tick()
  assert.deepEqual(closed(p), [])
  assert.equal(Object.keys(stored(p).seen).length, 1, 'noted')
  await worker.request('rotator.pause', { paused: false })
  await p.rotator.tick()
  assert.deepEqual(closed(p), [])
  assert.deepEqual(selects(p), [])
  await worker.deactivate()
})

test('unsent text kept in History stays when the History is cut to size, in what is stored and in what the panel is sent', async () => {
  const text = (i: number) => `draft ${i}: ${'please keep this '.repeat(200)}`
  const why = 'one hit its 5-hour limit and two had the most room left at the pace it is being used; '.repeat(3).slice(0, 240)
  // A busy week: 900 entries, three of the oldest with unsent text that could not be put back.
  const history = Array.from({ length: 900 }, (_, i) => ({
    at: 1_000_000 - (900 - i) * 1000,
    provider: 'claude' as const,
    terminalId: `terminal-0000-${i}`,
    reason: 'rate_limit' as const,
    result: 'resumed' as const,
    from: 'claude:00000000-0000-4000-8000-000000000001',
    to: 'claude:00000000-0000-4000-8000-000000000002',
    why,
    ...(i === 3 || i === 40 || i === 300 ? { unsent: text(i) } : {})
  }))
  const w = world({ panes: [], tails: {}, state: { history } })
  const worker = await w.mount()
  const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length
  assert.ok(bytes({ history }) > ORCA_VALUE_MAX_BYTES, 'as loaded it is over what Orca stores')
  await worker.request('rotator.pause', { paused: true })
  const state = stored(w)
  assert.ok(bytes(state) <= ORCA_VALUE_MAX_BYTES, `${bytes(state)} bytes stored`)
  assert.ok(state.history.length < 900, 'older entries went')
  assert.deepEqual(state.history.filter((h) => h.unsent).map((h) => h.unsent), [text(3), text(40), text(300)], 'none of the unsent text went with them, and none was shortened')
  assert.equal(state.history.at(-1)?.terminalId, 'terminal-0000-899')
  // The panel: the newest entries, and the unsent text although over a hundred entries came after it.
  const snap = await worker.request('rotator.snapshot', {})
  assert.ok(bytes(snap) <= 64 * 1024, `${bytes(snap)} bytes sent`)
  assert.equal(snap.history.at(-1)?.terminalId, 'terminal-0000-899')
  assert.deepEqual(snap.history.filter((h) => h.unsent).map((h) => h.unsent), [text(3), text(40), text(300)])
  assert.ok(snap.history.length >= 30, `${snap.history.length} entries`)
  assert.deepEqual(snap.history.map((h) => h.at), [...snap.history.map((h) => h.at)].sort((a, b) => a - b), 'in the order they happened')
  await worker.deactivate()
})

test('session on screen, Not now pressed twice: the answer is written once', async () => {
  const { w } = onTab({ settings: { active_terminal: 'ask' } })
  const worker = await w.mount()
  w.advance(301_000)
  await worker.emit('agent.status.changed', statusEvent('t1'))
  const deps = (w.rotator as unknown as { deps: { saveState(state: RotatorState): Promise<void> } }).deps
  const save = deps.saveState
  let saves = 0
  deps.saveState = async (state) => {
    saves++
    await save(state)
  }
  await worker.request('rotator.declineHandoff', { terminalId: 't1' })
  assert.equal(saves, 1)
  await worker.request('rotator.declineHandoff', { terminalId: 't1' })
  await worker.request('rotator.declineHandoff', { terminalId: 't1' })
  assert.equal(saves, 1, 'a second press changes nothing, so nothing is written')
  assert.equal(w.rotator.snapshot().waiting[0]?.declined, true)
  await worker.deactivate()
})

test('resumed and launched panes are placed in a real tab, and host focus returns to another shown terminal', async () => {
  // Background Claude pane hands off while the host window is showing another terminal `t_view`:
  // `orca terminal switch` adopts `t2` into a real tab, then switches focus right back to `t_view`.
  let currentContext = ['t_view']
  let currentActive = ['t_view']
  let worker!: Awaited<ReturnType<typeof mountWorker>>
  const w = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    focusedTerminals: currentContext,
    activeTerminals: currentActive,
    settings: { timing: 'early', away_minutes: 10 },
    onFocus: async (id) => {
      // Simulate Orca firing `workspace.changed` as focus moves during `moveTo`: must not count as the user.
      currentContext.splice(0, currentContext.length, id)
      currentActive.splice(0, currentActive.length, id)
      await worker.emit('workspace.changed', { context: { workspaceId: 'w1', branch: 'feat/x', displayName: 'w1', terminals: [{ id }] } })
    }
  })
  worker = await w.mount()
  await w.rotator.refreshFocus()
  // User has been away for 15 minutes before the hand-off.
  w.advance(15 * 60_000)
  await worker.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(
    w.cliCalls.filter((c) => c.startsWith('focus ')),
    ['focus t2', 'focus t_view']
  )
  // After the hand-off, the plugin's own focus switches must not have counted as user presence.
  assert.equal(w.rotator.snapshot().userHere, undefined)
  await worker.deactivate()

  // When the handed-off pane WAS itself shown on the host, the new pane takes its place in focus
  // and does not try to switch back to the closed pane.
  const shown = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    focusedTerminals: ['t1'],
    activeTerminals: ['t1'],
    settings: { active_terminal: 'now' }
  })
  const wShown = await shown.mount()
  await wShown.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(
    shown.cliCalls.filter((c) => c.startsWith('focus ')),
    ['focus t2']
  )
  await wShown.deactivate()

  // Summary hand-offs (`agent.launch`, e.g. Codex) also start in the background and are placed
  // in a real tab the same way, restoring focus to `t_view`.
  const codex = world({
    panes: [{ terminalId: 't1', agent: 'codex', state: 'done' }],
    tails: { t1: fx.CODEX_USAGE_LIMIT },
    focusedTerminals: ['t_view'],
    activeTerminals: ['t_view']
  })
  const wCodex = await codex.mount()
  await wCodex.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(
    codex.cliCalls.filter((c) => c.startsWith('focus ')),
    ['focus t2', 'focus t_view']
  )
  await wCodex.deactivate()
})

test('tab placement is best-effort: a switch failure never fails the hand-off or cools the target account', async () => {
  // Initial switch fails (e.g. headless server with no desktop window): no restore attempted,
  // hand-off still succeeds, first message is still sent, target account is not cooled.
  const failFirst = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    focusedTerminals: ['t_view'],
    activeTerminals: ['t_view'],
    failFocus: () => true
  })
  const wf = await failFirst.mount()
  await wf.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(
    failFirst.cliCalls.filter((c) => c.startsWith('focus ')),
    []
  )
  assert.equal(stored(failFirst).history.at(-1)?.result, 'resumed')
  assert.equal(stored(failFirst).health['claude:c2'], undefined)
  assert.ok(failFirst.typed.some((t) => t.terminalId === 't2' && t.text === 'Continue.'))
  await wf.deactivate()

  // Restore switch fails (e.g. `t_view` closed mid-handoff): `t2` was placed and hand-off still succeeds.
  const failRestore = world({
    panes: [{ terminalId: 't1', agent: 'claude', state: 'done', sessionId: 's1' }],
    tails: { t1: fx.CLAUDE_SESSION_LIMIT },
    focusedTerminals: ['t_view'],
    activeTerminals: ['t_view'],
    failFocus: (id) => id === 't_view'
  })
  const wr = await failRestore.mount()
  await wr.emit('agent.status.changed', statusEvent('t1'))
  assert.deepEqual(
    failRestore.cliCalls.filter((c) => c.startsWith('focus ')),
    ['focus t2']
  )
  assert.equal(stored(failRestore).history.at(-1)?.result, 'resumed')
  assert.equal(stored(failRestore).health['claude:c2'], undefined)
  assert.ok(failRestore.typed.some((t) => t.terminalId === 't2' && t.text === 'Continue.'))
  await wr.deactivate()
})

test('paired server hand-off passes the server to focusTerminal and never restores a local terminal handle there', async () => {
  const cliCalls: string[] = []
  let remoteActive = 'r1'
  const remotePanes: { terminalId: string; agent: string; state: 'done' | 'waiting'; sessionId: string }[] = [
    { terminalId: 'tr1', agent: 'claude', state: 'done', sessionId: 'sr1' }
  ]
  const cli: Cli = {
    async listAccounts(server) {
      cliCalls.push(server ? `list@${server}` : 'list')
      return server === 'remote-box'
        ? {
            claude: {
              accounts: [
                { id: 'r1', email: 'r1@example.com' },
                { id: 'r2', email: 'r2@example.com' }
              ],
              activeAccountId: remoteActive
            },
            rateLimits: {
              claude: {
                r1: { provider: 'claude', session: { usedPercent: 100, resetsAt: null }, weekly: { usedPercent: 20, resetsAt: null } },
                r2: { provider: 'claude', session: { usedPercent: 10, resetsAt: null }, weekly: { usedPercent: 10, resetsAt: null } }
              }
            }
          }
        : fx.accountList({ claudeActive: 'c1' })
    },
    async select(provider, accountId, server) {
      cliCalls.push(server ? `select@${server} ${provider} ${accountId}` : `select ${provider} ${accountId}`)
      if (server === 'remote-box') remoteActive = accountId
    },
    async closeTerminal(id, server) {
      cliCalls.push(server ? `close@${server} ${id}` : `close ${id}`)
      const i = remotePanes.findIndex((p) => p.terminalId === id)
      if (i >= 0) remotePanes.splice(i, 1)
    },
    async focusTerminal(id, server) {
      cliCalls.push(server ? `focus@${server} ${id}` : `focus ${id}`)
    },
    async activeTerminals(server) {
      return server === 'remote-box' ? ['tr1'] : ['t_local']
    },
    async sendText(id, _text, server) {
      cliCalls.push(server ? `send@${server} ${id}` : `send ${id}`)
    },
    async git() {
      return ''
    },
    async draft() {
      return ''
    }
  }
  const host = mockHost({
    settings: { restore_unsent_text: false, active_terminal: 'now' },
    storage: { 'migrated-manual': true as never } as never,
    results: {
      'workspace.list': {
        workspaces: [
          { id: 'w_local', kind: 'worktree', name: 'local', path: '/local', branch: 'main', hostId: 'local' },
          { id: 'w_remote', kind: 'worktree', name: 'remote', path: '/remote', branch: 'main', hostId: 'runtime:remote-box' }
        ],
        truncated: false
      },
      // Local desktop is currently showing a local terminal `t_local`.
      'workspace.readContext': () => ({ workspaceId: 'w_local', branch: 'main', displayName: 'local', terminals: [{ id: 't_local' }] }),
      'agents.list': ({ workspaceId }: { workspaceId?: string } = {}) => ({
        agents: workspaceId === 'w_remote' ? remotePanes.map((p) => ({ title: null, task: null, stateStartedAt: 1, ...p })) : []
      }),
      'terminal.read': () => ({ lines: fx.CLAUDE_SESSION_LIMIT, truncated: false }),
      'terminal.close': () => {
        throw Object.assign(new Error('outside focused workspace'), { code: 'action_failed' })
      },
      'agent.resume': ({ agent, sessionId }: { agent: string; sessionId: string }) => {
        remotePanes.push({ terminalId: 'tr2', agent, state: 'waiting', sessionId })
        return { terminalId: 'tr2', started: true }
      },
      'terminal.sendText': () => {
        throw Object.assign(new Error('outside focused workspace'), { code: 'action_failed' })
      },
      'notifications.show': { delivered: true },
      'statusBar.update': { ok: true }
    }
  })
  const worker = await mountWorker(
    { default: async (orca: OrcaWorkerApi) => { await activateWith(likeOrca(orca), { cli, now: () => 1_000_000, sleep: async () => undefined }, { tick: false }) } },
    { host }
  )
  await worker.emit('agent.status.changed', { workspaceId: 'w_remote', paneKey: 'pk', terminalId: 'tr1', state: 'done', receivedAt: 1_000_000, sessionId: 'sr1' })
  assert.deepEqual(
    cliCalls.filter((c) => c.startsWith('focus')),
    ['focus@remote-box tr2']
  )
  await worker.deactivate()
})

test('external account switch between polls keeps Orca readings fetched after the previous poll and rejects stale ones', async () => {
  let clock = 1_000_000
  let claudeActive = 'c1'
  let updatedAt = 1_000_000
  let session = 90
  const cli: Cli = {
    async listAccounts() {
      return fx.accountList({ claudeActive, claudeUsage: { session, weekly: 20 }, updatedAt })
    },
    async select() {},
    async closeTerminal() {},
    async sendText() {},
    async git() { return '' },
    async draft() { return '' }
  }
  const host = mockHost({
    settings: {},
    storage: {},
    results: { 'agents.list': { agents: [] }, 'workspace.list': { workspaces: [], truncated: false }, 'statusBar.update': { ok: true }, 'notifications.show': { delivered: true } }
  })
  let rotator!: Rotator
  const worker = await mountWorker(
    { default: async (orca: OrcaWorkerApi) => { rotator = await activateWith(likeOrca(orca), { cli, now: () => clock, sleep: async () => undefined }, { tick: false }) } },
    { host }
  )
  await rotator.accounts(true)

  // User switches to c2 in Orca UI at +10s, and Orca refreshes c2 at +11s (before next 60s poll).
  claudeActive = 'c2'
  session = 15
  updatedAt = 1_011_000
  clock = 1_060_000
  const freshView = await rotator.accounts(true)
  const c2Fresh = freshView.seats.find((s) => s.key === 'claude:c2')!.usage
  assert.equal(c2Fresh.known, true)
  assert.equal(c2Fresh.source, 'live')
  assert.equal(c2Fresh.session?.usedPercent, 15)

  // External switch to c3 where Orca still holds c2's stale timestamp (+11s) -> rejected.
  claudeActive = 'c3'
  session = 99
  updatedAt = 1_011_000
  clock = 1_120_000
  const staleView = await rotator.accounts(true)
  assert.equal(staleView.seats.find((s) => s.key === 'claude:c3')!.usage.known, false)
  await worker.deactivate()
})

test('manual refresh requests refreshUsage: true while periodic ticks keep background polling', async () => {
  const listCalls: Array<{ server?: string; refreshUsage?: boolean }> = []
  let clock = 1_000_000
  let gate: Promise<void> | undefined
  const cli: Cli = {
    async listAccounts(server, options) {
      listCalls.push({ ...(server ? { server } : {}), ...(options?.refreshUsage ? { refreshUsage: true } : {}) })
      if (!options?.refreshUsage && gate) await gate
      return fx.accountList({ updatedAt: clock })
    },
    async select() {},
    async closeTerminal() {},
    async sendText() {},
    async git() { return '' },
    async draft() { return '' }
  }
  const host = mockHost({
    settings: {},
    storage: {},
    results: { 'agents.list': { agents: [] }, 'workspace.list': { workspaces: [], truncated: false }, 'statusBar.update': { ok: true }, 'notifications.show': { delivered: true } }
  })
  let rotator!: Rotator
  const worker = await mountWorker(
    { default: async (orca: OrcaWorkerApi) => { rotator = await activateWith(likeOrca(orca), { cli, now: () => clock, sleep: async () => undefined }, { tick: false }) } },
    { host }
  )
  await rotator.accounts(true)
  listCalls.length = 0

  clock += 65_000
  await rotator.tick()
  assert.deepEqual(listCalls, [{}])

  listCalls.length = 0
  await worker.request('rotator.snapshot', { refresh: true })
  assert.deepEqual(listCalls, [{ refreshUsage: true }])

  listCalls.length = 0
  await worker.command('rotator.refresh')
  assert.deepEqual(listCalls, [{ refreshUsage: true }])

  // A manual refresh while a background read is in flight waits and still issues refreshUsage: true.
  listCalls.length = 0
  let releaseGate!: () => void
  gate = new Promise<void>((r) => (releaseGate = r))
  clock += 65_000
  const bg = rotator.tick()
  await new Promise((r) => setTimeout(r, 10))
  const manual = worker.command('rotator.refresh')
  releaseGate()
  await Promise.all([bg, manual])
  gate = undefined
  assert.deepEqual(listCalls, [{}, { refreshUsage: true }])
  await worker.deactivate()
})

test('paired server usage is cached across errors and projected past reset without colliding with local seats', async () => {
  let clock = 1_000_000
  let remoteActive = 'c1'
  let remoteOk = true
  const cli: Cli = {
    async listAccounts(server) {
      if (server === 'remote-box') {
        return {
          claude: {
            accounts: [
              { id: 'c1', email: 'remote1@example.test' },
              { id: 'c2', email: 'remote2@example.test' }
            ],
            activeAccountId: remoteActive,
            systemDefaultHome: null
          },
          rateLimits: {
            claude: remoteOk
              ? { status: 'ok', updatedAt: clock, session: { usedPercent: 60, resetsAt: 1_000_000 + 3_600_000 }, weekly: { usedPercent: 25, resetsAt: 1_000_000 + 86_400_000 } }
              : { status: 'error', error: 'Claude usage updates the next time Claude runs.', usageMetadata: { failureKind: 'stale-token' } }
          }
        }
      }
      return fx.accountList({ claudeActive: 'c1', claudeUsage: { session: 10, weekly: 5 }, updatedAt: clock })
    },
    async select() {},
    async closeTerminal() {},
    async sendText() {},
    async git() { return '' },
    async draft() { return '' }
  }
  const host = mockHost({
    settings: {},
    storage: {},
    results: {
      'workspace.list': { workspaces: [{ id: 'w-r', kind: 'worktree', name: 'r', projectId: 'p-r', path: '/srv/r', branch: 'main', hostId: 'runtime:remote-box' }], truncated: false },
      'workspace.readContext': { workspaceId: 'w-r', branch: 'main', displayName: 'r', terminals: [] },
      'agents.list': { agents: [] },
      'notifications.show': { delivered: true },
      'statusBar.update': { ok: true }
    }
  })
  const worker = await mountWorker(
    { default: async (orca: OrcaWorkerApi) => { await activateWith(likeOrca(orca), { cli, now: () => clock, sleep: async () => undefined }, { tick: false }) } },
    { host }
  )
  const first = await worker.request('rotator.snapshot', { refresh: true })
  assert.equal(first.seats.find((s) => s.key === 'claude:c1')?.usage.session?.usedPercent, 60)

  // Switch active on remote so c1 becomes inactive and stops reporting usage.
  remoteActive = 'c2'
  remoteOk = false
  clock += 10 * MIN
  const cached = await worker.request('rotator.snapshot', { refresh: true })
  const c1Cached = cached.seats.find((s) => s.key === 'claude:c1')!.usage
  assert.equal(c1Cached.source, 'cached')
  assert.equal(c1Cached.session?.usedPercent, 60)

  // Past c1's 5h reset, remote c1 projects to 0% reset.
  clock = 1_000_000 + 2 * 3_600_000
  const projected = await worker.request('rotator.snapshot', { refresh: true })
  const c1Proj = projected.seats.find((s) => s.key === 'claude:c1')!.usage
  assert.equal(c1Proj.source, 'projected')
  assert.deepEqual(c1Proj.session, { usedPercent: 0, resetsAt: null, reset: true })
  await worker.deactivate()
})
