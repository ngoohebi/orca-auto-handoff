// The console status line's side effects: the script and status file under `~/.orca/account-
// rotator/`, and the focused workspace's `.claude/settings.local.json`. `Files` is injected so the
// worker tests run against memory; `nodeFiles` is what Orca runs.
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import type { Deps } from './engine'
import {
  DATA_DIR,
  DEFAULT_BAR_WIDTH,
  DEFAULT_FORMAT,
  SCRIPT,
  SCRIPT_NAME,
  STATUS_NAME,
  installIntoSettings,
  renderStatusFile,
  uninstallFromSettings,
  isInstalledIn
} from './statusline'
import type { ConsoleLineState } from './protocol'
import type { Snapshot } from './types'

export type Files = {
  home: string
  /** `null` when the file does not exist. */
  read(path: string): string | null
  /** Creates parent directories; replaces atomically. */
  write(path: string, text: string, mode?: number): void
  remove(path: string): void
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
    write(path, text, mode) {
      mkdirSync(dirname(path), { recursive: true })
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
    }
  }
}

/** For tests: a flat map of path → text (and `modes` for what was made executable). */
export function memoryFiles(home = '/home/test'): Files & { files: Map<string, string>; modes: Map<string, number> } {
  const files = new Map<string, string>()
  const modes = new Map<string, number>()
  return {
    home,
    files,
    modes,
    read: (path) => files.get(path) ?? null,
    write(path, text, mode) {
      files.set(path, text)
      if (mode !== undefined) modes.set(path, mode)
    },
    remove: (path) => void files.delete(path)
  }
}

type Ctx = {
  host: Deps['host']
  settings(): Promise<Record<string, unknown>>
  log(message: string): void
  now(): number
}

export class ConsoleStatusLine {
  private lastStatus = ''
  private scriptChecked = false

  constructor(
    private readonly files: Files,
    private readonly ctx: Ctx
  ) {}

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
      if (this.files.read(this.scriptPath) !== SCRIPT) this.files.write(this.scriptPath, SCRIPT, 0o755)
      this.scriptChecked = true
    } catch (error) {
      this.ctx.log(`console status line: cannot write ${this.scriptPath}: ${String((error as Error)?.message ?? error)}`)
    }
  }

  async format(): Promise<{ format: string; barWidth: number }> {
    const s = await this.ctx.settings()
    const format = typeof s.console_statusline_format === 'string' ? s.console_statusline_format.trim() : ''
    const barWidth = typeof s.console_statusline_bar_width === 'number' ? s.console_statusline_bar_width : DEFAULT_BAR_WIDTH
    return { format: format || DEFAULT_FORMAT, barWidth }
  }

  /** Called on every publish; writes only when the rendered file differs. */
  async writeStatus(snapshot: Snapshot): Promise<void> {
    try {
      const { format, barWidth } = await this.format()
      const text = renderStatusFile(snapshot, format, this.ctx.now(), barWidth)
      if (text === this.lastStatus) return
      this.lastStatus = text
      this.ensureScript()
      this.files.write(this.statusPath, text)
    } catch (error) {
      this.ctx.log(`console status line: cannot write ${this.statusPath}: ${String((error as Error)?.message ?? error)}`)
    }
  }

  private async focusedSettingsFile(): Promise<{ file: string; name: string } | string> {
    const context = await this.ctx.host.call('workspace.readContext')
    if (!context?.workspaceId) return 'No focused workspace'
    const { workspaces } = await this.ctx.host.call('workspace.list')
    const ws = workspaces.find((w: { id: string }) => w.id === context.workspaceId)
    if (!ws?.path) return 'The focused workspace has no local path'
    // A workspace on an SSH target or a paired Orca server has its path on that machine: the same
    // path here is another folder, or none. The row names its host, or else its project does.
    let hostId: unknown = ws.hostId
    if ((typeof hostId !== 'string' || !hostId) && ws.projectId) {
      const listed = await this.ctx.host.call('project.list').catch(() => null)
      hostId = Array.isArray(listed?.projects) ? listed.projects.find((p: { id: string }) => p.id === ws.projectId)?.hostId : undefined
    }
    if (typeof hostId === 'string' && hostId && hostId !== 'local') return 'The focused workspace is not on this computer'
    return { file: `${ws.path}/.claude/settings.local.json`, name: ws.name }
  }

  /** Whether the focused workspace has the wrapper as its Claude `statusLine`. */
  async status(): Promise<ConsoleLineState> {
    const target = await this.focusedSettingsFile()
    if (typeof target === 'string') return { installed: false, reason: target }
    let installed = false
    try {
      installed = isInstalledIn(this.files.read(target.file))
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
      '. Claude panes pick it up at their next status refresh or launch.'
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
