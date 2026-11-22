// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { SettingValues } from './core/settings.ts'
import type { Provider, Snapshot } from './core/types.ts'

/** What the panel's console status line switch shows: the focused workspace and whether the
 *  line is installed there (or why it cannot be). */
export type ConsoleLineState = { installed: boolean; workspace?: string; reason?: string }

export type { Snapshot }

export type { SettingValues } from './core/settings.ts'

/** Unsent text a pane shows in its input box (trimmed), and the pane. `queued`: it is Claude's
 *  hint for queued messages (sent, waiting in the session), not text the user typed. */
export type UnsentDraft = { terminalId: string; text: string; queued?: boolean }

declare module 'orca' {
  interface PluginRequests {
    /** Seats, cooldowns, parked sessions and recent history. */
    'rotator.snapshot': { input: { refresh?: boolean; directQuota?: boolean }; output: Snapshot }
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
    /** The Settings tab: read every shown setting (settings.ts), or with `key` and `value` change one first. */
    'rotator.settings': { input: { key?: string; value?: string | number | boolean }; output: SettingValues }
    /** Custom order: move an account one place up (-1) or down (1) in its service's order. */
    'rotator.moveSeat': { input: { seatKey: string; by: number }; output: { ok: true } }
    /** Re-reads which service the current terminal's agent belongs to; the panel polls this
     *  while open because switching terminal tabs raises no event. */
    'rotator.focus': { input: Record<string, never>; output: { focused?: Provider } }
    /** The panel's *Hand off to this account*: select that account for its service, hand off the
     *  session on screen when it runs that service and is between turns (plain unsent text goes
     *  with it), and turn the service's automatic hand-off off so the choice is never undone.
     *  When the session shows unsent text that cannot go along, nothing is handed off and the
     *  text comes back as `draft`, with the pane it is in: the panel asks, and only its *Hand off
     *  anyway* sends the request again with `acceptDraft: true` and that same `draft`. The pane
     *  then moves only while it is that pane and its text is still exactly that; other text
     *  comes back as `draft` again. */
    'rotator.switchTo': { input: { seatKey: string; acceptDraft?: boolean; draft?: UnsentDraft }; output: { message: string; draft?: UnsentDraft } }
    'rotator.cancelWaiting': { input: { terminalId: string }; output: { ok: true } }
    /** *Not now* to "Ask me first": the session on screen waits for another tab, with no countdown. */
    'rotator.declineHandoff': { input: { terminalId: string }; output: { ok: true } }
    /** *Hand off now* for a waiting session (the one on screen, held for the user). `message`
     *  says why it was not handed off, when it was not. */
    'rotator.handoffNow': { input: { terminalId: string }; output: { ok: true; message?: string } }
    /** For looking into a problem (`orca plugin dev request`), not used by the panel: the last
     *  few status events, the focused workspace's agents and the workspaces Orca lists. */
    'rotator.debug': { input: Record<string, never>; output: Record<string, unknown> }
    /** Local HTTP proxy status / start / stop and endpoint latency bench (`oahd`). */
    'rotator.proxyStatus': { input: Record<string, never>; output: { running: boolean; host: string; port: number; providers: { id: string; name: string; kind: string; baseUrl: string; priority: number; enabled: boolean; circuit: string; consecutiveFailures: number }[] } }
    'rotator.proxyStart': { input: { port?: number }; output: { running: boolean; host: string; port: number; providers: any[] } }
    'rotator.proxyStop': { input: Record<string, never>; output: { running: boolean; host: string; port: number; providers: any[] } }
    'rotator.bench': { input: Record<string, never>; output: { results: { id: string; name: string; kind: string; baseUrl: string; ok: boolean; latencyMs: number; band: string; error?: string }[] } }
    'rotator.linkQuota': { input: { seatKey: string; linked: boolean }; output: Snapshot }
    'rotator.pins': { input: Record<string, never>; output: { pins: Record<string, string> } }
    'rotator.pin': { input: { target: string; seatKey: string }; output: { pins: Record<string, string> } }
    'rotator.unpin': { input: { target: string }; output: { pins: Record<string, string> } }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel when anything the panel shows changes. */
    'rotator.changed': Snapshot
    /** Posted when the focused workspace changes: the console status line state there, so the
     *  panel's switch never shows the previous workspace's. */
    'rotator.consoleLine': ConsoleLineState
    /** Posted when the plugin's settings change, also from Orca's Settings page. */
    'rotator.settings': SettingValues
  }
}
