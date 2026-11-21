// File-backed persistence for `oahd` under `~/.orca/oah/` (or `OAH_HOME` for tests/isolation).
// Atomic writes (temp + rename) with 0700 directory and 0600 file permissions.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ALL_SETTINGS, checked, settingValues, type SettingValues } from '../core/settings.ts'
import { DEFAULT_CONFIG, PROVIDERS, type Config, type RotatorState } from '../core/types.ts'
import type { UsageCache } from '../core/usage-cache.ts'
import type { UsageSamples } from '../core/usage-history.ts'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

export function resolveOahHome(env: Record<string, string | undefined> = process.env): string {
  const custom = env.OAH_HOME?.trim()
  return custom || join(homedir(), '.orca', 'oah')
}

export function socketPathFor(home: string): string {
  return join(home, 'oahd.sock')
}

export function pidPathFor(home: string): string {
  return join(home, 'oahd.pid')
}

export function logPathFor(home: string): string {
  return join(home, 'oahd.log')
}

/** Converts raw stored settings (from `config.json`) into the engine's `Config`. */
export function configFromStored(s: Record<string, unknown>): Config {
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
    services: Object.fromEntries(
      PROVIDERS.map((p) => [p, typeof s[`service_${p}`] === 'boolean' ? s[`service_${p}`] : d.services[p]])
    ) as Config['services']
  }
}

export class FileStore {
  readonly home: string
  readonly configPath: string
  readonly statePath: string
  readonly usagePath: string
  readonly samplesPath: string
  readonly liveDir: string
  private rawConfig: Record<string, unknown> | null = null

  constructor(home: string = resolveOahHome()) {
    this.home = home
    this.configPath = join(home, 'config.json')
    this.statePath = join(home, 'state.json')
    this.usagePath = join(home, 'usage.json')
    this.samplesPath = join(home, 'samples.json')
    this.liveDir = join(home, 'live')
  }

  ensureDir(): void {
    mkdirSync(this.home, { recursive: true, mode: DIR_MODE })
    try {
      chmodSync(this.home, DIR_MODE)
    } catch {
      // Ignore on filesystems that do not support chmod.
    }
  }

  private readJson<T>(filePath: string): T | null {
    try {
      if (!existsSync(filePath)) return null
      return JSON.parse(readFileSync(filePath, 'utf8')) as T
    } catch {
      return null
    }
  }

  private writeJson(filePath: string, data: unknown): void {
    this.ensureDir()
    mkdirSync(dirname(filePath), { recursive: true, mode: DIR_MODE })
    const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: FILE_MODE, encoding: 'utf8' })
    try {
      chmodSync(tmp, FILE_MODE)
    } catch {
      // Best-effort permission lock.
    }
    renameSync(tmp, filePath)
  }

  loadRawConfig(): Record<string, unknown> {
    if (!this.rawConfig) {
      const parsed = this.readJson<Record<string, unknown>>(this.configPath)
      this.rawConfig = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    }
    return { ...this.rawConfig }
  }

  loadConfig(): Config {
    return configFromStored(this.loadRawConfig())
  }

  settingValues(): SettingValues {
    return settingValues(this.loadRawConfig())
  }

  setSetting(key: string, value: unknown): SettingValues {
    const raw = this.loadRawConfig()
    if (key.startsWith('service_')) {
      const provider = key.slice('service_'.length)
      if (!(PROVIDERS as readonly string[]).includes(provider) || typeof value !== 'boolean') {
        throw new Error(`Invalid service setting ${key}=${String(value)}`)
      }
      raw[key] = value
    } else if (key === 'chain') {
      if (typeof value !== 'string') throw new Error(`Invalid chain value: ${String(value)}`)
      raw[key] = value
    } else {
      const spec = ALL_SETTINGS.find((s) => s.key === key)
      if (!spec) throw new Error(`Unknown setting "${key}"`)
      const normalized = checked(spec, value)
      if (normalized === undefined) {
        throw new Error(`Invalid value for "${key}": ${String(value)}`)
      }
      raw[key] = normalized
    }
    this.rawConfig = raw
    this.writeJson(this.configPath, raw)
    return settingValues(raw)
  }

  loadState(): RotatorState | null {
    return this.readJson<RotatorState>(this.statePath)
  }

  saveState(state: RotatorState): void {
    this.writeJson(this.statePath, state)
  }

  loadUsage(): unknown {
    return this.readJson<UsageCache>(this.usagePath)
  }

  saveUsage(cache: UsageCache): void {
    this.writeJson(this.usagePath, cache)
  }

  loadSamples(): unknown {
    return this.readJson<UsageSamples>(this.samplesPath)
  }

  saveSamples(samples: UsageSamples): void {
    this.writeJson(this.samplesPath, samples)
  }

  readLive(fileName: string): string | null {
    try {
      const full = join(this.liveDir, fileName)
      return existsSync(full) ? readFileSync(full, 'utf8') : null
    } catch {
      return null
    }
  }

  removeStaleSocket(sockPath: string): void {
    try {
      if (existsSync(sockPath)) unlinkSync(sockPath)
    } catch {
      // Ignore if already gone.
    }
  }
}
