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

test('shows every seat with usage, cooldown and history; switching asks the worker', async () => {
  const selected: string[] = []
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => snapshot(),
      'rotator.select': ({ seatKey }) => {
        selected.push(seatKey)
        return { message: `claude: new launches use ${seatKey}` }
      },
      'rotator.clearCooldown': () => ({ ok: true as const }),
      'rotator.pause': ({ paused }) => ({ paused })
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'one@example.test' }))
  assert.ok(view.find({ text: 'limited' }))
  assert.ok(view.find({ text: /Usage unknown/ }))
  await view.press({ text: 'Use for new claude launches' })
  assert.deepEqual(selected, ['claude:c1'])
  assert.ok(view.find({ text: /new launches use claude:c1/ }))
  await view.select({ role: 'tablist' }, 'history')
  assert.deepEqual(view.rowsOf({ type: 'Table' }).length, 1)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
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
  await view.press({ text: 'Cancel' })
  assert.deepEqual(cancelled, ['t1'])
  assert.equal(view.valueOf({ label: 'Automatic switching' }), false)
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

test('each service has its own auto-switch toggle', async () => {
  const calls: { provider: string; enabled: boolean }[] = []
  const host = mockHost({
    requests: {
      'rotator.snapshot': () => snapshot(),
      'rotator.setService': ({ provider, enabled }) => {
        calls.push({ provider, enabled })
        return { services: { claude: true, codex: enabled, antigravity: true, opencode: true, devin: true } }
      }
    }
  })
  const view = await mount(panel, { host })
  assert.equal(view.valueOf({ label: 'Auto-switch claude accounts' }), true)
  await view.toggle({ label: 'Auto-switch codex accounts' })
  assert.deepEqual(calls, [{ provider: 'codex', enabled: false }])
  assert.equal(view.valueOf({ label: 'Auto-switch codex accounts' }), false)
  assert.equal(view.valueOf({ label: 'Auto-switch claude accounts' }), true)
  assert.ok(view.find({ text: /codex: automatic switching off/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
