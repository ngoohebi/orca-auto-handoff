// The plugin's worker: wires Orca events, the launch hook, commands, the panel and a 30 s tick
// to the Rotator. A save restarts the worker; everything that must last lives in orca.storage.
import { existsSync, watch, type FSWatcher } from 'node:fs'
import type { OrcaWorkerApi } from 'orca/worker'
import { nodeCli } from './core/cli.ts'
import { Rotator, type Deps, type StatusEvent } from './core/engine.ts'
import { PROVIDER_NAME } from './core/labels.ts'
import { ALL_SETTINGS, checked, LEGACY_KEYS, settingValues, upgradedValues, wasManual, type SettingValues } from './core/settings.ts'
import { LIVE_KEY, liveFileName } from './core/live-usage.ts'
import { DATA_DIR, LIVE_DIR } from './core/statusline.ts'
import { ConsoleStatusLine, nodeFiles, memoryFiles, type Files } from './core/statusline-files.ts'
import { DEFAULT_CONFIG, PROVIDERS, type Config, type Held, type Provider, type RotatorState } from './core/types.ts'
import './protocol'

const STATE_KEY = 'state'
const USAGE_KEY = 'usage'
const SAMPLES_KEY = 'usage-samples'
/** The one-time pause for an older "manual" setting was done. */
const MANUAL_KEY = 'migrated-manual'
/** The one-time upgrade of 0.2 settings was done. */
const UPGRADE_KEY = 'upgraded-0.3'

/** The tick follows the usage read period but never runs slower than 30 s, so parked sessions and
 *  cooldowns stay on time; the CLI is still called only once per read period. */
const MAX_TICK_MS = 30_000
export function tickMs(pollIntervalSeconds: number): number {
  return Math.min(MAX_TICK_MS, Math.max(15_000, pollIntervalSeconds * 1000))
}

/** When the next tick runs: after `period`, or sooner when a countdown for the session on screen
 *  runs out before that (`due` ms from now; engine.ts `countdownDueIn`), so the hand-off comes
 *  when the countdown said and not up to a tick later. Never sooner than a second. */
export function nextTickMs(period: number, due: number | undefined): number {
  return due === undefined ? period : Math.min(period, Math.max(1000, due + 250))
}

/** The plugin's stored settings, with the 0.2 ones the upgrade reads. Orca's `settings.get()`
 *  returns only the settings orca-plugin.json declares (live: an old `switch_early` was missing
 *  from it), so each 0.2 key is asked for by name; one Orca does not have stays absent. Fails
 *  when Orca cannot be asked: the upgrade must not take "could not read" for "nothing stored". */
export async function storedSettings(orca: Pick<OrcaWorkerApi, 'settings'>): Promise<Record<string, unknown>> {
  const s = { ...((await orca.settings.get()) as Record<string, unknown>) }
  for (const key of LEGACY_KEYS) {
    if (s[key] !== undefined) continue
    const value = await orca.settings.get(key)
    if (value !== undefined && value !== null) s[key] = value
  }
  return s
}

/** Every service's Automatic hand-off off: what runs while the settings cannot be trusted. */
const ALL_OFF: Record<string, unknown> = Object.fromEntries(PROVIDERS.map((p) => [`service_${p}`, false]))

/**
 * Reads the settings for the engine, failing closed: when Orca cannot be asked, the settings as
 * last read stay in effect, and before any were read (or while `held()` says so: the 0.2 upgrade
 * is not done) every service's Automatic hand-off counts as off, so nothing is handed off or
 * resumed by itself on settings nobody chose. The config then says why (`held`), for the panel.
 * Every read asks Orca again, so the hold ends with the first read that works.
 * What the worker itself stores is told to it (`wrote`), so "as last read" never lags behind a
 * change made in the panel.
 */
export function configReader(
  orca: Pick<OrcaWorkerApi, 'settings'>,
  held: () => boolean = () => false,
  log: (message: string) => void = () => undefined
): (() => Promise<Config>) & { wrote(key: string, value: unknown): void } {
  let last: Record<string, unknown> | undefined
  let failed = false
  const read = async (): Promise<Config> => {
    try {
      last = (await orca.settings.get()) as Record<string, unknown>
      failed = false
    } catch (error) {
      if (!failed) log(`could not read the settings: ${String((error as Error)?.message ?? error)}`)
      failed = true
    }
    const why: Held | undefined = !last ? 'settings' : held() ? 'upgrade' : undefined
    return why ? { ...configFrom({ ...last, ...ALL_OFF }), held: why } : configFrom(last!)
  }
  return Object.assign(read, {
    /** A setting the worker itself just stored: it counts at once, also when the next read fails
     *  (a service turned off in the panel must not stay on because Orca could not be asked). */
    wrote(key: string, value: unknown): void {
      if (last) last = { ...last, [key]: value }
    }
  })
}

/**
 * What the engine runs, from the settings (settings.ts):
 * - Pick the next account: Auto ranks by room and pace; Custom order follows the account order
 *   set with the panel's arrows and goes back to an earlier account once it is free.
 * - When to hand off: Early when away leaves an account shortly before it runs out
 *   (`early_minutes` at its pace, or at 97 % of the 5-hour window and 99 % of the week when the
 *   pace is unknown), between turns, moves idle sessions and spends expiring weekly quota, once
 *   the user has been away `away_minutes` (engine.ts `config`); At limit moves a session only
 *   when it hits one.
 * - When everything is used up: wait and resume, or stop.
 * - Session on screen: how the session in the tab Orca shows is handled at a limit.
 */
export function configFrom(s: Record<string, unknown>): Config {
  const v = settingValues(s)
  const d = DEFAULT_CONFIG
  const num = (k: string) => v[k] as number
  const str = (k: string) => v[k] as string
  const early = v.timing === 'early'
  const ordered = v.pick === 'my-order'
  return {
    ...d,
    mode: ordered ? 'my-order' : 'smart',
    strategy: ordered ? 'drain' : 'smart',
    switchBack: ordered,
    horizonMinutes: early ? num('early_minutes') : 0,
    lowFiveHour: early ? 97 : 100,
    floorFiveHour: early && num('early_percent_left') > 0 ? 100 - num('early_percent_left') : 100,
    lowSevenDay: early ? 99 : 100,
    runningSessions: early ? 'move' : 'limit',
    autoSwitchOnThreshold: early,
    autoSwapIdleAfterSeconds: early ? num('idle_minutes') * 60 : 0,
    waitForReset: v.when_all_used !== 'stop',
    switchCooldownMinutes: num('switch_cooldown_minutes'),
    minHeadroomGap: d.minHeadroomGap,
    exclude: str('exclude'),
    autoMessage: str('auto_message'),
    retryOnApiError: num('max_api_retries') > 0,
    maxApiRetries: num('max_api_retries'),
    // The account order counts only for Custom order: Auto ranks by room alone, even when an
    // order was arranged earlier.
    chain: ordered && typeof s.chain === 'string' ? s.chain : d.chain,
    modelFallback: str('model_fallback'),
    defaultCooldownMinutes: num('default_cooldown_minutes'),
    pollIntervalSeconds: num('poll_interval_seconds'),
    usageCacheMaxAgeHours: d.usageCacheMaxAgeHours,
    handoffMaxChars: num('handoff_max_chars'),
    orcaCliPath: str('orca_cli_path'),
    activeTerminal: v.active_terminal as Config['activeTerminal'],
    countdownSeconds: num('active_countdown_seconds'),
    presenceSeconds: num('active_presence_seconds'),
    reminderMinutes: num('active_reminder_minutes'),
    restoreUnsent: v.restore_unsent_text as boolean,
    awayMinutes: num('away_minutes'),
    services: Object.fromEntries(PROVIDERS.map((p) => [p, typeof s[`service_${p}`] === 'boolean' ? s[`service_${p}`] : d.services[p]])) as Config['services']
  }
}

/**
 * The worker's clock: runs `run` (the engine's tick), then again after `period()` ms, or sooner
 * when `due()` says a countdown runs out before that (`nextTickMs`).
 * - `schedule()` sets the next tick afresh (a changed read period, a countdown that began).
 * - One tick at a time: a tick that comes due while one runs waits for it and runs after it (two
 *   that come due meanwhile share that one run), so two ticks never look at the waiting sessions
 *   at once.
 * - `stop()` ends it for good: no timer is left, and a tick or a `schedule()` under way sets none.
 */
export function ticker(o: {
  period(): Promise<number>
  due(): number | undefined
  run(): Promise<void>
  log(message: string): void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}): { schedule(): Promise<void>; now(): Promise<void>; stop(): void } {
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = o.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let generation = 0
  let timer: unknown
  let stopped = false
  let running: Promise<void> | undefined
  let queued: Promise<void> | undefined
  const now = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (!running) {
      const run: Promise<void> = o
        .run()
        .catch((error) => o.log(`tick failed: ${String((error as Error)?.message ?? error)}`))
        .finally(() => {
          if (running === run) running = undefined
        })
      running = run
      return run
    }
    queued ??= running.then(() => {
      queued = undefined
      return now()
    })
    return queued
  }
  const schedule = async (): Promise<void> => {
    if (stopped) return
    const mine = ++generation
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
    const usual = await o.period()
    if (stopped || mine !== generation) return
    timer = setTimer(() => {
      timer = undefined
      void now().then(() => {
        if (!stopped && mine === generation) void schedule()
      })
    }, nextTickMs(usual, o.due()))
  }
  return {
    schedule,
    now,
    stop() {
      stopped = true
      generation++
      if (timer !== undefined) clearTimer(timer)
      timer = undefined
    }
  }
}

let ticks: ReturnType<typeof ticker> | undefined
let active: Rotator | undefined
let liveWatcher: { stop(): void } | undefined

function watchLiveDir(dir: string, onChange: () => void, log: (m: string) => void): { ensure(): void; stop(): void } {
  let watcher: FSWatcher | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const bump = () => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (!stopped) onChange()
    }, 200)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }
  const ensure = () => {
    if (stopped || watcher || !existsSync(dir)) return
    try {
      watcher = watch(dir, () => bump())
      watcher.on('error', () => {
        watcher?.close()
        watcher = undefined
      })
    } catch (error) {
      log(`could not watch live usage directory: ${String((error as Error)?.message ?? error)}`)
    }
  }
  ensure()
  return {
    ensure,
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = undefined
      watcher?.close()
      watcher = undefined
    }
  }
}

export async function activateWith(
  orca: OrcaWorkerApi,
  overrides: Partial<Deps> = {},
  /** `files` defaults to an in-memory stand-in so tests never touch the real home directory;
   *  `activate` passes the real one. `timers`: the clock's timer, for tests that run a tick. */
  options: { tick?: boolean; files?: Files; watchLive?: boolean; timers?: { setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (handle: unknown) => void } } = {}
): Promise<Rotator> {
  const files = options.files ?? memoryFiles()
  /** The 0.2 upgrade could not be done yet (Orca could not be asked): see `upgrade` below. */
  let upgradePending = false
  const readConfig = configReader(orca, () => upgradePending, (m) => orca.log(m))
  /** Stores a setting chosen in the panel, and tells the reader (`configReader`). */
  const store = async (key: string, value: string | number | boolean): Promise<void> => {
    await orca.settings.set(key, value)
    readConfig.wrote(key, value)
  }
  /** The status line's settings as last read. */
  let lineSettings: Record<string, unknown> = {}
  const consoleLine = new ConsoleStatusLine(files, {
    host: orca.host as unknown as Deps['host'],
    settings: async () => {
      try {
        const s = { ...((await orca.settings.get()) as Record<string, unknown>) }
        // The bar width is no declared setting any more, so Orca leaves it out above: a width an
        // older version stored is asked for by name.
        const width = await orca.settings.get('console_statusline_bar_width')
        if (typeof width === 'number') s.console_statusline_bar_width = width
        lineSettings = s
      } catch {
        // Orca cannot be asked: the header as last read stays, rather than the default one.
      }
      return lineSettings
    },
    log: (m) => orca.log(m),
    now: () => overrides.now?.() ?? Date.now()
  })
  const deps: Deps = {
    host: orca.host as unknown as Deps['host'],
    cli: nodeCli(async () => (await readConfig()).orcaCliPath),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    loadState: async () => (await orca.storage.get(STATE_KEY)) as RotatorState | null,
    saveState: (state) => orca.storage.set(STATE_KEY, state as never),
    loadUsage: () => orca.storage.get(USAGE_KEY),
    saveUsage: (cache) => orca.storage.set(USAGE_KEY, cache as never),
    loadSamples: () => orca.storage.get(SAMPLES_KEY),
    saveSamples: (samples) => orca.storage.set(SAMPLES_KEY, samples as never),
    readLive: async (liveKey) => (LIVE_KEY.test(liveKey) ? files.read(`${files.home}/${DATA_DIR}/${LIVE_DIR}/${liveFileName(liveKey)}`) : null),
    config: readConfig,
    log: (message) => orca.log(message),
    notify: async (title, body) => {
      await orca.host.call('notifications.show', { title, body }).catch(() => undefined)
    },
    publish: (snapshot) => {
      // Fire and forget: a post Orca refuses (too large, too many) must not fail what published.
      try {
        orca.panels.post('rotator.changed', snapshot as never)
      } catch (error) {
        orca.log(`could not tell the panel: ${String((error as Error)?.message ?? error)}`)
      }
      void consoleLine.writeStatus(snapshot)
    },
    ...overrides
  }
  const rotator = new Rotator(deps)
  // One worker, one clock: a worker started again in the same process ends the one before.
  ticks?.stop()
  ticks = undefined
  liveWatcher?.stop()
  liveWatcher = undefined
  active?.dispose()
  active = rotator
  await rotator.init()
  const watcher = options.watchLive
    ? watchLiveDir(
        `${files.home}/${DATA_DIR}/${LIVE_DIR}`,
        () => {
          void rotator.syncLivePanes(true).catch((error) => orca.log(`live usage sync failed: ${String((error as Error)?.message ?? error)}`))
        },
        (m) => orca.log(m)
      )
    : undefined
  liveWatcher = watcher
  // The upgrade from 0.2, once: the 0.2 settings (read by name: Orca no longer returns them with
  // the declared ones) are turned into the new ones, which are then stored, so they are read like
  // any setting from here on and a later choice is never overridden by an old value. A setup that
  // did not hand sessions off by itself (settings.ts `wasManual`) has no setting for that any more:
  // automatic hand-off is paused instead, and the user is told.
  // It counts as done only when everything was read and written. Until then (Orca could not be
  // asked) every service counts as off (`configReader`), and it is tried again at each tick and
  // settings change, and at the next start.
  const upgrade = async (): Promise<void> => {
    try {
      if (await orca.storage.get(UPGRADE_KEY)) {
        upgradePending = false
        return
      }
      const stored = await storedSettings(orca)
      // A 0.2 setup: any 0.2 setting stored, or an account order (0.2 followed it by default; in 0.3
      // it is set only by the panel's arrows, so at the first start it can only come from 0.2).
      const ordered = typeof stored.chain === 'string' && stored.chain.trim() !== ''
      if (ordered || LEGACY_KEYS.some((key) => stored[key] !== undefined)) {
        // The pause first: it is the part that keeps sessions from being handed off.
        if (wasManual(stored) && !(await orca.storage.get(MANUAL_KEY))) {
          await rotator.setPaused(true)
          await orca.storage.set(MANUAL_KEY, true as never)
          await orca.host
            .call('notifications.show', { title: 'Auto Hand-off', body: 'Your earlier settings kept Auto Hand-off from handing sessions off by itself. Those settings are gone, so automatic hand-off is paused instead; turn Automatic hand-off on in the panel when you want it.' })
            .catch(() => undefined)
        }
        for (const [key, value] of Object.entries(upgradedValues(stored))) {
          if (value !== undefined) await orca.settings.set(key, value)
        }
      }
      await orca.storage.set(UPGRADE_KEY, true as never)
      upgradePending = false
    } catch (error) {
      if (!upgradePending) orca.log(`could not carry the earlier settings over yet; automatic hand-off waits: ${String((error as Error)?.message ?? error)}`)
      upgradePending = true
    }
  }
  await upgrade()
  // What the panel shows of the settings (the mode, the services) follows what was just written.
  await rotator.refreshServices(false)
  // Self-rescheduling, so a changed `poll_interval_seconds` takes effect without a restart.
  const clock =
    options.tick === false
      ? undefined
      : ticker({
          period: async () => tickMs((await readConfig()).pollIntervalSeconds),
          due: () => rotator.countdownDueIn(),
          run: async () => {
            watcher?.ensure()
            if (upgradePending) await retryUpgrade()
            await rotator.tick()
          },
          log: (m) => orca.log(m),
          ...options.timers
        })
  ticks = clock
  /** One retry at a time: the settings it writes are themselves settings changes. */
  let retrying: Promise<void> | undefined
  const retryUpgrade = (): Promise<void> =>
    (retrying ??= (async () => {
      await upgrade()
      if (!upgradePending) await rotator.refreshServices()
    })().finally(() => {
      retrying = undefined
    }))
  // Load accounts now so the launch hook (2 s budget, no CLI) can record seats from the start.
  void rotator
    .accounts()
    .then(() => rotator.publishNow())
    .catch((error) => orca.log(`first account read failed: ${String((error as Error)?.message ?? error)}`))

  // An open panel's Status line switch follows the focused workspace and the install and remove commands.
  const tellConsoleLine = () =>
    consoleLine
      .status()
      .then((state) => orca.panels.post('rotator.consoleLine', state))
      .catch(() => undefined)
  orca.events.on('agent.status.changed', async (payload) => {
    await rotator.onAgentStatus(payload as StatusEvent)
    // A limit in the session on screen may have started a countdown: when it runs out before the
    // next tick would come, the tick is set to then (`schedule`). Only then, so that events never
    // put the tick off by more than one period.
    const due = rotator.countdownDueIn()
    if (due !== undefined && due < MAX_TICK_MS) void clock?.schedule()
  })
  // The panel lists the service of the agent in the focused workspace first.
  orca.events.on('workspace.changed', async () => {
    // The panel's Status line switch is per workspace: tell it the state of the one in focus now.
    await tellConsoleLine()
    if (await rotator.refreshFocus()) rotator.publishNow()
  })

  orca.hooks.on('agent.launch.before', (event) => {
    rotator.noteLaunch(event.agent, event.terminalId, event.workspaceId)
  })

  // Running a command is a sign that the user is at Orca, as using the panel is.
  const register: typeof orca.commands.register = (id, run) =>
    orca.commands.register(id, ((...args: unknown[]) => {
      rotator.notePresence()
      return (run as (...a: unknown[]) => unknown)(...args)
    }) as typeof run)
  register('rotator.next', async (args) => {
    const provider = (typeof args === 'string' ? args : 'claude') as Provider
    return rotator.selectNext(PROVIDERS.includes(provider) ? provider : 'claude')
  })
  register('rotator.nextCodex', () => rotator.selectNext('codex'))
  register('rotator.swapThisPane', () => rotator.swapFocused())
  register('rotator.togglePause', async () => {
    await rotator.setPaused(!rotator.state.paused)
    return rotator.state.paused ? 'Automatic hand-off paused' : 'Automatic hand-off resumed'
  })
  register('rotator.refresh', async () => {
    await rotator.accounts(true, true)
    rotator.publishNow()
    return 'Usage refreshed from Orca. Inactive accounts respect Orca\'s rate-limit and token rules.'
  })
  register('rotator.installStatusLine', async () => {
    const said = await consoleLine.install()
    await tellConsoleLine()
    return said
  })
  register('rotator.uninstallStatusLine', async () => {
    const said = await consoleLine.uninstall()
    await tellConsoleLine()
    return said
  })

  orca.panels.handle('rotator.snapshot', async ({ refresh }) => {
    // The panel's Refresh button (its own polling asks without `refresh`).
    if (refresh) rotator.notePresence()
    await Promise.all([rotator.accounts(!!refresh, !!refresh), rotator.refreshFocus()])
    if (!refresh) await rotator.syncLivePanes(false)
    return rotator.snapshot()
  })
  /** What the panel sends is checked before anything is done with it. */
  const invalid = (message: string) => Object.assign(new Error(message), { code: 'invalid_params' })
  orca.panels.handle('rotator.pause', async ({ paused }) => {
    // Anything but a yes or no changes nothing: a request without `paused` must not turn
    // automatic hand-off back on.
    if (typeof paused !== 'boolean') throw invalid('paused (true or false) is required')
    // Using the panel is a sign the user is at Orca (see the session-on-screen hold).
    rotator.notePresence()
    await rotator.setPaused(paused)
    return { paused }
  })
  orca.panels.handle('rotator.setService', async ({ provider, enabled }) => {
    if (!PROVIDERS.includes(provider as Provider)) {
      throw invalid(`Unknown service ${provider}`)
    }
    // A value that is no yes or no would be stored and then read as "on" (the default).
    if (typeof enabled !== 'boolean') throw invalid('enabled (true or false) is required')
    rotator.notePresence()
    await store(`service_${provider}`, enabled)
    await rotator.refreshServices()
    return { services: rotator.services }
  })
  // The panel's Settings tab: every shown setting (settings.ts), each value checked against it.
  // Fails when Orca cannot be asked: the tab must not show the defaults as if they were chosen
  // (the panel keeps what it had, and asks again).
  const panelSettings = async (): Promise<SettingValues> => settingValues((await orca.settings.get()) as Record<string, unknown>)
  orca.panels.handle('rotator.settings', async ({ key, value }) => {
    if (key !== undefined) {
      rotator.notePresence()
      const spec = ALL_SETTINGS.find((x) => x.key === key)
      const ok = spec ? checked(spec, value) : undefined
      if (!spec || ok === undefined) {
        throw invalid(`Unknown setting value ${String(key)}=${String(value)}`)
      }
      await store(key, ok)
      // The badge and the account order follow the settings as the engine last read them.
      await rotator.refreshServices()
      void clock?.schedule()
    }
    return panelSettings()
  })
  /** The order and the Skip list are each one setting that is read, changed and written back: one
   *  such change at a time, so two quick presses never start from the same list and lose one. */
  let listChange: Promise<unknown> = Promise.resolve()
  const inTurn = <T>(change: () => Promise<T>): Promise<T> => {
    const run = listChange.then(change, change)
    listChange = run.catch(() => undefined)
    return run
  }
  /** Custom order: moves an account up or down in its service's order (the `chain` setting). */
  orca.panels.handle('rotator.moveSeat', async ({ seatKey, by }) => {
    if (typeof seatKey !== 'string' || (by !== -1 && by !== 1)) throw invalid('seatKey and by (-1 or 1) are required')
    rotator.notePresence()
    await inTurn(async () => {
      const chain = await rotator.orderMoved(seatKey, by)
      await store('chain', chain)
      // The panel draws the order from the settings as the engine last read them: read them again
      // before it is told, so it never shows the order as it was.
      await rotator.refreshServices()
    })
    return { ok: true as const }
  })
  // Changing it in Orca's Settings takes effect at once too.
  orca.settings.onDidChange(() => {
    if (upgradePending) void retryUpgrade()
    void panelSettings().then((values) => orca.panels.post('rotator.settings', values), () => undefined)
    void rotator.refreshServices()
    // The console status line format lives in the status file.
    consoleLine.invalidate()
    rotator.publishNow()
    // A new usage read period applies at once.
    void clock?.schedule()
  })

  orca.panels.handle('rotator.consoleLine', async ({ enabled }) => {
    if (typeof enabled !== 'boolean') return consoleLine.status()
    rotator.notePresence()
    const message = enabled ? await consoleLine.install() : await consoleLine.uninstall()
    return { ...(await consoleLine.status()), message }
  })
  orca.panels.handle('rotator.switchTo', async ({ seatKey, acceptDraft, draft: shown }) => {
    if (typeof seatKey !== 'string') throw invalid('seatKey is required')
    // A choice made by hand must not be undone by the plugin: automatic hand-off for the service
    // stops as soon as the account is selected (before any automatic move that waits behind it
    // can run), and the user turns it on again when they want automatic hand-offs back.
    rotator.notePresence()
    let turnedOff = false
    // Unsent text is given up only by the panel's second confirmation, which names the text it
    // showed: `acceptDraft` must be exactly `true`, and without the text nothing is accepted.
    const accepted = acceptDraft === true && typeof shown?.terminalId === 'string' && typeof shown?.text === 'string' ? { terminalId: shown.terminalId, text: shown.text } : undefined
    const { message, switched, provider, draft } = await rotator.forceTo(
      seatKey,
      async (chosen) => {
        if (rotator.held) {
          // Every service only counts as off (the settings are held): the choice is still kept
          // for when the hold ends, as far as Orca takes it. The hand-off by hand goes on either way.
          try {
            if ((await orca.settings.get(`service_${chosen}`)) === false) return
            await store(`service_${chosen}`, false)
          } catch {
            return
          }
        } else {
          if (rotator.services[chosen] === false) return
          await store(`service_${chosen}`, false)
        }
        await rotator.refreshServices(false)
        turnedOff = true
      },
      accepted
    )
    // The pane shows unsent text that cannot go along: nothing was handed off, the panel asks.
    if (draft !== undefined) return { message, draft }
    if (!switched || !turnedOff) return { message }
    rotator.publishNow()
    const off = `${PROVIDER_NAME[provider]}: automatic hand-off is now off, because you chose an account yourself. Turn it on again in the panel.`
    void orca.host.call('notifications.show', { title: 'Auto Hand-off', body: off }).catch(() => undefined)
    return { message: `${message}. ${off}` }
  })
  orca.panels.handle('rotator.focus', async () => {
    if (await rotator.refreshFocus()) rotator.publishNow()
    return rotator.focused ? { focused: rotator.focused } : {}
  })
  orca.panels.handle('rotator.cancelWaiting', async ({ terminalId }) => {
    if (typeof terminalId !== 'string') throw invalid('terminalId is required')
    rotator.notePresence()
    await rotator.cancelWaiting(terminalId)
    return { ok: true as const }
  })
  orca.panels.handle('rotator.handoffNow', async ({ terminalId }) => {
    if (typeof terminalId !== 'string') throw invalid('terminalId is required')
    rotator.notePresence()
    const message = await rotator.handoffNow(terminalId)
    return message ? { ok: true as const, message } : { ok: true as const }
  })
  orca.panels.handle('rotator.setExcluded', async ({ seatKey, excluded }) => {
    if (typeof seatKey !== 'string' || typeof excluded !== 'boolean') throw invalid('seatKey and excluded are required')
    rotator.notePresence()
    await inTurn(async () => {
      await store('exclude', await rotator.excludedChanged(seatKey, excluded))
      // As for the order: the Skip switch is drawn from the settings as the engine last read them.
      await rotator.refreshServices()
    })
    return { ok: true as const }
  })
  orca.panels.handle('rotator.declineHandoff', async ({ terminalId }) => {
    if (typeof terminalId !== 'string') throw invalid('terminalId is required')
    rotator.notePresence()
    await rotator.declineHandoff(terminalId)
    return { ok: true as const }
  })
  orca.panels.handle('rotator.clearCooldown', async ({ seatKey }) => {
    if (typeof seatKey !== 'string') throw invalid('seatKey is required')
    rotator.notePresence()
    await rotator.clearCooldown(seatKey)
    return { ok: true as const }
  })

  orca.panels.handle('rotator.debug', async () => {
    const focused = await orca.host.call('agents.list').catch((e: Error) => ({ error: e.message }))
    const workspaces = await orca.host
      .call('workspace.list')
      .then((r) => r.workspaces.map((w) => ({ id: w.id, path: w.path })))
      .catch((e: Error) => ({ error: e.message }))
    // What Orca hands back for the 0.2 settings the upgrade reads (by name), for checking the upgrade live.
    const legacy = Object.fromEntries(
      await Promise.all(LEGACY_KEYS.map((k) => orca.settings.get(k).then((v) => [k, v ?? null], (e: Error) => [k, `error: ${e.message}`])))
    )
    return JSON.parse(JSON.stringify({ events: rotator.recentEvents, focused, workspaces, legacy }))
  })

  if (clock) {
    void clock.now()
    void clock.schedule()
  }
  return rotator
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  await activateWith(orca, {}, { files: nodeFiles(), watchLive: true })
}

export function deactivate(): void {
  ticks?.stop()
  ticks = undefined
  liveWatcher?.stop()
  liveWatcher = undefined
  active?.dispose()
  active = undefined
}
