// The plugin's worker: wires Orca events, the launch hook, commands, the panel and a 30 s tick
// to the Rotator. A save restarts the worker; everything that must last lives in orca.storage.
import type { OrcaWorkerApi } from 'orca/worker'
import { nodeCli } from './cli'
import { Rotator, type Deps, type StatusEvent } from './engine'
import { DEFAULT_CONFIG, PROVIDERS, type Config, type Provider, type RotatorState, type Snapshot } from './types'
import './protocol'

const STATE_KEY = 'state'
const TICK_MS = 30_000

export async function readConfig(orca: Pick<OrcaWorkerApi, 'settings'>): Promise<Config> {
  const s = (await orca.settings.get().catch(() => ({}))) as Record<string, unknown>
  const num = (k: string, d: number) => (typeof s[k] === 'number' ? (s[k] as number) : d)
  const bool = (k: string, d: boolean) => (typeof s[k] === 'boolean' ? (s[k] as boolean) : d)
  const str = (k: string, d: string) => (typeof s[k] === 'string' ? (s[k] as string) : d)
  const strategy = str('strategy', DEFAULT_CONFIG.strategy)
  const d = DEFAULT_CONFIG
  return {
    thresholdFiveHour: num('thresholds_five_hour', d.thresholdFiveHour),
    thresholdSevenDay: num('thresholds_seven_day', d.thresholdSevenDay),
    strategy: (['drain', 'balanced', 'priority', 'soonest-reset', 'manual'].includes(strategy) ? strategy : d.strategy) as Config['strategy'],
    autoSwitchOnThreshold: bool('auto_switch_on_threshold', d.autoSwitchOnThreshold),
    switchBack: bool('switch_back', d.switchBack),
    switchCooldownMinutes: num('switch_cooldown_minutes', d.switchCooldownMinutes),
    minHeadroomGap: num('min_headroom_gap', d.minHeadroomGap),
    autoSwapIdleAfterSeconds: num('auto_swap_idle_after_seconds', d.autoSwapIdleAfterSeconds),
    exclude: str('exclude', d.exclude),
    autoSwitchOnRateLimit: bool('auto_switch_on_rate_limit', d.autoSwitchOnRateLimit),
    autoResume: bool('auto_resume', d.autoResume),
    autoMessage: str('auto_message', d.autoMessage),
    waitForReset: bool('wait_for_reset', d.waitForReset),
    retryOnApiError: bool('retry_on_api_error', d.retryOnApiError),
    maxApiRetries: num('max_api_retries', d.maxApiRetries),
    chain: str('chain', d.chain),
    modelFallback: str('model_fallback', d.modelFallback),
    defaultCooldownMinutes: num('default_cooldown_minutes', d.defaultCooldownMinutes),
    pollIntervalSeconds: num('poll_interval_seconds', d.pollIntervalSeconds),
    handoffMaxChars: num('handoff_max_chars', d.handoffMaxChars),
    orcaCliPath: str('orca_cli_path', d.orcaCliPath),
    services: Object.fromEntries(
      PROVIDERS.map((p) => [p, bool(`service_${p}`, d.services[p])])
    ) as Config['services']
  }
}

/** `claude 2/3 · 7%·18% | codex 1/3 · 0%` — only providers with more than one seat. */
export function statusText(snapshot: Snapshot): { text: string; tone: 'neutral' | 'warning' | 'danger'; tooltip: string } {
  const parts: string[] = []
  let tone: 'neutral' | 'warning' | 'danger' = 'neutral'
  for (const provider of PROVIDERS) {
    const seats = snapshot.seats.filter((s) => s.provider === provider)
    if (seats.length < 2) continue
    if (snapshot.services?.[provider] === false) {
      parts.push(`${provider} off`)
      continue
    }
    const index = seats.findIndex((s) => s.active)
    const seat = seats[index]
    const pct = [seat?.usage.session?.usedPercent, seat?.usage.weekly?.usedPercent]
      .filter((n): n is number => typeof n === 'number')
      .map((n) => `${Math.round(n)}%`)
      .join('·')
    parts.push(`${provider} ${index + 1}/${seats.length}${pct ? ` · ${pct}` : ''}`)
    const worst = Math.max(seat?.usage.session?.usedPercent ?? 0, seat?.usage.weekly?.usedPercent ?? 0)
    if (worst >= 80 && tone === 'neutral') tone = 'warning'
  }
  if (snapshot.waiting.length > 0) tone = 'danger'
  const text = (snapshot.paused ? 'paused · ' : '') + (parts.join(' | ') || 'Account Rotator')
  const tooltip = snapshot.waiting.length
    ? `${snapshot.waiting.length} session(s) waiting for a limit to reset`
    : snapshot.paused
      ? 'Automatic switching is paused'
      : 'Automatic account switching is on. Click to switch to the next account.'
  return { text, tone, tooltip }
}

let timer: ReturnType<typeof setInterval> | undefined

export async function activateWith(
  orca: OrcaWorkerApi,
  overrides: Partial<Deps> = {},
  options: { tick?: boolean } = {}
): Promise<Rotator> {
  let lastStatus = ''
  const deps: Deps = {
    host: orca.host as unknown as Deps['host'],
    cli: nodeCli(async () => (await readConfig(orca)).orcaCliPath),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    loadState: async () => (await orca.storage.get(STATE_KEY)) as RotatorState | null,
    saveState: (state) => orca.storage.set(STATE_KEY, state as never),
    config: () => readConfig(orca),
    log: (message) => orca.log(message),
    notify: async (title, body) => {
      await orca.host.call('notifications.show', { title, body }).catch(() => undefined)
    },
    publish: (snapshot) => {
      orca.panels.post('rotator.changed', snapshot as never)
      const status = statusText(snapshot)
      const key = JSON.stringify(status)
      if (key === lastStatus) return
      lastStatus = key
      void orca.host
        .call('statusBar.update', { id: 'seat', text: status.text, tone: status.tone, tooltip: status.tooltip, icon: snapshot.paused ? 'pause' : 'gauge' })
        .catch(() => undefined)
    },
    ...overrides
  }
  const rotator = new Rotator(deps)
  await rotator.init()
  // Load accounts now so the launch hook (2 s budget, no CLI) can record seats from the start.
  void rotator.accounts().then(() => rotator.publishNow())

  orca.events.on('agent.status.changed', (payload) => rotator.onAgentStatus(payload as StatusEvent))

  orca.hooks.on('agent.launch.before', (event) => {
    rotator.noteLaunch(event.agent, event.terminalId)
  })

  orca.commands.register('rotator.next', async (args) => {
    const provider = (typeof args === 'string' ? args : 'claude') as Provider
    return rotator.selectNext(PROVIDERS.includes(provider) ? provider : 'claude')
  })
  orca.commands.register('rotator.nextCodex', () => rotator.selectNext('codex'))
  orca.commands.register('rotator.swapThisPane', () => rotator.swapFocused())
  orca.commands.register('rotator.togglePause', async () => {
    await rotator.setPaused(!rotator.state.paused)
    return rotator.state.paused ? 'Automatic switching paused' : 'Automatic switching resumed'
  })
  orca.commands.register('rotator.refresh', async () => {
    await rotator.accounts(true)
    rotator.publishNow()
    return 'Usage refreshed'
  })

  orca.panels.handle('rotator.snapshot', async ({ refresh }) => {
    await rotator.accounts(!!refresh)
    return rotator.snapshot()
  })
  orca.panels.handle('rotator.select', async ({ seatKey }) => ({ message: await rotator.selectSeat(seatKey) }))
  orca.panels.handle('rotator.pause', async ({ paused }) => {
    await rotator.setPaused(paused)
    return { paused }
  })
  orca.panels.handle('rotator.setService', async ({ provider, enabled }) => {
    if (!PROVIDERS.includes(provider as Provider)) {
      throw Object.assign(new Error(`Unknown service ${provider}`), { code: 'invalid_params' })
    }
    await orca.settings.set(`service_${provider}`, enabled)
    await rotator.refreshServices()
    return { services: rotator.services }
  })
  // Changing it in Orca's Settings takes effect at once too.
  orca.settings.onDidChange(() => {
    void rotator.refreshServices()
  })

  orca.panels.handle('rotator.cancelWaiting', async ({ terminalId }) => {
    await rotator.cancelWaiting(terminalId)
    return { ok: true as const }
  })
  orca.panels.handle('rotator.clearCooldown', async ({ seatKey }) => {
    await rotator.clearCooldown(seatKey)
    return { ok: true as const }
  })

  orca.panels.handle('rotator.debug', async () => {
    const focused = await orca.host.call('agents.list').catch((e: Error) => ({ error: e.message }))
    const workspaces = await orca.host
      .call('workspace.list')
      .then((r) => r.workspaces.map((w) => ({ id: w.id, path: w.path })))
      .catch((e: Error) => ({ error: e.message }))
    return JSON.parse(JSON.stringify({ events: rotator.recentEvents, focused, workspaces }))
  })

  if (options.tick !== false) {
    const run = () =>
      rotator.tick().catch((error) => orca.log(`tick failed: ${String(error?.message ?? error)}`))
    void run()
    timer = setInterval(run, TICK_MS)
  }
  return rotator
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  await activateWith(orca)
}

export function deactivate(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}
