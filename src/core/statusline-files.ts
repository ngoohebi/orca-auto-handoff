// The console status line's side effects: the script and status file under `~/.orca/account-
// rotator/`, and the focused workspace's `.claude/settings.local.json`. `Files` is injected so the
// worker tests run against memory; `nodeFiles` is what Orca runs.
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import type { Deps } from './engine.ts'
import {
  DATA_DIR,
  DEFAULT_BAR_WIDTH,
  LIVE_DIR,
  DEFAULT_FORMAT,
  SCRIPT,
  SCRIPT_NAME,
  STATUS_NAME,
  installIntoSettings,
  renderStatusFile,
  uninstallFromSettings,
  isInstalledIn,
  needsUpgrade
} from './statusline.ts'
import type { ConsoleLineState } from '../protocol'
import type { Snapshot } from './types.ts'

export type Files = {
  home: string
  /** `null` when the file does not exist. */
  read(path: string): string | null
  /** Creates parent directories; replaces atomically. `dirMode`: the mode of the file's folder,
   *  set also when the folder was already there. */
  write(path: string, text: string, mode?: number, dirMode?: number): void
  remove(path: string): void
  /** The names of the files in a folder; none when it does not exist. */
  list?(dir: string): string[]
}

export function nodeFiles(): Files {
  return {
    home: homedir(),
    read(path) {
      try {
        return readFileSync(path, 'utf8')
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') return null
        throw error
      }
    },
    write(path, text, mode, dirMode) {
      const dir = dirname(path)
      mkdirSync(dir, { recursive: true, ...(dirMode !== undefined ? { mode: dirMode } : {}) })
      if (dirMode !== undefined) chmodSync(dir, dirMode)
      const tmp = `${path}.tmp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      writeFileSync(tmp, text, { encoding: 'utf8', mode: mode ?? 0o644 })
      if (mode !== undefined) chmodSync(tmp, mode)
      renameSync(tmp, path)
    },
    remove(path) {
      try {
        unlinkSync(path)
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error
      }
    },
    list(dir) {
      try {
        return readdirSync(dir)
      } catch {
        return []
      }
    }
  }
}

/** For tests: a flat map of path → text (and `modes` for the modes asked for, folders included). */
export function memoryFiles(home = '/home/test'): Files & { files: Map<string, string>; modes: Map<string, number> } {
  const files = new Map<string, string>()
  const modes = new Map<string, number>()
  return {
    home,
    files,
    modes,
    read: (path) => files.get(path) ?? null,
    write(path, text, mode, dirMode) {
      files.set(path, text)
      if (mode !== undefined) modes.set(path, mode)
      if (dirMode !== undefined) modes.set(dirname(path), dirMode)
    },
    remove: (path) => void files.delete(path),
    list: (dir) => [...files.keys()].filter((p) => dirname(p) === dir).map((p) => p.slice(dir.length + 1))
  }
}

type Ctx = {
  host: Deps['host']
  settings(): Promise<Record<string, unknown>>
  log(message: string): void
  now(): number
  /** Orca's data folder, where its Claude profiles live (`claude-profiles/<id>/home`). */
  orcaUserData?: string
}

/** How often the Claude config folders noted by the wrapper are matched to accounts again. */
const DIRS_EVERY_MS = 5 * 60_000

/** Orca's data folder: ORCA_USER_DATA, else its macOS default. */
export function defaultOrcaUserData(home: string): string | undefined {
  const configured = process.env.ORCA_USER_DATA
  if (configured && configured.startsWith('/')) return configured
  return process.platform === 'darwin' ? `${home}/Library/Application Support/Orca` : undefined
}

/** The status file names the accounts (emails), and so do the live files beside it: the folder
 *  and the files in it are the owner's alone. (The script must stay runnable by its owner.) */
const PRIVATE_DIR = 0o700
const PRIVATE_FILE = 0o600

export class ConsoleStatusLine {
  private lastStatus = ''
  private scriptChecked = false

  private readonly files: Files
  private readonly ctx: Ctx

  constructor(files: Files, ctx: Ctx) {
    this.files = files
    this.ctx = ctx
  }

  get scriptPath(): string {
    return `${this.files.home}/${DATA_DIR}/${SCRIPT_NAME}`
  }
  get statusPath(): string {
    return `${this.files.home}/${DATA_DIR}/${STATUS_NAME}`
  }

  /** Forget the last written status so the next snapshot is written even if unchanged. */
  invalidate(): void {
    this.lastStatus = ''
  }

  /** Puts the wrapper on disk (once per worker life, or when its text changed). */
  ensureScript(): void {
    if (this.scriptChecked) return
    try {
      if (this.files.read(this.scriptPath) !== SCRIPT) this.files.write(this.scriptPath, SCRIPT, 0o755, PRIVATE_DIR)
      this.scriptChecked = true
    } catch (error) {
      this.ctx.log(`console status line: cannot write ${this.scriptPath}: ${String((error as Error)?.message ?? error)}`)
    }
  }

  async format(): Promise<{ format: string; barWidth: number }> {
    const s = await this.ctx.settings()
    const format = typeof s.console_statusline_format === 'string' ? s.console_statusline_format.trim() : ''
    // The bar width is no setting any more (0.3); a value an older version stored still counts.
    const barWidth = typeof s.console_statusline_bar_width === 'number' ? s.console_statusline_bar_width : DEFAULT_BAR_WIDTH
    return { format: format || DEFAULT_FORMAT, barWidth }
  }

  private dirs: [string, string][] = []
  private dirsAt = 0
  private dirsSeen = ''

  /** The Claude sign-in a config folder holds: its account email and organization. */
  private signInOf(configDir: string): string | undefined {
    try {
      const account = JSON.parse(this.files.read(`${configDir.replace(/\/+$/, '')}/.claude.json`) ?? 'null')?.oauthAccount
      const email = typeof account?.emailAddress === 'string' ? account.emailAddress.toLowerCase() : ''
      return email ? `${email}\t${typeof account.organizationUuid === 'string' ? account.organizationUuid : ''}` : undefined
    } catch {
      return undefined
    }
  }

  /** Claude config folders that are not an Orca profile (a launcher such as ClaudeBar sets its
   *  own), matched to the Orca account whose profile holds the same sign-in, for the wrapper's
   *  `dir` rows: it then marks that account and keeps its numbers. The wrapper notes each folder
   *  it meets in live/dirs/; they are matched again every few minutes, or when one is new. */
  private configDirs(snapshot: Snapshot): [string, string][] {
    const seenDir = `${this.files.home}/${DATA_DIR}/${LIVE_DIR}/dirs`
    const names = (this.files.list?.(seenDir) ?? []).filter((n) => /^[0-9]+$/.test(n)).sort()
    const seen = names.join(',')
    if (seen === this.dirsSeen && this.ctx.now() - this.dirsAt < DIRS_EVERY_MS) return this.dirs
    this.dirsSeen = seen
    this.dirsAt = this.ctx.now()
    const root = this.ctx.orcaUserData ?? defaultOrcaUserData(this.files.home)
    if (!names.length || !root) return (this.dirs = [])
    const ids = [...new Set(snapshot.seats.filter((s) => s.provider === 'claude' && /^[0-9a-f-]{36}$/i.test(s.accountId)).map((s) => s.accountId))]
    const byAccount = new Map<string, string[]>()
    for (const id of ids) {
      const sign = this.signInOf(`${root}/claude-profiles/${id}/home`)
      if (sign) byAccount.set(sign, [...(byAccount.get(sign) ?? []), id])
    }
    const dirs: [string, string][] = []
    for (const name of names) {
      const path = (this.files.read(`${seenDir}/${name}`) ?? '').split('\n')[0]!.trim()
      if (!path.startsWith('/') || /[\t\r]/.test(path)) continue
      const sign = this.signInOf(path)
      const match = sign ? byAccount.get(sign) : undefined
      // Two Orca profiles of the same account: either is right, so the first.
      if (match?.length) dirs.push([path, match[0]!])
    }
    return (this.dirs = dirs)
  }

  /** Called on every publish; writes only when the rendered file differs. */
  async writeStatus(snapshot: Snapshot): Promise<void> {
    try {
      const { format, barWidth } = await this.format()
      const text = renderStatusFile(snapshot, format, this.ctx.now(), barWidth, this.configDirs(snapshot))
      if (text === this.lastStatus) return
      this.lastStatus = text
      this.ensureScript()
      this.files.write(this.statusPath, text, PRIVATE_FILE, PRIVATE_DIR)
    } catch (error) {
      this.ctx.log(`console status line: cannot write ${this.statusPath}: ${String((error as Error)?.message ?? error)}`)
    }
  }

  /** One workspace's Claude settings file, or why it has none here. A workspace on an SSH target
   *  or a paired Orca server has its path on that machine: the same path here is another folder,
   *  or none. The row names its host, or else its project does. */
  private settingsFileOf(
    ws: { path?: string; name: string; hostId?: unknown; projectId?: string } | undefined,
    projects: { id: string; hostId?: unknown }[] | undefined
  ): { file: string; name: string } | string {
    if (!ws?.path) return 'The focused workspace has no local path'
    let hostId: unknown = ws.hostId
    if ((typeof hostId !== 'string' || !hostId) && ws.projectId) hostId = projects?.find((p) => p.id === ws.projectId)?.hostId
    if (typeof hostId === 'string' && hostId && hostId !== 'local') return 'The focused workspace is not on this computer'
    return { file: `${ws.path}/.claude/settings.local.json`, name: ws.name }
  }

  private async projects(): Promise<{ id: string; hostId?: unknown }[] | undefined> {
    const listed = await this.ctx.host.call('project.list').catch(() => null)
    return Array.isArray(listed?.projects) ? listed.projects : undefined
  }

  private async focusedSettingsFile(): Promise<{ file: string; name: string } | string> {
    const context = await this.ctx.host.call('workspace.readContext')
    if (!context?.workspaceId) return 'No focused workspace'
    const { workspaces } = await this.ctx.host.call('workspace.list')
    const ws = workspaces.find((w: { id: string }) => w.id === context.workspaceId)
    if (!ws?.path) return 'The focused workspace has no local path'
    return this.settingsFileOf(ws, ws.hostId || !ws.projectId ? undefined : await this.projects())
  }

  /** Every workspace on this computer, as its Claude settings file. */
  private async localSettingsFiles(): Promise<{ file: string; name: string }[]> {
    const { workspaces } = await this.ctx.host.call('workspace.list')
    const projects = await this.projects()
    const files: { file: string; name: string }[] = []
    for (const ws of Array.isArray(workspaces) ? workspaces : []) {
      const target = this.settingsFileOf(ws, projects)
      if (typeof target !== 'string' && !files.some((f) => f.file === target.file)) files.push(target)
    }
    return files
  }

  /** The `console_statusline` setting turned on: the wrapper in every workspace on this computer. */
  async installEverywhere(): Promise<string> {
    this.scriptChecked = false
    this.ensureScript()
    if (!this.scriptChecked) return `Could not write ${this.scriptPath}; see the plugin log`
    let done = 0
    for (const target of await this.localSettingsFiles()) {
      try {
        const text = this.files.read(target.file)
        if (text !== null && isInstalledIn(text) && !needsUpgrade(text)) continue
        this.files.write(target.file, installIntoSettings(text).text)
        done++
      } catch (error) {
        this.ctx.log(`console status line: ${target.file}: ${String((error as Error)?.message ?? error)}`)
      }
    }
    return done
      ? `Claude status line on in ${done} workspace${done === 1 ? '' : 's'}; a previous status line is kept and put back when it is turned off. Claude sessions pick it up at their next status refresh or start.`
      : 'Claude status line is on in every workspace.'
  }

  /** The `console_statusline` setting turned off: the wrapper out of every workspace on this
   *  computer, with any earlier status line put back. */
  async uninstallEverywhere(): Promise<string> {
    let done = 0
    for (const target of await this.localSettingsFiles()) {
      try {
        const existing = this.files.read(target.file)
        if (existing === null) continue
        const result = uninstallFromSettings(existing)
        if (!result.changed) continue
        if (result.text === null) this.files.remove(target.file)
        else this.files.write(target.file, result.text)
        done++
      } catch (error) {
        this.ctx.log(`console status line: ${target.file}: ${String((error as Error)?.message ?? error)}`)
      }
    }
    return done ? `Claude status line removed from ${done} workspace${done === 1 ? '' : 's'}.` : 'Claude status line is off.'
  }

  /** While the setting is on: the wrapper in the focused workspace too, for one opened since. */
  async ensureFocused(): Promise<void> {
    const target = await this.focusedSettingsFile()
    if (typeof target === 'string') return
    const text = this.files.read(target.file)
    if (text !== null && isInstalledIn(text) && !needsUpgrade(text)) return
    this.ensureScript()
    if (!this.scriptChecked) return
    this.files.write(target.file, installIntoSettings(text).text)
  }

  /** Whether the focused workspace has the wrapper as its Claude `statusLine`. */
  async status(): Promise<ConsoleLineState> {
    const target = await this.focusedSettingsFile()
    if (typeof target === 'string') return { installed: false, reason: target }
    let installed = false
    try {
      const text = this.files.read(target.file)
      installed = isInstalledIn(text)
      // A wrapper installed by an earlier version gets the refresh interval.
      if (installed && needsUpgrade(text)) this.files.write(target.file, installIntoSettings(text).text)
    } catch {
      installed = false
    }
    return { installed, workspace: target.name }
  }

  /** The `rotator.installStatusLine` command. */
  async install(): Promise<string> {
    const target = await this.focusedSettingsFile()
    if (typeof target === 'string') return target
    this.scriptChecked = false
    this.ensureScript()
    if (!this.scriptChecked) return `Could not write ${this.scriptPath}; see the plugin log`
    let result: ReturnType<typeof installIntoSettings>
    try {
      result = installIntoSettings(this.files.read(target.file))
    } catch (error) {
      return `${target.file}: ${String((error as Error)?.message ?? error)}`
    }
    this.files.write(target.file, result.text)
    return (
      `Console status line installed for ${target.name} (.claude/settings.local.json)` +
      (result.replaced ? '; the previous statusLine is kept in the file and restored on uninstall' : '') +
      '. Claude sessions pick it up at their next status refresh or start.'
    )
  }

  /** The `rotator.uninstallStatusLine` command. */
  async uninstall(): Promise<string> {
    const target = await this.focusedSettingsFile()
    if (typeof target === 'string') return target
    const existing = this.files.read(target.file)
    if (existing === null) return `${target.name}: no .claude/settings.local.json`
    let result: ReturnType<typeof uninstallFromSettings>
    try {
      result = uninstallFromSettings(existing)
    } catch (error) {
      return `${target.file}: ${String((error as Error)?.message ?? error)}`
    }
    if (!result.changed) return `${target.name}: the console status line is not installed there`
    if (result.text === null) this.files.remove(target.file)
    else this.files.write(target.file, result.text)
    return `Console status line removed from ${target.name}`
  }
}
