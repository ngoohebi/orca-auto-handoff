import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { Snapshot } from './protocol'

const NOW = Date.now()

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    paused: false,
    updatedAt: NOW,
    services: { claude: true, codex: true, antigravity: true, opencode: true, devin: true },
    waiting: [],
    history: [
      { at: NOW - 60_000, provider: 'claude', reason: 'rate_limit', result: 'resumed', from: 'claude:c1', to: 'claude:c2', terminalId: 't2' }
    ],
    seats: [
      { key: 'claude:c1', provider: 'claude', accountId: 'c1', label: 'one@example.test', active: false, usage: { known: true, session: { usedPercent: 100, resetsAt: NOW + 3_600_000 }, weekly: { usedPercent: 40, resetsAt: NOW + 86_400_000 } }, cooldownUntil: NOW + 3_600_000, cooldownReason: 'rate_limit' },
      { key: 'claude:c2', provider: 'claude', accountId: 'c2', label: 'two@example.test', active: true, usage: { known: true, session: { usedPercent: 7, resetsAt: NOW + 3_600_000 }, weekly: { usedPercent: 18, resetsAt: NOW + 86_400_000 }, model: { name: 'fable', usedPercent: 19, resetsAt: NOW + 86_400_000 } } },
      { key: 'codex:x1', provider: 'codex', accountId: 'x1', label: 'plus@example.test', active: true, usage: { known: false } }
    ],
    ...over
  }
}

test('shows every seat with usage, cooldown and history; the panel never switches accounts', async () => {
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => snapshot(),
      'rotator.clearCooldown': () => ({ ok: true as const }),
      'rotator.pause': ({ paused }) => ({ paused }),
      'rotator.consoleLine': ({ enabled }) => {
        if (typeof enabled === 'boolean') lineOn = enabled
        return { installed: lineOn, workspace: 'app', ...(typeof enabled === 'boolean' ? { message: `line ${enabled ? 'on' : 'off'}` } : {}) }
      }
    }
  })
  let lineOn = false
  const view = await mount(panel, { host })
  // Full labels in the panel; windows read as % left.
  assert.ok(view.find({ text: 'one@example.test' }))
  assert.ok(view.find({ text: '93% left' }))
  assert.ok(view.find({ text: 'Fable week' }) && view.find({ text: '81% left' }))
  assert.ok(view.find({ text: 'limited' }))
  assert.ok(view.find({ text: /No usage yet/ }))
  assert.ok(!view.find({ text: /Use for new/ }))
  // The Claude console status line switch, for the focused workspace.
  assert.equal(view.valueOf({ label: 'Status line' }), false)
  await view.toggle({ label: 'Status line' })
  assert.equal(lineOn, true)
  assert.equal(view.valueOf({ label: 'Status line' }), true)
  assert.ok(view.find({ text: /line on/ }))
  await view.select({ role: 'tablist' }, 'history')
  assert.equal(view.findAll({ text: /^resumed$/ }).length, 1)
  assert.ok(view.find({ text: /one@example.test → two@example.test/ }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('an account with a known pace shows about how long it lasts; history entries say why', async () => {
  const snap = snapshot()
  snap.seats[1]!.runwayMs = 8.4 * 60_000
  snap.history[0]!.why = 'one hit a usage limit; moved to two (used 7 % of 5h, 18 % of the week)'
  const host = mockHost({ requests: { 'rotator.snapshot': () => snap, 'rotator.consoleLine': () => ({ installed: false, workspace: 'app' }) } })
  const view = await mount(panel, { host })
  // Only the account with a pace has the line.
  assert.equal(view.findAll({ text: /left at this pace/ }).length, 1)
  assert.ok(view.find({ text: 'About 8 min left at this pace' }))
  // Hours once it is long.
  await view.post('rotator.changed', { ...snap, seats: snap.seats.map((s, i) => (i === 1 ? { ...s, runwayMs: 5 * 3_600_000 } : s)) })
  assert.ok(view.find({ text: 'About 5 h left at this pace' }))
  await view.select({ role: 'tablist' }, 'history')
  assert.ok(view.find({ text: 'One hit a usage limit; moved to two (used 7 % of 5h, 18 % of the week)' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('worker pushes keep the panel current; waiting sessions are called out', async () => {
  const cancelled: string[] = []
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => snapshot(),
      'rotator.cancelWaiting': ({ terminalId }) => {
        cancelled.push(terminalId)
        return { ok: true as const }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.post('rotator.changed', snapshot({ paused: true, waiting: [{ terminalId: 't1', workspaceId: 'w1', agent: 'claude', wakeAt: NOW + 600_000 }] }))
  assert.ok(view.find({ text: /Waiting for a limit to reset/ }))
  assert.ok(view.find({ text: /Claude session resumes/ }))
  // A move that waits for unsent text says so instead of a time.
  await view.post('rotator.changed', snapshot({ paused: true, waiting: [{ terminalId: 't1', workspaceId: 'w1', agent: 'claude', wakeAt: NOW, draftAt: NOW, reason: 'rate_limit' }] }))
  assert.ok(view.find({ text: /Claude session moves once the text typed in it is sent or cleared/ }))
  assert.equal(view.findAll({ text: /session resumes/ }).length, 0)
  await view.press({ text: 'Cancel' })
  assert.deepEqual(cancelled, ['t1'])
  assert.equal(view.valueOf({ label: 'Automatic hand-off' }), false)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('empty and error states', async () => {
  const host = mockHost({ requests: { 'rotator.snapshot': () => snapshot({ seats: [], history: [], error: 'orca account list failed: not running' }) } })
  const view = await mount(panel, { host })
  const summary = view.summary().join('\n')
  assert.match(summary, /Cannot read accounts/)
  assert.match(summary, /No accounts/)
  await view.unmount()
})

test('each service with more than one account has its own auto hand-off toggle', async () => {
  const calls: { provider: string; enabled: boolean }[] = []
  const base = snapshot()
  const twoCodex: Snapshot = {
    ...base,
    seats: [...base.seats, { key: 'codex:x2', provider: 'codex', accountId: 'x2', label: 'spare@example.test', active: false, usage: { known: false } }]
  }
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => twoCodex,
      'rotator.setService': ({ provider, enabled }) => {
        calls.push({ provider, enabled })
        return { services: { claude: true, codex: enabled, antigravity: true, opencode: true, devin: true } }
      }
    }
  })
  const view = await mount(panel, { host })
  assert.equal(view.valueOf({ label: 'Auto hand-off Claude' }), true)
  await view.toggle({ label: 'Auto hand-off Codex' })
  assert.deepEqual(calls, [{ provider: 'codex', enabled: false }])
  assert.equal(view.valueOf({ label: 'Auto hand-off Codex' }), false)
  assert.equal(view.valueOf({ label: 'Auto hand-off Claude' }), true)
  assert.ok(view.find({ text: /Codex: automatic hand-off off/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('services keep Orca’s order, except the one the user is working with comes first', async () => {
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => snapshot({ focused: 'codex' }),
      'rotator.consoleLine': () => ({ installed: false })
    }
  })
  const view = await mount(panel, { host })
  assert.deepEqual(view.findAll({ text: /^(CLAUDE|CODEX)$/ }).map((n) => n.text), ['CODEX', 'CLAUDE'])
  // ...and is marked as the one behind the current terminal.
  assert.equal(view.findAll({ text: /this terminal/ }).length, 1)
})

test('accounts in a service block: in use first, then by headroom, drained and limited last', async () => {
  const host = mockHost({
    requests: {
      'rotator.snapshot': () =>
        snapshot({
          seats: [
            { key: 'claude:a', provider: 'claude', accountId: 'a', label: 'drained@example.test', active: false, usage: { known: true, session: { usedPercent: 95, resetsAt: NOW + 3_600_000 } } },
            { key: 'claude:b', provider: 'claude', accountId: 'b', label: 'half@example.test', active: false, usage: { known: true, session: { usedPercent: 50, resetsAt: NOW + 3_600_000 } } },
            { key: 'claude:c', provider: 'claude', accountId: 'c', label: 'idle@example.test', active: false, usage: { known: false } },
            { key: 'claude:d', provider: 'claude', accountId: 'd', label: 'limited@example.test', active: false, usage: { known: true, session: { usedPercent: 20, resetsAt: NOW + 3_600_000 } }, cooldownUntil: NOW + 3_600_000, cooldownReason: 'rate_limit' },
            { key: 'claude:e', provider: 'claude', accountId: 'e', label: 'fresh@example.test', active: false, usage: { known: true, session: { usedPercent: 2, resetsAt: NOW + 3_600_000 } } },
            { key: 'claude:f', provider: 'claude', accountId: 'f', label: 'active@example.test', active: true, usage: { known: true, session: { usedPercent: 80, resetsAt: NOW + 3_600_000 } } }
          ]
        }),
      'rotator.consoleLine': () => ({ installed: false })
    }
  })
  const view = await mount(panel, { host })
  assert.deepEqual(
    view.findAll({ text: /@example\.test$/ }).map((n) => n.text),
    ['active@example.test', 'fresh@example.test', 'half@example.test', 'idle@example.test', 'limited@example.test', 'drained@example.test']
  )
})

test('a service with a single account shows no auto hand-off toggle', async () => {
  const host = mockHost({ requests: { 'rotator.snapshot': () => snapshot(), 'rotator.consoleLine': () => ({ installed: false }) } })
  const view = await mount(panel, { host })
  // The fixture's Codex has one account; Claude has two.
  assert.ok(view.find({ label: 'Auto hand-off Claude' }))
  assert.ok(!view.find({ label: 'Auto hand-off Codex' }))
  assert.ok(view.find({ text: 'plus@example.test' }))
})

test('a standby offers "Hand off to this account", asks first in plain words, and the block then says automatic hand-off is off', async () => {
  const calls: string[] = []
  let auto = true
  const seats: Snapshot['seats'] = [
    { key: 'claude:a', provider: 'claude', accountId: 'a', label: 'inuse@example.test', active: true, usage: { known: true, session: { usedPercent: 50, resetsAt: NOW + 3_600_000 } } },
    { key: 'claude:b', provider: 'claude', accountId: 'b', label: 'spare@example.test', active: false, usage: { known: true, session: { usedPercent: 5, resetsAt: NOW + 3_600_000 } } }
  ]
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => snapshot({ seats, services: { claude: auto, codex: true, antigravity: true, opencode: true, devin: true } }),
      'rotator.consoleLine': () => ({ installed: false }),
      'rotator.switchTo': ({ seatKey }) => {
        calls.push(`switch ${seatKey}`)
        auto = false
        return { message: 'Claude: new launches use spare@example.test. Automatic hand-off for Claude is now off' }
      }
    }
  })
  const view = await mount(panel, { host })
  // Only the standby can be chosen; the account in use has no such button.
  assert.equal(view.findAll({ text: 'Hand off to this account' }).length, 1)
  assert.ok(!view.find({ text: /Hand off Claude to spare@example.test/ }))
  assert.ok(!view.find({ text: /Automatic hand-off for Claude is off/ }))
  await view.press({ text: 'Hand off to this account' })
  assert.ok(view.find({ text: 'Hand off Claude to spare@example.test?' }))
  assert.ok(view.find({ text: 'New Claude sessions will start on this account.' }))
  assert.ok(view.find({ text: 'The session in this tab moves too if it is idle; a busy one stays where it is.' }))
  assert.ok(view.find({ text: "Auto hand-off for Claude turns off, so it won't switch back on its own." }))
  // Cancel backs out without switching.
  await view.press({ text: 'Cancel' })
  assert.ok(!view.find({ text: /Hand off Claude to spare@example.test/ }))
  assert.deepEqual(calls, [])
  await view.press({ text: 'Hand off to this account' })
  await view.press({ text: 'Yes, hand off' })
  assert.deepEqual(calls, ['switch claude:b'])
  assert.ok(view.find({ text: /new launches use/ }))
  assert.ok(view.find({ text: /Automatic hand-off for Claude is off/ }))
  assert.equal(view.valueOf({ label: 'Auto hand-off Claude' }), false)
})

test('"Yes, hand off" on a session with unsent text asks once more, with the text; only "Hand off anyway" gives it up', async () => {
  const LONG = `please also update the docs ${'and the changelog '.repeat(8)}`.trim()
  const calls: unknown[] = []
  let shown = { terminalId: 't1', text: 'keep going' }
  let auto = true
  const seats: Snapshot['seats'] = [
    { key: 'claude:a', provider: 'claude', accountId: 'a', label: 'inuse@example.test', active: true, usage: { known: true, session: { usedPercent: 50, resetsAt: NOW + 3_600_000 } } },
    { key: 'claude:b', provider: 'claude', accountId: 'b', label: 'spare@example.test', active: false, usage: { known: true, session: { usedPercent: 5, resetsAt: NOW + 3_600_000 } } }
  ]
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => snapshot({ seats, services: { claude: auto, codex: true, antigravity: true, opencode: true, devin: true } }),
      'rotator.consoleLine': () => ({ installed: false }),
      'rotator.switchTo': (input) => {
        calls.push(input)
        // The worker moves only over exactly the text that was accepted.
        if (input.acceptDraft !== true || input.draft?.text !== shown.text) return { message: 'Claude: this session shows unsent text; nothing was switched', draft: shown }
        auto = false
        return { message: 'Claude: new launches use spare@example.test; this pane moved (resumed)' }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Hand off to this account' })
  await view.press({ text: 'Yes, hand off' })
  assert.deepEqual(calls, [{ seatKey: 'claude:b' }])
  // The second confirmation, in the same block, with the text.
  assert.ok(view.find({ text: 'This session shows unsent text: “keep going”.' }))
  assert.ok(view.find({ text: 'Hand off anyway? The text will be cleared.' }))
  assert.ok(view.find({ text: 'Hand off anyway' }))
  assert.ok(!view.find({ text: 'Yes, hand off' }))
  assert.ok(!view.find({ text: /nothing was switched/ }))
  // Cancel does nothing: no further request, and the button is back.
  await view.press({ text: 'Cancel' })
  assert.equal(calls.length, 1)
  assert.ok(!view.find({ text: /This session shows unsent text/ }))
  assert.ok(view.find({ text: 'Hand off to this account' }))
  assert.equal(view.valueOf({ label: 'Auto hand-off Claude' }), true)
  // Again; the text changes before "Hand off anyway": the worker asks again, the panel shows the new
  // text (cut to 80 characters), and nothing has moved.
  await view.press({ text: 'Hand off to this account' })
  await view.press({ text: 'Yes, hand off' })
  shown = { terminalId: 't1', text: LONG }
  await view.press({ text: 'Hand off anyway' })
  assert.deepEqual(calls.at(-1), { seatKey: 'claude:b', acceptDraft: true, draft: { terminalId: 't1', text: 'keep going' } })
  assert.ok(view.find({ text: `This session shows unsent text: “${LONG.slice(0, 80)}…”.` }))
  assert.ok(!view.find({ text: /this pane moved/ }))
  // "Hand off anyway" sends the explicit acceptance with the whole text it showed.
  await view.press({ text: 'Hand off anyway' })
  assert.deepEqual(calls.at(-1), { seatKey: 'claude:b', acceptDraft: true, draft: { terminalId: 't1', text: LONG } })
  assert.equal(calls.length, 4)
  assert.ok(view.find({ text: /this pane moved \(resumed\)/ }))
  assert.ok(!view.find({ text: /This session shows unsent text/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('the question about unsent text is dropped when the focus moves to a project on another server', async () => {
  // A paired server lists other accounts under the same keys: an answer there would be about an
  // account and a session the question never named.
  const calls: unknown[] = []
  const seats: Snapshot['seats'] = [
    { key: 'claude:a', provider: 'claude', accountId: 'a', label: 'inuse@example.test', active: true, usage: { known: true, session: { usedPercent: 50, resetsAt: NOW + 3_600_000 } } },
    { key: 'claude:b', provider: 'claude', accountId: 'b', label: 'spare@example.test', active: false, usage: { known: true, session: { usedPercent: 5, resetsAt: NOW + 3_600_000 } } }
  ]
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => snapshot({ seats }),
      'rotator.consoleLine': () => ({ installed: false }),
      'rotator.switchTo': (input) => {
        calls.push(input)
        return { message: 'Claude: this session shows unsent text; nothing was switched', draft: { terminalId: 't1', text: 'keep going' } }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Hand off to this account' })
  await view.press({ text: 'Yes, hand off' })
  assert.ok(view.find({ text: 'Hand off anyway' }))
  await view.post('rotator.changed', snapshot({ server: 'ssh:studio', seats: seats.map((s) => ({ ...s, label: `remote-${s.label}` })) }))
  assert.ok(!view.find({ text: 'Hand off anyway' }))
  assert.ok(!view.find({ text: /This session shows unsent text/ }))
  assert.ok(view.find({ text: 'Hand off to this account' }))
  // Back on this computer it is not there again either.
  await view.post('rotator.changed', snapshot({ seats }))
  assert.ok(!view.find({ text: 'Hand off anyway' }))
  assert.equal(calls.length, 1)
  await view.unmount()
})

test('a project on an SSH target: the panel says Orca manages no accounts there', async () => {
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => snapshot({ sshHost: 'build-box' }),
      'rotator.consoleLine': () => ({ installed: false })
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: /SSH target build-box/ }))
  assert.ok(view.find({ text: /Orca manages no accounts there/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

const twoClaude: Snapshot['seats'] = [
  { key: 'claude:a', provider: 'claude', accountId: 'a', label: 'inuse@example.test', active: true, usage: { known: true, session: { usedPercent: 50, resetsAt: NOW + 3_600_000 } } },
  { key: 'claude:b', provider: 'claude', accountId: 'b', label: 'spare@example.test', active: false, usage: { known: true, session: { usedPercent: 5, resetsAt: NOW + 3_600_000 } } }
]

test('"Yes, hand off" that worked says so even when the list cannot be read again; only a switch that failed says Failed', async () => {
  let reads = 0
  let refuse = false
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => {
        // The first read draws the panel; every later one fails.
        if (reads++ > 0) throw new Error('worker restarting')
        return snapshot({ seats: twoClaude })
      },
      'rotator.consoleLine': () => ({ installed: false, workspace: 'app' }),
      'rotator.switchTo': () => {
        if (refuse) throw new Error('orca account select failed')
        return { message: 'Claude: new launches use spare@example.test; this pane moved (resumed)' }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Hand off to this account' })
  await view.press({ text: 'Yes, hand off' })
  assert.equal(reads, 2)
  // The switch's own result, then the reload problem, calmly and apart from it.
  assert.ok(view.find({ text: "Claude: new launches use spare@example.test; this pane moved (resumed). Couldn't refresh the list; it updates shortly." }))
  assert.equal(view.findAll({ text: /Failed/ }).length, 0)
  assert.equal(view.findAll({ text: /worker restarting/ }).length, 0)
  // The controls work again.
  assert.equal(view.find({ text: 'Hand off to this account' })?.disabled, false)
  // A switch that itself failed is still reported as failed, with its own error.
  refuse = true
  await view.press({ text: 'Hand off to this account' })
  await view.press({ text: 'Yes, hand off' })
  assert.ok(view.find({ text: 'Failed: orca account select failed' }))
  assert.equal(view.findAll({ text: /Couldn't refresh/ }).length, 0)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('the Status line switch follows the focused workspace, and says why when it cannot be used there', async () => {
  const toggled: boolean[] = []
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => snapshot(),
      'rotator.consoleLine': ({ enabled }) => {
        if (typeof enabled === 'boolean') toggled.push(enabled)
        return { installed: true, workspace: 'app' }
      }
    }
  })
  const view = await mount(panel, { host })
  assert.equal(view.valueOf({ label: 'Status line' }), true)
  assert.equal(view.find({ label: 'Status line' })?.disabled, false)
  assert.equal(view.findAll({ text: /^Status line: / }).length, 0)
  // The user moves to a workspace without the line: the worker says so, nothing is asked again.
  await view.post('rotator.consoleLine', { installed: false, workspace: 'other' })
  assert.equal(view.valueOf({ label: 'Status line' }), false)
  assert.equal(view.find({ label: 'Status line' })?.disabled, false)
  // ...then to one on another machine: the switch is off, disabled, and one muted line says why.
  await view.post('rotator.consoleLine', { installed: false, reason: 'The focused workspace is not on this computer' })
  assert.equal(view.find({ label: 'Status line' })?.props.checked, false)
  assert.equal(view.find({ label: 'Status line' })?.disabled, true)
  const why = view.findAll({ text: 'Status line: the focused workspace is not on this computer' })
  assert.equal(why.length, 1)
  assert.equal(why[0]!.props.muted, true)
  // Back on a workspace of this computer the reason goes.
  await view.post('rotator.consoleLine', { installed: true, workspace: 'app' })
  assert.equal(view.valueOf({ label: 'Status line' }), true)
  assert.equal(view.findAll({ text: /^Status line: / }).length, 0)
  assert.deepEqual(toggled, [])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a first read that fails is not an unhandled error: the worker\u2019s next push fills the panel, Status line switch included', async () => {
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => {
        throw new Error('worker restarting')
      },
      'rotator.consoleLine': () => ({ installed: true, workspace: 'app' })
    }
  })
  const view = await mount(panel, { host })
  assert.deepEqual(view.summary(), ['Skeleton "Loading accounts"'])
  await view.post('rotator.changed', snapshot())
  assert.ok(view.find({ text: 'one@example.test' }))
  assert.equal(view.valueOf({ label: 'Status line' }), true)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('"Yes, hand off" gives the worker longer than the 30 s a request gets by default: moving the pane waits for the resumed session', async () => {
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => snapshot({ seats: twoClaude }),
      'rotator.consoleLine': () => ({ installed: false, workspace: 'app' }),
      'rotator.switchTo': () => ({ message: 'Claude: new launches use spare@example.test; this pane moved (resumed)' })
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Hand off to this account' })
  await view.press({ text: 'Yes, hand off' })
  const call = (host.callsOf('plugin.request') as { name: string; timeoutMs?: number }[]).find((c) => c.name === 'rotator.switchTo')
  // The worker closes the pane (up to 10 s) and waits for the resumed session (up to 60 s) before
  // it answers; a request that timed out would read as a failed switch that in fact worked.
  assert.ok((call?.timeoutMs ?? 30_000) >= 90_000, `timeoutMs ${call?.timeoutMs}`)
  assert.ok(view.find({ text: /this pane moved \(resumed\)/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('the focus poll asks again only after its answer, slows down while the tab stays the same, and is quick again after a change', async () => {
  // The poll's timers (the long ones the panel itself sets) are held here and fired by hand;
  // every other timer, Orca's own included, runs as usual.
  const g = globalThis as unknown as { setTimeout: (fn: () => void, ms?: number) => unknown }
  const real = g.setTimeout
  const held: { fn: () => void; ms: number }[] = []
  g.setTimeout = (fn, ms) => {
    if (typeof ms === 'number' && ms >= 3_000 && /[\\/]panel\.tsx/.test(new Error().stack ?? '')) {
      held.push({ fn, ms })
      return { unref() {} }
    }
    return real(fn, ms)
  }
  try {
    let asked = 0
    let answer: (focused: 'claude' | 'codex') => void = () => undefined
    const host = mockHost({
      requests: {
        'rotator.snapshot': () => snapshot({ focused: 'claude' }),
        'rotator.consoleLine': () => ({ installed: false, workspace: 'app' }),
        'rotator.focus': () => {
          asked++
          return new Promise<{ focused: 'claude' | 'codex' }>((resolve) => {
            answer = (focused) => resolve({ focused })
          })
        }
      }
    })
    const view = await mount(panel, { host })
    const settle = () => new Promise<void>((resolve) => real(resolve, 5))
    /** Fires the one timer the poll holds and returns how long it had asked to wait. */
    const fire = async () => {
      assert.equal(held.length, 1, `timers held: ${held.map((h) => h.ms).join(',')}`)
      const { fn, ms } = held.shift()!
      fn()
      await settle()
      return ms
    }
    assert.equal(await fire(), 3_000)
    assert.equal(asked, 1)
    // The worker has not answered (live: a CLI process per answer): nothing is asked meanwhile.
    assert.equal(held.length, 0)
    answer('claude')
    await settle()
    // Same tab as before: the next question waits longer, up to 15 s.
    const waits: number[] = []
    for (let i = 0; i < 4; i++) {
      waits.push(await fire())
      answer('claude')
      await settle()
    }
    assert.deepEqual(waits, [6_000, 12_000, 15_000, 15_000])
    assert.equal(asked, 5)
    // The user switched to a Codex tab: the panel follows, and asks quickly again.
    assert.equal(await fire(), 15_000)
    answer('codex')
    await settle()
    await view.settled()
    assert.deepEqual(view.findAll({ text: /^(CLAUDE|CODEX)$/ }).map((n) => n.text), ['CODEX', 'CLAUDE'])
    assert.equal(await fire(), 3_000)
    // Closing the panel ends the poll, also when an answer is still on its way.
    await view.unmount()
    answer('codex')
    await settle()
    assert.equal(held.length, 0)
    assert.equal(asked, 7)
    assert.deepEqual(view.errors, [])
  } finally {
    g.setTimeout = real
  }
})
