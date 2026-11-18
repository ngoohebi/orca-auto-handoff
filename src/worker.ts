// The plugin's worker: wires Orca events, the launch hook, commands, the panel and a 30 s tick
// to the Rotator. A save restarts the worker; everything that must last lives in orca.storage.
import type { OrcaWorkerApi } from 'orca/worker'
import { nodeCli } from './cli'
import { Rotator, type Deps, type StatusEvent } from './engine'
import { PROVIDER_NAME } from './labels'
import { LIVE_KEY, liveFileName } from './live-usage'
import { DATA_DIR, LIVE_DIR } from './statusline'
import { ConsoleStatusLine, nodeFiles, memoryFiles, type Files } from './statusline-files'
import { DEFAULT_CONFIG, PROVIDERS, type Config, type Provider, type RotatorState, type Snapshot } from './types'
import './protocol'

const STATE_KEY = 'state'
const USAGE_KEY = 'usage'
const SAMPLES_KEY = 'usage-samples'

/** The tick follows the usage read period but never runs slower than 30 s, so parked sessions and
 *  cooldowns stay on time; the CLI is still called only once per read period. */
export function tickMs(pollIntervalSeconds: number): number {
  return Math.min(30, Math.max(15, pollIntervalSeconds)) * 1000
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

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
    pollIntervalSeconds: clamp(num('poll_interval_seconds', d.pollIntervalSeconds), 15, 3600),
    usageCacheMaxAgeHours: clamp(num('usage_cache_max_age_hours', d.usageCacheMaxAgeHours), 0, 720),
    handoffMaxChars: num('handoff_max_chars', d.handoffMaxChars),
    orcaCliPath: str('orca_cli_path', d.orcaCliPath),
    services: Object.fromEntries(
      PROVIDERS.map((p) => [p, bool(`service_${p}`, d.services[p])])
    ) as Config['services']
  }
}

/** `Claude 2/3 · 7%·18% | Codex 1/3 · 0%` — only providers with more than one seat. */
export function statusText(snapshot: Snapshot): { text: string; tone: 'neutral' | 'warning' | 'danger'; tooltip: string } {
  const parts: string[] = []
  const remembered: string[] = []
  let tone: 'neutral' | 'warning' | 'danger' = 'neutral'
  for (const provider of PROVIDERS) {
    const seats = snapshot.seats.filter((s) => s.provider === provider)
    if (seats.length < 2) continue
    if (snapshot.services?.[provider] === false) {
      parts.push(`${PROVIDER_NAME[provider]} off`)
      continue
    }
    const index = seats.findIndex((s) => s.active)
    const seat = seats[index]
    const pct = [seat?.usage.session?.usedPercent, seat?.usage.weekly?.usedPercent]
      .filter((n): n is number => typeof n === 'number')
      .map((n) => `${Math.round(n)}%`)
      .join('·')
    // `~`: remembered numbers, not Orca's live ones (the age is in the tooltip).
    const approx = seat && seat.usage.source !== undefined && seat.usage.source !== 'live' && pct ? '~' : ''
    if (approx && seat?.usage.asOf) {
      remembered.push(`${PROVIDER_NAME[provider]}: last reading ${new Date(seat.usage.asOf).toLocaleString()}`)
    }
    parts.push(`${PROVIDER_NAME[provider]} ${index + 1}/${seats.length}${pct ? ` · ${approx}${pct}` : ''}`)
    const worst = Math.max(seat?.usage.session?.usedPercent ?? 0, seat?.usage.weekly?.usedPercent ?? 0)
    if (worst >= 80 && tone === 'neutral') tone = 'warning'
  }
  if (snapshot.waiting.length > 0) tone = 'danger'
  const text = (snapshot.paused ? 'paused · ' : '') + (parts.join(' | ') || 'Auto Hand-off')
  const tooltip = snapshot.waiting.length
    ? `${snapshot.waiting.length} session(s) waiting for a limit to reset`
    : snapshot.paused
      ? 'Automatic hand-off is paused'
      : 'Automatic hand-off is on. Click to hand Claude off to the next account.'
  return { text, tone, tooltip: remembered.length ? `${tooltip}\n${remembered.join('\n')}` : tooltip }
}

let timer: ReturnType<typeof setTimeout> | undefined
let active: Rotator | undefined

export async function activateWith(
  orca: OrcaWorkerApi,
  overrides: Partial<Deps> = {},
  /** `files` defaults to an in-memory stand-in so tests never touch the real home directory;
   *  `activate` passes the real one. */
  options: { tick?: boolean; files?: Files } = {}
): Promise<Rotator> {
  let lastStatus = ''
  const files = options.files ?? memoryFiles()
  const consoleLine = new ConsoleStatusLine(files, {
    host: orca.host as unknown as Deps['host'],
    settings: () => orca.settings.get().catch(() => ({})) as Promise<Record<string, unknown>>,
    log: (m) => orca.log(m),
    now: () => overrides.now?.() ?? Date.now()
  })
  const deps: Deps = {
    host: orca.host as unknown as Deps['host'],
    cli: nodeCli(async () => (await readConfig(orca)).orcaCliPath),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    loadState: async () => (await orca.storage.get(STATE_KEY)) as RotatorState | null,
    saveState: (state) => orca.storage.set(STATE_KEY, state as never),
    loadUsage: () => orca.storage.get(USAGE_KEY),
    saveUsage: (cache) => orca.storage.set(USAGE_KEY, cache as never),
    loadSamples: () => orca.storage.get(SAMPLES_KEY),
    saveSamples: (samples) => orca.storage.set(SAMPLES_KEY, samples as never),
    readLive: async (liveKey) => (LIVE_KEY.test(liveKey) ? files.read(`${files.home}/${DATA_DIR}/${LIVE_DIR}/${liveFileName(liveKey)}`) : null),
    config: () => readConfig(orca),
    log: (message) => orca.log(message),
    notify: async (title, body) => {
      await orca.host.call('notifications.show', { title, body }).catch(() => undefined)
    },
    publish: (snapshot) => {
      orca.panels.post('rotator.changed', snapshot as never)
      void consoleLine.writeStatus(snapshot)
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
  active = rotator
  await rotator.init()
  // Load accounts now so the launch hook (2 s budget, no CLI) can record seats from the start.
  void rotator.accounts().then(() => rotator.publishNow())

  orca.events.on('agent.status.changed', (payload) => rotator.onAgentStatus(payload as StatusEvent))
  // The panel lists the service of the agent in the focused workspace first.
  orca.events.on('workspace.changed', async () => {
    if (await rotator.refreshFocus()) rotator.publishNow()
  })

  orca.hooks.on('agent.launch.before', (event) => {
    rotator.noteLaunch(event.agent, event.terminalId, event.workspaceId)
  })

  orca.commands.register('rotator.next', async (args) => {
    const provider = (typeof args === 'string' ? args : 'claude') as Provider
    return rotator.selectNext(PROVIDERS.includes(provider) ? provider : 'claude')
  })
  orca.commands.register('rotator.nextCodex', () => rotator.selectNext('codex'))
  orca.commands.register('rotator.swapThisPane', () => rotator.swapFocused())
  orca.commands.register('rotator.togglePause', async () => {
    await rotator.setPaused(!rotator.state.paused)
    return rotator.state.paused ? 'Automatic hand-off paused' : 'Automatic hand-off resumed'
  })
  orca.commands.register('rotator.refresh', async () => {
    await rotator.accounts(true)
    rotator.publishNow()
    return 'Usage read from Orca. Accounts not in use update when Orca fetches them (its usage view, or right after a switch).'
  })
  orca.commands.register('rotator.installStatusLine', () => consoleLine.install())
  orca.commands.register('rotator.uninstallStatusLine', () => consoleLine.uninstall())

  orca.panels.handle('rotator.snapshot', async ({ refresh }) => {
    await Promise.all([rotator.accounts(!!refresh), rotator.refreshFocus()])
    return rotator.snapshot()
  })
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
    // The console status line format lives in the status file.
    consoleLine.invalidate()
    rotator.publishNow()
    // A new usage read period applies at once.
    if (options.tick !== false) void schedule()
  })

  orca.panels.handle('rotator.consoleLine', async ({ enabled }) => {
    if (typeof enabled !== 'boolean') return consoleLine.status()
    const message = enabled ? await consoleLine.install() : await consoleLine.uninstall()
    return { ...(await consoleLine.status()), message }
  })
  orca.panels.handle('rotator.switchTo', async ({ seatKey }) => {
    const { message, switched, provider } = await rotator.forceTo(seatKey)
    if (!switched || rotator.services[provider] === false) return { message }
    // A manual choice must not be undone by the rotator: automatic hand-off for the service
    // stops here, and the user turns it on again when they want rotation back.
    await orca.settings.set(`service_${provider}`, false)
    await rotator.refreshServices()
    rotator.publishNow()
    const name = PROVIDER_NAME[provider]
    void orca.host.call('notifications.show', { title: 'Auto Hand-off', body: `${name}: automatic hand-off is off after your manual switch. Turn Auto hand-off ${name} on to resume.` }).catch(() => undefined)
    return { message: `${message}. Automatic hand-off for ${name} is now off; turn Auto hand-off ${name} on again to resume` }
  })
  orca.panels.handle('rotator.focus', async () => {
    if (await rotator.refreshFocus()) rotator.publishNow()
    return rotator.focused ? { focused: rotator.focused } : {}
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

  // Self-rescheduling so a changed `poll_interval_seconds` takes effect without a restart.
  let generation = 0
  const schedule = async (): Promise<void> => {
    const mine = ++generation
    if (timer) clearTimeout(timer)
    const period = tickMs((await readConfig(orca)).pollIntervalSeconds)
    if (mine !== generation) return
    timer = setTimeout(async () => {
      await rotator.tick().catch((error) => orca.log(`tick failed: ${String(error?.message ?? error)}`))
      if (mine === generation) void schedule()
    }, period)
  }
  if (options.tick !== false) {
    void rotator.tick().catch((error) => orca.log(`tick failed: ${String(error?.message ?? error)}`))
    void schedule()
  }
  return rotator
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  await activateWith(orca, {}, { files: nodeFiles() })
}

export function deactivate(): void {
  if (timer) clearTimeout(timer)
  timer = undefined
  active?.dispose()
  active = undefined
}
