// `orca plugin check` renders the panel once per scenario with the real worker on a fresh host.
// The worker reads accounts through the `orca` CLI, so the seats shown are this machine's.
import { defineCheck } from 'orca/testing'

const hour = 3_600_000
const at = 1_794_960_000_000

export default defineCheck({
  fresh: {},
  cooling: {
    storage: {
      state: {
        paused: false,
        health: {},
        paneSeat: {},
        seen: {},
        apiRetries: {},
        modelStep: {},
        waiting: [{ terminalId: 't1', workspaceId: 'w1', agent: 'claude', wakeAt: at + hour }],
        history: [
          { at, provider: 'claude', reason: 'rate_limit', result: 'resumed', from: 'claude:system', to: 'claude:a', terminalId: 't2' },
          { at: at + 1000, provider: 'claude', reason: 'rate_limit', result: 'waiting', from: 'claude:a', terminalId: 't1', detail: 'every seat limited' }
        ]
      }
    }
  },
  paused: {
    storage: {
      state: { paused: true, health: {}, paneSeat: {}, seen: {}, apiRetries: {}, modelStep: {}, waiting: [], history: [] }
    }
  }
})
