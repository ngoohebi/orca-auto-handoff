import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { Snapshot } from './protocol'

const NOW = Date.now()

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    paused: false,
    updatedAt: NOW,
    // The focused terminal runs Claude: its block offers "Hand off to this account".
    focused: 'claude',
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
      'rotator.settings': () => ({}),
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
  assert.ok(view.find({ text: 'Fable' }) && view.find({ text: '81% left' }))
  assert.ok(view.find({ text: 'limited' }))
  assert.ok(view.find({ text: /No usage yet/ }))
  assert.ok(!view.find({ text: /Use for new/ }))
  // The Claude console status line switch, for the focused workspace.
  assert.ok(!view.find({ label: 'Status line' }))
  await view.select({ role: 'tablist' }, 'settings')
  assert.equal(view.valueOf({ label: 'Status line' }), false)
  assert.ok(view.find({ label: 'Status line header' }))
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
  snap.history[0]!.why = 'one hit a usage limit; handed off to two (used 7 % of 5h, 18 % of the week)'
  const host = mockHost({ requests: { 'rotator.snapshot': () => snap, 'rotator.consoleLine': () => ({ installed: false, workspace: 'app' }) } })
  const view = await mount(panel, { host })
  // Only the account with a pace has the line.
  assert.equal(view.findAll({ text: /left at this pace/ }).length, 1)
  assert.ok(view.find({ text: 'About 8 min left at this pace' }))
  // Hours once it is long.
  await view.post('rotator.changed', { ...snap, seats: snap.seats.map((s, i) => (i === 1 ? { ...s, runwayMs: 5 * 3_600_000 } : s)) })
  assert.ok(view.find({ text: 'About 5 h left at this pace' }))
  await view.select({ role: 'tablist' }, 'history')
  assert.ok(view.find({ text: 'One hit a usage limit; handed off to two (used 7 % of 5h, 18 % of the week)' }))
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
  await view.post('rotator.changed', snapshot({ waiting: [{ terminalId: 't1', workspaceId: 'w1', agent: 'claude', wakeAt: NOW + 600_000 }] }))
  assert.ok(view.find({ text: /Waiting for a limit to reset/ }))
  assert.ok(view.find({ text: /Claude session resumes/ }))
  // Paused: nothing resumes by itself, so no time is shown as if it would.
  await view.post('rotator.changed', snapshot({ paused: true, waiting: [{ terminalId: 't1', workspaceId: 'w1', agent: 'claude', wakeAt: NOW + 600_000 }] }))
  assert.ok(view.find({ text: /Claude session waits\. Automatic hand-off is paused/ }))
  assert.equal(view.findAll({ text: /session resumes/ }).length, 0)
  // A move that waits for unsent text says so instead of a time.
  await view.post('rotator.changed', snapshot({ waiting: [{ terminalId: 't1', workspaceId: 'w1', agent: 'claude', wakeAt: NOW, draftAt: NOW, reason: 'rate_limit' }] }))
  assert.ok(view.find({ text: /Claude session hands off once the text typed in it is sent or cleared/ }))
  assert.equal(view.findAll({ text: /session resumes/ }).length, 0)
  assert.ok(view.find({ text: /Waiting to hand off/ }))
  assert.equal(view.findAll({ text: /Waiting for a limit to reset/ }).length, 0)
  // The session on screen, asked about, then given text that cannot go along: the line says what
  // keeps it, not the question or a countdown that cannot end in a hand-off.
  await view.post('rotator.changed', snapshot({ waiting: [{ terminalId: 't1', workspaceId: 'w1', agent: 'claude', wakeAt: NOW, activeSince: NOW, asked: true, countdownFrom: NOW, countdownUntil: NOW + 60_000, draftAt: NOW, reason: 'rate_limit' }] }))
  assert.ok(view.find({ text: /Claude session hands off once the text typed in it is sent or cleared/ }))
  assert.equal(view.findAll({ text: /Hand it off to another account now\?/ }).length, 0)
  assert.equal(view.findAll({ text: /session on screen hands off/ }).length, 0)
  assert.ok(view.find({ text: "Don't hand off" }))
  // A hand-off that failed and is tried again with another account is not shown as a wait for a reset.
  await view.post('rotator.changed', snapshot({ waiting: [{ terminalId: 't1', workspaceId: 'w1', agent: 'claude', wakeAt: NOW, reason: 'rate_limit', failures: 1 }] }))
  assert.ok(view.find({ text: /Claude session hands off in a moment, to another account/ }))
  assert.ok(view.find({ text: /Waiting to hand off/ }))
  assert.equal(view.findAll({ text: /session resumes/ }).length, 0)
  // Queued messages are said as that: nobody is typing them.
  await view.post('rotator.changed', snapshot({ waiting: [{ terminalId: 't1', workspaceId: 'w1', agent: 'claude', wakeAt: NOW, draftAt: NOW, queued: true, reason: 'rate_limit' }] }))
  assert.ok(view.find({ text: /Claude session hands off once its queued messages are sent or cleared/ }))
  assert.equal(view.findAll({ text: /text typed in it/ }).length, 0)
  // Held because Orca could not be asked about the pane: not said as text the user typed.
  await view.post('rotator.changed', snapshot({ paused: true, waiting: [{ terminalId: 't1', workspaceId: 'w1', agent: 'claude', wakeAt: NOW, draftAt: NOW, unchecked: true, reason: 'rate_limit' }] }))
  assert.ok(view.find({ text: /Automatic hand-off is paused/ }))
  await view.post('rotator.changed', snapshot({ waiting: [{ terminalId: 't1', workspaceId: 'w1', agent: 'claude', wakeAt: NOW, draftAt: NOW, unchecked: true, reason: 'rate_limit' }] }))
  assert.ok(view.find({ text: /Claude session hands off once Orca can say that it is between turns with an empty input box/ }))
  assert.equal(view.findAll({ text: /text typed in it/ }).length, 0)
  await view.press({ text: 'Cancel' })
  assert.deepEqual(cancelled, ['t1'])
  await view.post('rotator.changed', snapshot({ paused: true }))
  assert.equal(view.valueOf({ label: 'Automatic hand-off, all services' }), false)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('empty and error states', async () => {
  const host = mockHost({ requests: { 'rotator.snapshot': () => snapshot({ seats: [], history: [], error: 'orca account list failed: not running' }) } })
  const view = await mount(panel, { host })
  const summary = view.summary().join('\n')
  assert.match(summary, /Cannot read accounts/)
  assert.match(summary, /No accounts/)
  assert.equal(view.find({ type: 'EmptyState' })?.props.description, 'Manage sign-ins in Orca Settings → AI Provider Accounts.')
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
  assert.equal(view.valueOf({ testId: 'auto-claude' }), true)
  await view.toggle({ testId: 'auto-codex' })
  assert.deepEqual(calls, [{ provider: 'codex', enabled: false }])
  assert.equal(view.valueOf({ testId: 'auto-codex' }), false)
  assert.equal(view.valueOf({ testId: 'auto-claude' }), true)
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
  assert.equal(view.findAll({ text: /on screen/ }).length, 1)
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

test('the Settings tab: the basic choices first, the rest folded away under Advanced; changes go through the worker', async () => {
  let stored: Record<string, string | number | boolean> = {
    pick: 'smart', timing: 'early', when_all_used: 'wait', active_terminal: 'careful', early_minutes: 10, early_percent_left: 0, idle_minutes: 15,
    restore_unsent_text: true, auto_message: 'Continue.'
  }
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => snapshot({ mode: 'smart' }),
      'rotator.consoleLine': () => ({ installed: false }),
      'rotator.settings': ({ key, value }: { key?: string; value?: string | number | boolean }) => {
        if (key !== undefined && value !== undefined) stored = { ...stored, [key]: value }
        return stored
      }
    }
  })
  const view = await mount(panel, { host })
  // The badge says what automatic hand-off is doing now.
  assert.ok(view.find({ text: 'Early hand-offs on' }))
  await view.select({ label: 'View' }, 'settings')
  assert.equal(view.valueOf({ label: 'Pick the next account' }), 'smart')
  assert.equal(view.valueOf({ label: 'When to hand off' }), 'early')
  assert.ok(view.find({ text: /Picks the account with the most room/ }))
  assert.ok(view.find({ type: 'Collapsible' }))
  await view.select({ label: 'When to hand off' }, 'at-limit')
  assert.equal(stored.timing, 'at-limit')
  assert.ok(view.find({ text: "When to hand off: At limit" }))
  // Advanced is folded away until opened. A number there is greyed out, with why, while it does
  // not apply, and saved on Enter.
  assert.equal(view.findAll({ text: "Only used when When to hand off is Early when away." }).length, 0)
  await view.toggle({ type: 'Collapsible' })
  assert.ok(view.findAll({ text: "Only used when When to hand off is Early when away." }).length >= 1)
  await view.select({ label: 'When to hand off' }, 'early')
  await view.type({ label: 'Hand off this long before running out (min)' }, '20', { replace: true, submit: true })
  assert.equal(stored.early_minutes, 20)
  await view.toggle({ label: 'Put unsent text back after a hand-off' })
  assert.equal(stored.restore_unsent_text, false)
  // A change made on Orca's Settings page shows up here.
  await view.post('rotator.settings', { ...stored, pick: 'my-order' } as never)
  assert.equal(view.valueOf({ label: 'Pick the next account' }), 'my-order')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Custom order: the accounts in that order, with arrows that move them', async () => {
  const moves: unknown[] = []
  const base = snapshot()
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => snapshot({ mode: 'my-order', order: { claude: ['claude:c2', 'claude:c1'] } }),
      'rotator.consoleLine': () => ({ installed: false }),
      'rotator.moveSeat': (input: unknown) => {
        moves.push(input)
        return { ok: true }
      }
    }
  })
  const view = await mount(panel, { host })
  const names = view.findAll({ text: /^(one|two)@example\.test$/ }).map((n) => n.text)
  assert.deepEqual(names, ['two@example.test', 'one@example.test'])
  assert.equal(view.findAll({ label: 'Move up in custom order' }).length, base.seats.filter((s) => s.provider === 'claude').length)
  await view.press(view.findAll({ label: 'Move up in custom order' })[1]!)
  assert.deepEqual(moves, [{ seatKey: 'claude:c1', by: -1 }])
  await view.unmount()
})

test('the badge is coloured by what is happening now: green while early hand-offs are on, green with a plain border while waiting for the user to leave, grey at limit only, amber when paused', async () => {
  const host = mockHost({ requests: { 'rotator.snapshot': () => snapshot({ mode: 'smart' }), 'rotator.consoleLine': () => ({ installed: false }) } })
  const view = await mount(panel, { host })
  const pill = () => view.find({ text: /^(Early hand-offs on|Early once you step away|At limit only|Paused)$/ })
  const symbol = (t: string) => view.find({ text: t })
  assert.equal(pill()?.text, 'Early hand-offs on')
  assert.ok(symbol('●'))
  assert.equal(pill()?.props.tone, 'success')
  await view.post('rotator.changed', snapshot({ mode: 'smart', userHere: true }))
  assert.equal(pill()?.text, 'Early once you step away')
  assert.ok(symbol('◐'))
  assert.equal(pill()?.props.tone, 'success')
  await view.post('rotator.changed', snapshot({ mode: 'my-order', atLimitOnly: true }))
  assert.equal(pill()?.text, 'At limit only')
  assert.ok(symbol('○'))
  assert.equal(pill()?.props.tone, 'neutral')
  await view.post('rotator.changed', snapshot({ mode: 'smart', paused: true }))
  assert.equal(pill()?.text, 'Paused')
  assert.ok(symbol('■'))
  assert.equal(pill()?.props.tone, 'warning')
  await view.unmount()
})

test('History uses the whole tab (no box of its own) and offers no way to clear it', async () => {
  const host = mockHost({ requests: { 'rotator.snapshot': () => snapshot(), 'rotator.consoleLine': () => ({ installed: false }) } })
  const view = await mount(panel, { host })
  await view.select({ label: 'View' }, 'history')
  assert.ok(view.find({ text: 'Last 7 days · 1 entry' }))
  assert.equal(view.find({ text: 'Clear' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('"Ask me first": the panel asks whether to hand off the session on screen; Hand off now and Not now go to the worker', async () => {
  const calls: string[] = []
  const asked = { terminalId: 't1', workspaceId: 'w1', agent: 'claude' as const, wakeAt: NOW, activeSince: NOW, asked: true, countdownFrom: NOW, countdownUntil: NOW + 60_000, reason: 'rate_limit' as const }
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => snapshot({ waiting: [asked] }),
      'rotator.consoleLine': () => ({ installed: false }),
      'rotator.handoffNow': () => {
        calls.push('now')
        return { ok: true }
      },
      'rotator.declineHandoff': () => {
        calls.push('decline')
        return { ok: true }
      }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Claude hit its limit in the session on screen. Hand it off to another account now?' }))
  await view.press({ text: 'Not now' })
  await view.press({ text: 'Hand off now' })
  assert.deepEqual(calls, ['decline', 'now'])
  // Answered Not now: no question any more, the usual waiting line with Hand off now.
  await view.post('rotator.changed', snapshot({ waiting: [{ ...asked, declined: true, countdownUntil: undefined, countdownFrom: undefined }] }) as never)
  assert.equal(view.find({ text: 'Not now' }), null)
  assert.ok(view.find({ text: 'Hand off now' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('each account card of a service with several accounts has Skip (never switch to it); the status line header sits with its switch', async () => {
  const calls: unknown[] = []
  const seats = snapshot().seats.map((x) => (x.key === 'claude:c1' ? { ...x, excluded: true } : x))
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => snapshot({ seats }),
      'rotator.consoleLine': () => ({ installed: true, workspace: 'app' }),
      'rotator.settings': () => ({ console_statusline_format: '' }),
      'rotator.setExcluded': (input: unknown) => {
        calls.push(input)
        return { ok: true }
      }
    }
  })
  const view = await mount(panel, { host })
  const toggles = view.findAll({ label: 'Skip' })
  assert.equal(toggles.length, 2, 'Claude has two accounts; Codex one (no switch)')
  assert.equal(view.valueOf(toggles[0]!) === true || view.valueOf(toggles[1]!) === true, true)
  await view.toggle(toggles.find((t) => view.valueOf(t) === false)!)
  assert.deepEqual(calls, [{ seatKey: 'claude:c2', excluded: true }])
  assert.ok(!view.find({ label: 'Status line header' }))
  await view.select({ role: 'tablist' }, 'settings')
  assert.ok(view.find({ label: 'Status line header' }))
  await view.unmount()
})

test('a drained account is not counted as ready', async () => {
  const seats: Snapshot['seats'] = [
    { key: 'antigravity:system', provider: 'antigravity', accountId: 'system', label: 'system', active: true, usage: { known: true, session: { usedPercent: 0, resetsAt: NOW + 3_600_000 }, weekly: { usedPercent: 94, resetsAt: NOW + 86_400_000 } } },
    ...snapshot().seats.filter((s) => s.provider === 'claude')
  ]
  const host = mockHost({ requests: { 'rotator.snapshot': () => snapshot({ seats }), 'rotator.consoleLine': () => ({ installed: false }) } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: '0 of 1 ready · 1 drained' }))
  assert.ok(view.find({ text: '1 of 2 ready · 1 limited' }))
  await view.unmount()
})

test('a service with a single account shows no auto hand-off toggle', async () => {
  const host = mockHost({ requests: { 'rotator.snapshot': () => snapshot(), 'rotator.consoleLine': () => ({ installed: false }) } })
  const view = await mount(panel, { host })
  // The fixture's Codex has one account; Claude has two.
  assert.ok(view.find({ testId: 'auto-claude' }))
  assert.ok(!view.find({ testId: 'auto-codex' }))
  assert.ok(view.find({ text: 'plus@example.test' }))
})

test('"Hand off to this account" is offered only in the block of the focused terminal\'s service', async () => {
  const codex: Snapshot['seats'] = [
    { key: 'codex:x1', provider: 'codex', accountId: 'x1', label: 'plus@example.test', active: true, usage: { known: false } },
    { key: 'codex:x2', provider: 'codex', accountId: 'x2', label: 'pro@example.test', active: false, usage: { known: false } }
  ]
  const claude: Snapshot['seats'] = [
    { key: 'claude:a', provider: 'claude', accountId: 'a', label: 'inuse@example.test', active: true, usage: { known: true, session: { usedPercent: 50, resetsAt: NOW + 3_600_000 } } },
    { key: 'claude:b', provider: 'claude', accountId: 'b', label: 'spare@example.test', active: false, usage: { known: true, session: { usedPercent: 5, resetsAt: NOW + 3_600_000 } } }
  ]
  const seats = [...claude, ...codex]
  const host = mockHost({ requests: { 'rotator.snapshot': () => snapshot({ seats }), 'rotator.consoleLine': () => ({ installed: false }) } })
  const view = await mount(panel, { host })
  // Claude is focused: its standby has the button, Codex's standby has none.
  assert.equal(view.findAll({ text: 'Hand off to this account' }).length, 1)
  await view.post('rotator.changed', snapshot({ seats, focused: 'codex' }))
  assert.equal(view.findAll({ text: 'Hand off to this account' }).length, 1)
  await view.post('rotator.changed', snapshot({ seats, focused: undefined }))
  assert.equal(view.findAll({ text: 'Hand off to this account' }).length, 0)
  assert.deepEqual(view.errors, [])
  await view.unmount()
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
        return { message: 'Claude: new sessions start on spare@example.test. Automatic hand-off for Claude is now off' }
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
  assert.ok(view.find({ text: 'New Claude sessions start on this account. The session on screen moves too if it is between turns; its unsent text goes along, or you are asked first.' }))
  assert.ok(view.find({ text: 'Automatic hand-off for Claude turns off.' }))
  // While it asks, the button gives way to the question; Skip stays where it was.
  assert.equal(view.findAll({ text: 'Hand off to this account' }).length, 0)
  // Cancel backs out without switching.
  await view.press({ text: 'Cancel' })
  assert.ok(!view.find({ text: /Hand off Claude to spare@example.test/ }))
  assert.deepEqual(calls, [])
  await view.press({ text: 'Hand off to this account' })
  await view.press({ text: 'Yes, hand off' })
  assert.deepEqual(calls, ['switch claude:b'])
  assert.ok(view.find({ text: /new sessions start on/ }))
  assert.ok(view.find({ text: /Automatic hand-off for Claude is off/ }))
  assert.equal(view.valueOf({ testId: 'auto-claude' }), false)
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
        if (input.acceptDraft !== true || input.draft?.text !== shown.text) return { message: 'Claude: this session has unsent text that cannot go along; nothing was handed off', draft: shown }
        auto = false
        return { message: 'Claude: new sessions start on spare@example.test; this session was handed off' }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Hand off to this account' })
  await view.press({ text: 'Yes, hand off' })
  assert.deepEqual(calls, [{ seatKey: 'claude:b' }])
  // The second confirmation, in the same block, with the text.
  assert.ok(view.find({ text: 'This session shows unsent text that cannot go along: “keep going”.' }))
  assert.ok(view.find({ text: 'Hand off anyway? The text would be lost.' }))
  assert.ok(view.find({ text: 'Hand off anyway' }))
  assert.ok(!view.find({ text: 'Yes, hand off' }))
  assert.ok(!view.find({ text: /nothing was handed off/ }))
  // Cancel does nothing: no further request, and the button is back.
  await view.press({ text: 'Cancel' })
  assert.equal(calls.length, 1)
  assert.ok(!view.find({ text: /This session shows unsent text/ }))
  assert.ok(view.find({ text: 'Hand off to this account' }))
  assert.equal(view.valueOf({ testId: 'auto-claude' }), true)
  // Again; the text changes before "Hand off anyway": the worker asks again, the panel shows the new
  // text (cut to 80 characters), and nothing has moved.
  await view.press({ text: 'Hand off to this account' })
  await view.press({ text: 'Yes, hand off' })
  shown = { terminalId: 't1', text: LONG }
  await view.press({ text: 'Hand off anyway' })
  assert.deepEqual(calls.at(-1), { seatKey: 'claude:b', acceptDraft: true, draft: { terminalId: 't1', text: 'keep going' } })
  assert.ok(view.find({ text: `This session shows unsent text that cannot go along: “${LONG.slice(0, 80)}…”.` }))
  assert.ok(!view.find({ text: /this session was handed off/ }))
  // "Hand off anyway" sends the explicit acceptance with the whole text it showed.
  await view.press({ text: 'Hand off anyway' })
  assert.deepEqual(calls.at(-1), { seatKey: 'claude:b', acceptDraft: true, draft: { terminalId: 't1', text: LONG } })
  assert.equal(calls.length, 4)
  assert.ok(view.find({ text: /this session was handed off/ }))
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
        return { message: 'Claude: this session has unsent text that cannot go along; nothing was handed off', draft: { terminalId: 't1', text: 'keep going' } }
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
        return { message: 'Claude: new sessions start on spare@example.test; this session was handed off' }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Hand off to this account' })
  await view.press({ text: 'Yes, hand off' })
  assert.equal(reads, 2)
  // The switch's own result, then the reload problem, calmly and apart from it.
  assert.ok(view.find({ text: "Claude: new sessions start on spare@example.test; this session was handed off. Couldn't refresh the list; it updates shortly." }))
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
      'rotator.settings': () => ({}),
      'rotator.consoleLine': ({ enabled }) => {
        if (typeof enabled === 'boolean') toggled.push(enabled)
        return { installed: true, workspace: 'app' }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.select({ role: 'tablist' }, 'settings')
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

test('a Status line read that is still being retried when its panel closes changes nothing in the panel opened next', async () => {
  // The retry's wait (1.5 s) is held here and fired by hand; every other timer runs as usual.
  const g = globalThis as unknown as { setTimeout: (fn: () => void, ms?: number) => unknown }
  const real = g.setTimeout
  const held: (() => void)[] = []
  g.setTimeout = (fn, ms) => {
    if (ms === 1_500 && /[\\/]panel\.tsx/.test(new Error().stack ?? '')) {
      held.push(fn)
      return { unref() {} }
    }
    return real(fn, ms)
  }
  try {
    // The first panel's worker does not answer for the Status line: the read waits to ask again.
    const first = await mount(panel, { host: mockHost({ requests: { 'rotator.snapshot': () => snapshot() } }) })
    assert.equal(held.length, 1, 'the retry waits')
    await first.unmount()
    // Another panel opens, on a workspace with the line; then the user moves to one without it.
    let asked = 0
    const host = mockHost({
      requests: {
        'rotator.snapshot': () => snapshot(),
        'rotator.settings': () => ({}),
        'rotator.consoleLine': () => {
          asked++
          return { installed: true, workspace: 'app' }
        }
      }
    })
    const view = await mount(panel, { host })
    await view.select({ role: 'tablist' }, 'settings')
    assert.equal(view.valueOf({ label: 'Status line' }), true)
    await view.post('rotator.consoleLine', { installed: false, workspace: 'other' })
    assert.equal(asked, 1)
    // The closed panel's retry comes due now: it neither asks this panel's worker nor puts an
    // older answer over what the switch shows.
    for (const fn of held.splice(0)) fn()
    await new Promise<void>((resolve) => real(resolve, 5))
    await view.settled()
    assert.equal(asked, 1, 'the closed panel asks nothing more')
    assert.equal(view.valueOf({ label: 'Status line' }), false)
    assert.deepEqual(view.errors, [])
    await view.unmount()
  } finally {
    g.setTimeout = real
  }
})

test('a first read that fails is not an unhandled error: the worker\u2019s next push fills the panel, Status line switch included', async () => {
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => {
        throw new Error('worker restarting')
      },
      'rotator.settings': () => ({}),
      'rotator.consoleLine': () => ({ installed: true, workspace: 'app' })
    }
  })
  const view = await mount(panel, { host })
  assert.deepEqual(view.summary(), ['Skeleton "Loading accounts"'])
  await view.post('rotator.changed', snapshot())
  assert.ok(view.find({ text: 'one@example.test' }))
  await view.select({ role: 'tablist' }, 'settings')
  assert.equal(view.valueOf({ label: 'Status line' }), true)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('"Yes, hand off" gives the worker longer than the 30 s a request gets by default: moving the pane waits for the resumed session', async () => {
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => snapshot({ seats: twoClaude }),
      'rotator.consoleLine': () => ({ installed: false, workspace: 'app' }),
      'rotator.switchTo': () => ({ message: 'Claude: new sessions start on spare@example.test; this session was handed off' })
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Hand off to this account' })
  await view.press({ text: 'Yes, hand off' })
  const call = (host.callsOf('plugin.request') as { name: string; timeoutMs?: number }[]).find((c) => c.name === 'rotator.switchTo')
  // The worker closes the pane (up to 10 s) and waits for the resumed session (up to 60 s) before
  // it answers; a request that timed out would read as a failed switch that in fact worked.
  assert.ok((call?.timeoutMs ?? 30_000) >= 90_000, `timeoutMs ${call?.timeoutMs}`)
  assert.ok(view.find({ text: /this session was handed off/ }))
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

test('History says reasons and results in words, and shows unsent text that could not be put back, to copy', async () => {
  const snap = snapshot({
    history: [
      { at: NOW - 120_000, provider: 'claude', reason: 'threshold', result: 'selected', from: 'claude:c1', to: 'claude:c2' },
      { at: NOW - 60_000, provider: 'claude', reason: 'rate_limit', result: 'failed', from: 'claude:c1', to: 'claude:c2', detail: 'session_not_found', unsent: 'fix the parser\nthen run the tests' }
    ]
  })
  snap.seats.push({ key: 'claude:c3', provider: 'claude', accountId: 'c3', label: 'three@example.test', active: false, usage: { known: false } })
  const host = mockHost({ requests: { 'rotator.snapshot': () => snap, 'rotator.consoleLine': () => ({ installed: false }) } })
  const view = await mount(panel, { host })
  // The cooling account says why in words, not as a code.
  assert.ok(view.find({ text: /^Limit reached/ }))
  assert.equal(view.findAll({ text: /rate_limit|Rate limit/ }).length, 0)
  // An account without usage numbers reads "no data", not "idle".
  assert.ok(view.find({ text: 'no data' }))
  await view.select({ label: 'View' }, 'history')
  assert.ok(view.find({ text: 'Claude · Limit reached' }))
  assert.ok(view.find({ text: 'Claude · Running low' }))
  assert.ok(view.find({ text: 'new sessions only' }))
  assert.ok(view.find({ text: 'failed' }))
  assert.equal(view.findAll({ text: /rate limit|threshold|selected/ }).length, 0)
  const code = view.find({ type: 'Code' })
  assert.match(code?.text ?? '', /^fix the parser\s+then run the tests$/)
  assert.equal(code?.props.block, true)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('History, empty: no hand-offs yet', async () => {
  const host = mockHost({ requests: { 'rotator.snapshot': () => snapshot({ history: [] }), 'rotator.consoleLine': () => ({ installed: false }) } })
  const view = await mount(panel, { host })
  await view.select({ label: 'View' }, 'history')
  assert.match(view.summary().join('\n'), /No hand-offs yet/)
  await view.unmount()
})

test('Hand off now that could not hand off shows why; paused, the question shows no countdown', async () => {
  const asked = { terminalId: 't1', workspaceId: 'w1', agent: 'claude' as const, wakeAt: NOW, activeSince: NOW, asked: true, countdownFrom: NOW, countdownUntil: NOW + 60_000, reason: 'rate_limit' as const }
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => snapshot({ waiting: [asked] }),
      'rotator.consoleLine': () => ({ installed: false }),
      'rotator.handoffNow': () => ({ ok: true as const, message: 'No other Claude account has room.' })
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: /If you do not answer, it hands off/ }))
  await view.press({ text: 'Hand off now' })
  assert.ok(view.find({ text: 'No other Claude account has room.' }))
  await view.post('rotator.changed', snapshot({ paused: true, waiting: [asked] }))
  assert.equal(view.findAll({ text: /If you do not answer, it hands off/ }).length, 0)
  assert.ok(view.find({ text: /Automatic hand-off is paused, so it waits until you turn it on/ }))
  await view.post('rotator.changed', snapshot({ services: { claude: false, codex: true, antigravity: true, opencode: true, devin: true }, waiting: [asked] }))
  assert.ok(view.find({ text: /Automatic hand-off is off for Claude/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('"Yes, hand off" over queued messages says they would be lost, without quoting Claude’s hint', async () => {
  const seats: Snapshot['seats'] = [
    { key: 'claude:a', provider: 'claude', accountId: 'a', label: 'inuse@example.test', active: true, usage: { known: true, session: { usedPercent: 50, resetsAt: NOW + 3_600_000 } } },
    { key: 'claude:b', provider: 'claude', accountId: 'b', label: 'spare@example.test', active: false, usage: { known: true, session: { usedPercent: 5, resetsAt: NOW + 3_600_000 } } }
  ]
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => snapshot({ seats }),
      'rotator.consoleLine': () => ({ installed: false }),
      'rotator.switchTo': () => ({ message: 'Claude: this session has queued messages that cannot go along; nothing was handed off', draft: { terminalId: 't1', text: 'Press up to edit queued messages', queued: true } })
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Hand off to this account' })
  await view.press({ text: 'Yes, hand off' })
  assert.ok(view.find({ text: 'This session has queued messages that would be lost.' }))
  assert.equal(view.findAll({ text: /Press up to edit/ }).length, 0)
  assert.ok(view.find({ text: 'Hand off anyway' }))
  await view.unmount()
})

test('a snapshot with parts missing or of another version (the panel and the worker restart apart during an update) still draws', async () => {
  const partial = { paused: false, updatedAt: NOW, mode: 'custom', seats: [{ key: 'claude:c1', provider: 'claude', accountId: 'c1', label: 'one@example.test', active: true }, ...snapshot().seats.slice(1)] } as unknown as Snapshot
  const host = mockHost({ requests: { 'rotator.snapshot': () => partial, 'rotator.consoleLine': () => ({ installed: false }) } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'two@example.test' }))
  assert.equal(view.find({ text: /undefined/ }), null)
  assert.ok(view.find({ text: 'Early hand-offs on' }))
  await view.post('rotator.changed', { paused: true } as never)
  assert.ok(view.find({ text: 'Paused' }))
  assert.match(view.summary().join('\n'), /No accounts/)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a question asked under "Ask me first" is not shown as one once Session on screen is set to something else', async () => {
  const asked = { terminalId: 't1', workspaceId: 'w1', agent: 'claude' as const, wakeAt: NOW, activeSince: NOW, asked: true, reason: 'rate_limit' as const }
  const host = mockHost({ requests: { 'rotator.snapshot': () => snapshot({ waiting: [asked], activeTerminal: 'ask' }), 'rotator.consoleLine': () => ({ installed: false }) } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'If you do not answer, it waits while you are using Orca, then counts down.' }))
  await view.post('rotator.changed', snapshot({ waiting: [asked], activeTerminal: 'wait' }) as never)
  assert.equal(view.find({ text: /then counts down/ }), null)
  assert.ok(view.find({ text: /session on screen hands off when you switch to another tab$/ }))
  assert.ok(view.find({ text: 'Hand off now' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a service with a single account whose automatic hand-off was turned off elsewhere shows the switch, so it can be turned on again', async () => {
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => snapshot({ services: { claude: true, codex: false, antigravity: true, opencode: true, devin: true } }),
      'rotator.consoleLine': () => ({ installed: false })
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ testId: 'auto-codex' }))
  assert.match(view.summary().join('\n'), /Automatic hand-off for Codex is off/)
  await view.unmount()
})

test('History: a session that went on where it was, on its own account, is not said to be "retried"', async () => {
  const host = mockHost({
    requests: {
      'rotator.snapshot': () =>
        snapshot({
          history: [
            { at: NOW - 120_000, provider: 'claude', reason: 'api_error', result: 'retried', terminalId: 't1', detail: 'attempt 1' },
            { at: NOW - 60_000, provider: 'claude', reason: 'reset', result: 'retried', from: 'claude:c1', to: 'claude:c1', terminalId: 't1', why: 'one has reset; the session continues there' }
          ]
        }),
      'rotator.consoleLine': () => ({ installed: false })
    }
  })
  const view = await mount(panel, { host })
  await view.select({ role: 'tablist' }, 'history')
  assert.equal(view.findAll({ text: /^same account$/ }).length, 1)
  // An API error retry keeps its word, and one account is not shown as going to itself.
  assert.equal(view.findAll({ text: /^retried$/ }).length, 1)
  assert.equal(view.findAll({ text: /→/ }).length, 0)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('while the settings are held (not read yet, or the upgrade not finished) the panel says why nothing is handed off, and shows no service as turned off; the Settings tab fills once Orca answers', async () => {
  const off = { claude: false, codex: false, antigravity: false, opencode: false, devin: false }
  let readable = false
  const host = mockHost({
    requests: {
      'rotator.snapshot': () =>
        snapshot({ services: off, held: 'settings', mode: 'smart', waiting: [{ terminalId: 't9', workspaceId: 'w1', agent: 'claude', wakeAt: NOW + 600_000 }] }),
      'rotator.settings': () => {
        if (!readable) throw new Error('settings are not available')
        return { pick: 'smart', timing: 'at-limit', when_all_used: 'wait', active_terminal: 'ask' }
      },
      'rotator.consoleLine': () => ({ installed: false })
    }
  })
  const view = await mount(panel, { host })
  let text = view.summary().join('\n')
  assert.match(text, /Auto Hand-off is waiting for Orca's settings/)
  assert.ok(view.find({ text: /nothing is handed off or resumed automatically\. It tries again by itself/ }))
  // No badge saying early hand-offs are on while nothing is handed off.
  assert.ok(!view.find({ text: /Early hand-offs|Early once|At limit only/ }))
  // Nobody turned a service off: no switch shown as off, no "is off" callout, no "turn it on".
  assert.ok(!/Automatic hand-off for (Claude|Codex) is off/.test(text))
  assert.ok(!view.find({ testId: 'auto-claude' }) && !view.find({ testId: 'auto-codex' }))
  assert.ok(view.find({ text: /Claude session waits\. Auto Hand-off is waiting for Orca's settings, so it waits\./ }))
  assert.ok(!view.find({ text: /until you turn it on|Turn Automatic hand-off on/ }))
  // The Settings tab has no values yet, and does not show defaults in their place.
  await view.select({ role: 'tablist' }, 'settings')
  assert.ok(!view.find({ label: 'When to hand off' }))
  // The upgrade's words, then the hold ends: the callout goes, the switches are back, the tab fills.
  await view.post('rotator.changed', snapshot({ services: off, held: 'upgrade' }))
  assert.match(view.summary().join('\n'), /Auto Hand-off is finishing the upgrade/)
  readable = true
  await view.post('rotator.changed', snapshot({ mode: 'smart' }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  text = view.summary().join('\n')
  assert.ok(view.find({ text: 'Early hand-offs on' }))
  assert.ok(!/waiting for Orca's settings|finishing the upgrade/.test(text))
  assert.equal(view.valueOf({ label: 'When to hand off' }), 'at-limit')
  await view.select({ role: 'tablist' }, 'accounts')
  assert.ok(view.find({ testId: 'auto-claude' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a hand-off on its way greys out only the hand-off controls; settings and Skip stay usable, and a failure reads as one', async () => {
  const seats: Snapshot['seats'] = [
    { key: 'claude:a', provider: 'claude', accountId: 'a', label: 'inuse@example.test', active: true, usage: { known: true, session: { usedPercent: 50, resetsAt: NOW + 3_600_000 } } },
    { key: 'claude:b', provider: 'claude', accountId: 'b', label: 'spare@example.test', active: false, usage: { known: true, session: { usedPercent: 5, resetsAt: NOW + 3_600_000 } } },
    { key: 'claude:c', provider: 'claude', accountId: 'c', label: 'third@example.test', active: false, usage: { known: true, session: { usedPercent: 9, resetsAt: NOW + 3_600_000 } } }
  ]
  let finish: (v: { message: string }) => void = () => undefined
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => snapshot({ seats }),
      'rotator.consoleLine': () => ({ installed: false, workspace: 'app' }),
      'rotator.settings': () => ({ pick: 'smart', timing: 'early', when_all_used: 'wait', active_terminal: 'ask' }),
      'rotator.setExcluded': () => ({ ok: true as const }),
      'rotator.switchTo': () => new Promise((resolve) => (finish = resolve))
    }
  })
  const view = await mount(panel, { host })
  await view.press(view.findAll({ text: 'Hand off to this account' })[0]!)
  const pressed = view.press({ text: 'Yes, hand off' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  // The other standby's hand-off waits; its Skip and the refresh do not.
  assert.equal(view.find({ text: 'Hand off to this account' })?.disabled, true)
  assert.equal(view.findAll({ label: 'Skip' }).every((n) => !n.disabled), true)
  assert.equal(view.find({ label: 'Refresh usage from Orca' })?.disabled, false)
  finish({ message: 'Claude: new sessions start on spare@example.test' })
  await pressed
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a failed action is said in the danger tone; a setting says its result under itself, not at the top', async () => {
  let stored: Record<string, string | number | boolean> = { pick: 'smart', timing: 'early', when_all_used: 'wait', active_terminal: 'ask', early_minutes: 10 }
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => snapshot({ mode: 'smart' }),
      'rotator.consoleLine': () => ({ installed: false, workspace: 'app' }),
      'rotator.clearCooldown': () => {
        throw new Error('worker restarting')
      },
      'rotator.settings': ({ key, value }: { key?: string; value?: string | number | boolean }) => {
        if (key !== undefined && value !== undefined) stored = { ...stored, [key]: value }
        return stored
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'End cooldown' })
  assert.equal(view.find({ text: 'Failed: worker restarting' })?.props.tone, 'danger')
  await view.press({ label: 'Dismiss' })
  await view.select({ role: 'tablist' }, 'settings')
  // Typed and not saved: said, with Save and Undo.
  await view.toggle({ type: 'Collapsible' })
  await view.type({ label: 'Hand off this long before running out (min)' }, '25', { replace: true })
  assert.ok(view.find({ text: 'Not saved yet. Press Enter or Save.' }))
  await view.press({ text: 'Undo' })
  assert.equal(view.find({ text: /Not saved yet/ }), null)
  // Out of range is said as what it saves as; not a number cannot be saved.
  await view.type({ label: 'Hand off this long before running out (min)' }, '500', { replace: true })
  assert.ok(view.find({ text: 'Not saved yet. Saves as 120 (1–120).' }))
  await view.type({ label: 'Hand off this long before running out (min)' }, 'soon', { replace: true })
  assert.ok(view.find({ text: 'Not saved: enter a number, 1–120.' }))
  assert.equal(view.find({ text: 'Save' })?.disabled, true)
  await view.type({ label: 'Hand off this long before running out (min)' }, '25', { replace: true })
  await view.press({ text: 'Save' })
  assert.equal(stored.early_minutes, 25)
  assert.ok(view.find({ text: 'Hand off this long before running out: 25' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Advanced groups its settings; a group none of which applies says why once', async () => {
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => snapshot({ mode: 'smart' }),
      'rotator.consoleLine': () => ({ installed: false }),
      'rotator.settings': () => ({ pick: 'smart', timing: 'early', when_all_used: 'wait', active_terminal: 'move' })
    }
  })
  const view = await mount(panel, { host })
  await view.select({ role: 'tablist' }, 'settings')
  await view.toggle({ type: 'Collapsible' })
  assert.ok(view.find({ text: 'Early hand-offs' }) && view.find({ text: 'Limits and errors' }))
  // Session on screen is Move right away: its three settings are one line, not three greyed fields.
  assert.equal(view.find({ label: /Countdown for the session on screen/ }), null)
  assert.ok(view.find({ text: /Only used when Session on screen is Ask me first or Wait, then count down\./ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Live Quota: every saved account is on by itself; Turn off and Turn on per account; Not available says why, with no button', async () => {
  const calls: unknown[] = []
  let snap = snapshot()
  snap.seats = snap.seats.map((s) =>
    s.key === 'claude:c2'
      ? { ...s, quotaLinked: true, usage: { ...s.usage, source: 'live', origin: 'claude-profile', asOf: NOW - 120_000 } }
      : s.key === 'claude:c1'
        ? { ...s, quotaOff: true }
        : { ...s, quotaUnavailable: 'no saved sign-in on this computer' }
  )
  snap.seats.push({ key: 'claude:system', provider: 'claude', accountId: 'system', label: 'system', active: false, usage: { known: false } })
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => snap,
      'rotator.consoleLine': () => ({ installed: false }),
      'rotator.linkQuota': (input: { seatKey: string; linked: boolean }) => {
        calls.push(input)
        snap = { ...snap, seats: snap.seats.map((s) => (s.key === input.seatKey ? { ...s, quotaLinked: input.linked, quotaOff: !input.linked } : s)) }
        return snap
      }
    }
  })
  const view = await mount(panel, { host })
  // Accounts has no direct-check controls of its own.
  assert.equal(view.find({ text: /^Turn (on|off)$/ }), null)
  await view.select({ role: 'tablist' }, 'proxy')
  // The agent's own login is not listed.
  assert.equal(view.find({ text: 'system' }), null)
  assert.ok(view.find({ text: '1 checked directly' }))
  assert.ok(view.find({ text: /^Live/ }) && view.find({ text: 'Off' }) && view.find({ text: 'Not available' }))
  assert.ok(view.find({ text: 'No saved sign-in on this computer' }))
  // One button per account that has a choice: Turn off on the live one, Turn on on the one turned off.
  assert.equal(view.findAll({ text: /^Turn (on|off)$/ }).length, 2)
  await view.press({ text: 'Turn off' })
  assert.deepEqual(calls.at(-1), { seatKey: 'claude:c2', linked: false })
  assert.ok(view.find({ text: '0 checked directly' }))
  assert.equal(view.find({ text: 'Check now' })?.disabled, true)
  await view.press(view.findAll({ text: 'Turn on' })[0]!)
  assert.equal((calls.at(-1) as { linked: boolean }).linked, true)
  // An expired sign-in says what happens next, and the tab label counts it.
  await view.post('rotator.changed', { ...snap, seats: snap.seats.map((s) => (s.key === 'claude:c2' ? { ...s, quotaLinked: true, quotaOff: false, directQuotaIssue: { reason: 'stale-token', retryAt: 0 } } : s)) } as never)
  assert.ok(view.find({ text: 'Sign-in expired' }))
  assert.ok(view.find({ text: 'Updates once Claude renews it, or sign in again in Orca.' }))
  assert.ok(view.find({ label: 'Live Quota · 1' }) ?? view.find({ text: 'Live Quota · 1' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Live Quota for a project on another server says direct checks are for this computer', async () => {
  const host = mockHost({ requests: { 'rotator.snapshot': () => snapshot({ server: 'studio' }), 'rotator.consoleLine': () => ({ installed: false }) } })
  const view = await mount(panel, { host })
  await view.select({ role: 'tablist' }, 'proxy')
  assert.match(view.summary().join('\n'), /Not for a remote project/)
  assert.equal(view.find({ text: /^Turn (on|off)$/ }), null)
  await view.unmount()
})

test('History: entries under their day, and the tab counts only failed hand-offs', async () => {
  const host = mockHost({
    requests: {
      'rotator.snapshot': () =>
        snapshot({
          history: [
            { at: NOW - 3 * 86_400_000, provider: 'claude', reason: 'rate_limit', result: 'failed', from: 'claude:c1', to: 'claude:c2' },
            { at: NOW - 60_000, provider: 'claude', reason: 'rate_limit', result: 'resumed', from: 'claude:c1', to: 'claude:c2' }
          ]
        }),
      'rotator.consoleLine': () => ({ installed: false })
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ label: 'History · 1 failed' }) ?? view.find({ text: 'History · 1 failed' }))
  await view.select({ role: 'tablist' }, 'history')
  assert.ok(view.find({ text: 'Today' }))
  assert.equal(view.findAll({ text: /^(Today|Yesterday)$/ }).length, 1)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
