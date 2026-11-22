// Thin Orca plugin worker: zero business logic, zero local state.
// Connects to `oahd` over its Unix domain socket (auto-starting `oahd` on demand), registers as
// the live Orca host bridge (for `agent.resume`, `notifications.show`, etc.), forwards Orca events
// to `oahd`, relays panel RPCs & commands to `oahd`, and pushes `oahd` updates to the panel.
import { createConnection, type Socket } from 'node:net'
import type { OrcaWorkerApi } from 'orca/worker'
import { OahClient } from '../cli/client.ts'
import { createLineParser, encodeMessage, type WireMessage } from '../daemon/ipc.ts'
import { resolveOahHome, socketPathFor } from '../daemon/store.ts'
import '../protocol.ts'

export type ThinWorkerOptions = {
  home?: string
  sockPath?: string
  autoStart?: boolean
}

type BridgeHandle = {
  stop(): void
}

function connectBridge(
  orca: OrcaWorkerApi,
  sockPath: string,
  ensure: () => Promise<void>
): BridgeHandle {
  let stopped = false
  let sock: Socket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let seq = 0

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void open()
    }, 1000)
  }

  const open = async () => {
    if (stopped) return
    try {
      await ensure()
    } catch (err) {
      orca.log(`oahd unavailable: ${String((err as Error)?.message ?? err)}`)
      scheduleReconnect()
      return
    }
    if (stopped) return

    const s = createConnection(sockPath)
    sock = s
    s.setEncoding('utf8')

    const parse = createLineParser((msg: WireMessage) => {
      if (msg.type === 'event') {
        if (msg.event === 'snapshot') orca.panels.post('rotator.changed', msg.data as any)
        else if (msg.event === 'settings') orca.panels.post('rotator.settings', msg.data as any)
        else if (msg.event === 'consoleLine') orca.panels.post('rotator.consoleLine', msg.data as any)
        return
      }
      if (msg.type === 'req' && msg.method === 'host.call') {
        const p = (msg.params ?? {}) as { method: string; params?: unknown }
        void Promise.resolve(orca.host.call(p.method as any, p.params as any)).then(
          (result) => {
            try {
              s.write(encodeMessage({ type: 'res', id: msg.id, ok: true, result }))
            } catch {
              // Socket closed.
            }
          },
          (err) => {
            try {
              s.write(encodeMessage({ type: 'res', id: msg.id, ok: false, error: { message: String((err as Error)?.message ?? err) } }))
            } catch {
              // Socket closed.
            }
          }
        )
      }
    })

    s.on('data', (chunk) => parse(chunk.toString('utf8')))
    s.on('connect', () => {
      s.write(encodeMessage({ type: 'req', id: `w${++seq}`, method: 'bridge.register', params: {} }))
      s.write(encodeMessage({ type: 'req', id: `w${++seq}`, method: 'subscribe', params: {} }))
    })
    s.on('error', () => {
      // Handled by close.
    })
    s.on('close', () => {
      if (sock === s) sock = null
      scheduleReconnect()
    })
  }

  void open()

  return {
    stop() {
      stopped = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      sock?.destroy()
      sock = null
    }
  }
}

let activeBridge: BridgeHandle | undefined

export async function activateThin(orca: OrcaWorkerApi, opts: ThinWorkerOptions = {}): Promise<BridgeHandle> {
  const home = opts.home ?? resolveOahHome()
  const sockPath = opts.sockPath ?? socketPathFor(home)
  const client = new OahClient(home, sockPath)
  const ensure = async () => {
    if (opts.autoStart !== false) await client.ensureDaemon()
  }
  const rpc = async <T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> => {
    await ensure()
    return client.call<T>(method, params, timeoutMs)
  }

  const bridge = connectBridge(orca, sockPath, ensure)
  activeBridge = bridge

  // Forward Orca host events to oahd.
  orca.events.on('agent.status.changed', async (payload) => {
    await rpc('event.status', (payload ?? {}) as Record<string, unknown>).catch((err) => {
      orca.log(`event.status failed: ${String((err as Error)?.message ?? err)}`)
    })
  })
  orca.events.on('workspace.changed', async () => {
    await rpc('event.workspace', {}).catch(() => undefined)
  })
  orca.hooks.on('agent.launch.before', (event) => {
    void rpc('event.launchBefore', (event ?? {}) as Record<string, unknown>).catch(() => undefined)
  })

  // Relay Orca commands to oahd.
  orca.commands.register('rotator.next', async (args) => {
    const provider = typeof args === 'string' ? args : 'claude'
    return (await rpc<{ message: string }>('nextAccount', { provider })).message
  })
  orca.commands.register('rotator.nextCodex', async () => {
    return (await rpc<{ message: string }>('nextAccount', { provider: 'codex' })).message
  })
  orca.commands.register('rotator.swapThisPane', async () => {
    return (await rpc<{ message: string }>('handoff', {})).message
  })
  orca.commands.register('rotator.togglePause', async () => {
    const snap = await rpc<{ paused: boolean }>('snapshot', {})
    const next = !snap.paused
    await rpc('pause', { paused: next })
    return next ? 'Automatic hand-off paused' : 'Automatic hand-off resumed'
  })
  orca.commands.register('rotator.refresh', async () => {
    await rpc('snapshot', { refresh: true })
    return 'Usage refreshed from Orca.'
  })
  orca.commands.register('rotator.installStatusLine', async () => {
    const res = await rpc<{ message?: string }>('consoleLine', { enabled: true })
    return res.message ?? 'Status line installed.'
  })
  orca.commands.register('rotator.uninstallStatusLine', async () => {
    const res = await rpc<{ message?: string }>('consoleLine', { enabled: false })
    return res.message ?? 'Status line removed.'
  })

  // Relay account pool and daemon controls to oahd.
  orca.panels.handle('rotator.snapshot', (input) => rpc('snapshot', (input ?? {}) as Record<string, unknown>))
  orca.panels.handle('rotator.pause', (input) => rpc('pause', (input ?? {}) as Record<string, unknown>))
  orca.panels.handle('rotator.setService', (input) => rpc('setService', (input ?? {}) as Record<string, unknown>))
  orca.panels.handle('rotator.settings', (input) => rpc('settings', (input ?? {}) as Record<string, unknown>))
  orca.panels.handle('rotator.moveSeat', (input) => rpc('moveSeat', (input ?? {}) as Record<string, unknown>))
  orca.panels.handle('rotator.clearCooldown', (input) => rpc('clearCooldown', (input ?? {}) as Record<string, unknown>))
  orca.panels.handle('rotator.switchTo', (input) => rpc('switchTo', (input ?? {}) as Record<string, unknown>, 60_000))
  orca.panels.handle('rotator.focus', () => rpc('focus', {}))
  orca.panels.handle('rotator.cancelWaiting', (input) => rpc('cancelWaiting', (input ?? {}) as Record<string, unknown>))
  orca.panels.handle('rotator.handoffNow', (input) => rpc('handoffNow', (input ?? {}) as Record<string, unknown>, 60_000))
  orca.panels.handle('rotator.declineHandoff', (input) => rpc('declineHandoff', (input ?? {}) as Record<string, unknown>))
  orca.panels.handle('rotator.consoleLine', (input) => rpc('consoleLine', (input ?? {}) as Record<string, unknown>))
  orca.panels.handle('rotator.debug', () => rpc('debug', {}))
  orca.panels.handle('rotator.pins', () => rpc('pins', {}))
  orca.panels.handle('rotator.pin', (input) => rpc('pin', (input ?? {}) as Record<string, unknown>))
  orca.panels.handle('rotator.unpin', (input) => rpc('unpin', (input ?? {}) as Record<string, unknown>))

  return bridge
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  await activateThin(orca)
}

export function deactivate(): void {
  activeBridge?.stop()
  activeBridge = undefined
}
