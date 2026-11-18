// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { Provider, Snapshot } from './types'

/** What the panel's console status line switch shows: the focused workspace and whether the
 *  line is installed there (or why it cannot be). */
export type ConsoleLineState = { installed: boolean; workspace?: string; reason?: string }

export type { Snapshot }

/** Unsent text a pane shows in its input box (trimmed), and the pane. */
export type UnsentDraft = { terminalId: string; text: string }

declare module 'orca' {
  interface PluginRequests {
    /** Seats, cooldowns, parked sessions and recent history. */
    'rotator.snapshot': { input: { refresh?: boolean }; output: Snapshot }
    /** Pause or resume automatic hand-off. */
    'rotator.pause': { input: { paused: boolean }; output: { paused: boolean } }
    /** Forget a seat's cooldown (e.g. after buying more usage). */
    'rotator.clearCooldown': { input: { seatKey: string }; output: { ok: true } }
    /** Turn automatic hand-off on or off for one service. */
    'rotator.setService': {
      input: { provider: string; enabled: boolean }
      output: { services: Snapshot['services'] }
    }
    /** The Claude console status line in the focused workspace: read it, or with `enabled` install or remove it. */
    'rotator.consoleLine': { input: { enabled?: boolean }; output: ConsoleLineState & { message?: string } }
    /** Stop waiting to resume a parked session. */
    /** Re-reads which service the current terminal's agent belongs to; the panel polls this
     *  while open because switching terminal tabs raises no event. */
    'rotator.focus': { input: Record<string, never>; output: { focused?: Provider } }
    /** The panel's *Manual switch*: select that account for its service, move the current
     *  terminal's pane when it runs that service and is between turns, and turn the service's
     *  automatic hand-off off so the choice is never undone; the panel offers the toggle. */
    /** When the pane that would move shows unsent text, nothing is switched and the text comes
     *  back as `draft`, with the pane it is in: the panel asks, and only its *Move anyway* sends
     *  the request again with `acceptDraft: true` and that same `draft`. The pane then moves only
     *  while it is that pane and its text is still exactly that; other text comes back as
     *  `draft` again. */
    'rotator.switchTo': { input: { seatKey: string; acceptDraft?: boolean; draft?: UnsentDraft }; output: { message: string; draft?: UnsentDraft } }
    'rotator.cancelWaiting': { input: { terminalId: string }; output: { ok: true } }
    /** The one-time note about `custom` mode was read. */
    'rotator.dismissNotice': { input: Record<string, never>; output: { ok: true } }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel when anything the panel shows changes. */
    'rotator.changed': Snapshot
    /** Posted when the focused workspace changes: the console status line state there, so the
     *  panel's switch never shows the previous workspace's. */
    'rotator.consoleLine': ConsoleLineState
  }
}
