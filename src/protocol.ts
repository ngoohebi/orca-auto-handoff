// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { Snapshot } from './types'

export type { Snapshot }

declare module 'orca' {
  interface PluginRequests {
    /** Seats, cooldowns, parked sessions and recent history. */
    'rotator.snapshot': { input: { refresh?: boolean }; output: Snapshot }
    /** Make `seatKey` the account new launches of its provider use. */
    'rotator.select': { input: { seatKey: string }; output: { message: string } }
    /** Pause or resume automatic switching. */
    'rotator.pause': { input: { paused: boolean }; output: { paused: boolean } }
    /** Forget a seat's cooldown (e.g. after buying more usage). */
    'rotator.clearCooldown': { input: { seatKey: string }; output: { ok: true } }
    /** Turn automatic switching on or off for one service. */
    'rotator.setService': {
      input: { provider: string; enabled: boolean }
      output: { services: Snapshot['services'] }
    }
    /** Stop waiting to resume a parked session. */
    'rotator.cancelWaiting': { input: { terminalId: string }; output: { ok: true } }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel when anything the panel shows changes. */
    'rotator.changed': Snapshot
  }
}
