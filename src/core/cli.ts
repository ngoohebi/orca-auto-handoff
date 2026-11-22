// The `orca` CLI and git, run from the worker (Node). The host API has no account switch, so
// selecting an account goes through `orca account select` on this computer, or Orca's RuntimeClient
// when the current project runs on a paired Orca server (`orca account` subcommands refuse
// `--environment`, while the server's RPC offers the same `accounts.*` methods).
import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
// Orca's runtime client is CommonJS; this module is an ES module, which has no `require` of its own.
// (Without it every runtime call below fell back to starting the `orca` CLI.)
const require = createRequire(import.meta.url)
import type { Cli } from './engine.ts'
import type { Provider } from './types.ts'

const MAC_APP_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'
const MAC_UNPACKED_OUT = '/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out'

export function resolveOrcaCli(configured: string): string {
  if (configured.trim()) return configured.trim()
  const fromEnv = process.env.ORCA_CLI_COMMAND
  if (fromEnv) return fromEnv
  if (process.platform === 'darwin' && existsSync(MAC_APP_CLI)) return MAC_APP_CLI
  // On Linux bare `orca` is usually the GNOME screen reader; Orca installs `orca-ide` there.
  return process.platform === 'linux' ? 'orca-ide' : 'orca'
}

function resolveUnpackedOut(cliPath: string): string | null {
  const candidates: string[] = []
  try {
    const real = realpathSync(cliPath)
    candidates.push(join(dirname(dirname(real)), 'app.asar.unpacked', 'out'))
  } catch {
    // `cliPath` may be a bare command name on PATH.
  }
  if (process.execPath) {
    const execDir = dirname(process.execPath)
    candidates.push(
      join(dirname(execDir), 'Resources', 'app.asar.unpacked', 'out'),
      join(execDir, 'resources', 'app.asar.unpacked', 'out')
    )
  }
  candidates.push(MAC_UNPACKED_OUT)
  for (const dir of candidates) {
    if (existsSync(join(dir, 'cli', 'runtime', 'client.js'))) return dir
  }
  return null
}

function openRuntimeClient(cliPath: string, server: string | null, timeoutMs = 30_000): any {
  const outDir = resolveUnpackedOut(cliPath)
  if (!outDir) throw new Error('Orca runtime client is unavailable on this installation')
  try {
    const storeExec = require(join(outDir, 'shared', 'remote-runtime', 'host-store', 'runtime-environment-store-execution.js'))
    if (storeExec && !storeExec.environmentStoreRunsInline?.()) {
      storeExec.useInlineEnvironmentStoreForCli?.()
    }
  } catch {
    // Already sealed in this process or not needed for local calls.
  }
  const { RuntimeClient } = require(join(outDir, 'cli', 'runtime', 'client.js'))
  return new RuntimeClient(undefined, timeoutMs, null, server)
}

/** One runtime client for this computer's Orca, kept for the terminal list: asked over Orca's
 *  local socket it answers in a millisecond or two, where starting `orca terminal list` costs
 *  about 0.1 s of CPU each time, and the panel asks which tab is in front every second. */
let localTerminalClient: any

/** `orca terminal list --include-visual-layouts`, as data. This computer's Orca is asked over the
 *  kept runtime client; if that fails (or for a paired server) the CLI is started as before. */
async function terminalList(cli: string, server?: string): Promise<any> {
  if (!server) {
    try {
      localTerminalClient ??= openRuntimeClient(cli, null, 5_000)
      const response = await localTerminalClient.call('terminal.list', { includeVisualLayouts: true })
      if (response && response.ok === false) throw new Error(response.error?.message ?? 'terminal.list failed')
      return response?.result ?? response
    } catch {
      // The next read opens a new client; this one goes through the CLI.
      localTerminalClient = undefined
    }
  }
  return orcaJson(cli, ['terminal', 'list', '--include-visual-layouts', ...envArgs(server)])
}

async function callListAccounts(client: any, refreshUsage: boolean, refreshStaleUsage = true): Promise<Record<string, any>> {
  const [response, antigravity] = await Promise.all([
    client.call('accounts.list', { refreshUsage, refreshStaleUsage }),
    client.call('accounts.antigravityList', { runtime: 'host' }).then((r: any) => r?.result ?? null, () => null)
  ])
  return antigravity ? { ...response.result, antigravity } : response.result
}

export async function remoteListAccounts(cliPath: string, server: string, refreshUsage = false): Promise<Record<string, any>> {
  return callListAccounts(openRuntimeClient(cliPath, server), refreshUsage)
}

export async function localListAccounts(cliPath: string, refreshUsage = false, refreshStaleUsage = true): Promise<Record<string, any>> {
  let client: any
  try {
    client = openRuntimeClient(cliPath, null)
  } catch {
    // Fall back to the CLI when the unpacked RuntimeClient isn't available on this install.
    return orcaJson(cliPath, ['account', 'list'])
  }
  try {
    return await callListAccounts(client, refreshUsage, refreshStaleUsage)
  } catch (error) {
    const code = (error as { code?: string })?.code
    if (code === 'incompatible_runtime' || code === 'invalid_params') {
      return orcaJson(cliPath, ['account', 'list'])
    }
    throw error
  }
}

export async function remoteSelectAccount(cliPath: string, provider: Provider, accountId: string, server: string): Promise<void> {
  const client = openRuntimeClient(cliPath, server)
  const id = accountId === 'system' ? null : accountId
  switch (provider) {
    case 'claude':
      await client.call('accounts.selectClaude', { accountId: id })
      return
    case 'codex':
      await client.call('accounts.selectCodex', { accountId: id })
      return
    case 'opencode':
    case 'devin':
      await client.call('accounts.selectData', { provider, accountId: id })
      return
    case 'antigravity':
      if (id === null) throw new Error('Antigravity has no system default.')
      await client.call('accounts.antigravitySelect', { target: { runtime: 'host' }, accountId: id })
      return
  }
}

/** Resolves a workspace's host (`runtime:<env>` or `local`) from the desktop's paired-server
 *  catalogs when local `workspace.list` / `project.list` does not carry the paired server's rows. */
export async function resolveWorkspaceHostFromCatalog(cliPath: string, workspaceId?: string): Promise<string | undefined> {
  let client: any
  try {
    client = openRuntimeClient(cliPath, null, 10_000)
  } catch {
    return undefined
  }
  if (workspaceId) {
    const sep = workspaceId.indexOf('::')
    const repoId = sep > 0 ? workspaceId.slice(0, sep) : undefined
    const worktreePath = sep > 0 ? workspaceId.slice(sep + 2) : undefined
    try {
      const sections = (await client.call('mobileRelay.projectSections'))?.result?.catalog
      if (sections && repoId) {
        const setups: any[] = Array.isArray(sections.setups) ? sections.setups : []
        const byPath = setups.find((s) => (s?.repoId === repoId || s?.id === repoId) && worktreePath && s?.path && worktreePath.startsWith(s.path))
        const byRepo = byPath ?? setups.find((s) => s?.repoId === repoId || s?.id === repoId)
        if (byRepo) {
          if (typeof byRepo.runtimeOwnerEnvironmentId === 'string' && byRepo.runtimeOwnerEnvironmentId.trim()) {
            return `runtime:${encodeURIComponent(byRepo.runtimeOwnerEnvironmentId.trim())}`
          }
          if (typeof byRepo.hostId === 'string' && byRepo.hostId.trim()) return byRepo.hostId.trim()
          if (typeof byRepo.executionHostId === 'string' && byRepo.executionHostId.trim()) return byRepo.executionHostId.trim()
        }
        const repos: any[] = Array.isArray(sections.repos) ? sections.repos : []
        const repo =
          repos.find((r) => r?.id === repoId && worktreePath && r?.path && worktreePath.startsWith(r.path)) ??
          repos.find((r) => r?.id === repoId)
        if (typeof repo?.executionHostId === 'string' && repo.executionHostId.trim()) return repo.executionHostId.trim()
      }
      if (sections && workspaceId.startsWith('folder:')) {
        const folderId = workspaceId.slice('folder:'.length)
        const groups: any[] = Array.isArray(sections.projectGroups) ? sections.projectGroups : []
        for (const g of groups) {
          const folders: any[] = Array.isArray(g?.folderWorkspaces) ? g.folderWorkspaces : []
          const f = folders.find((x) => x?.id === folderId)
          if (f) {
            const host = f.executionHostId ?? g.executionHostId
            if (typeof host === 'string' && host.trim()) return host.trim()
          }
        }
      }
    } catch {
      // Fall through to paired host worktree lookup.
    }
    try {
      const hosts: any[] = (await client.call('mobileRelay.hosts.list'))?.result?.hosts ?? []
      for (const h of hosts) {
        if (typeof h?.hostId !== 'string' || !h.hostId.startsWith('runtime:')) continue
        const wts: any[] = (await client.call('mobileRelay.hosts.worktrees', { hostId: h.hostId }))?.result?.worktrees ?? []
        if (wts.some((w) => w?.worktreeId === workspaceId || w?.id === workspaceId)) return h.hostId
      }
    } catch {
      // Ignore relay lookup errors.
    }
    return undefined
  }
  try {
    const scope = (await client.call('ui.get'))?.result?.ui?.workspaceHostScope
    if (typeof scope === 'string' && scope.startsWith('runtime:')) return scope
  } catch {
    // Ignore ui.get errors.
  }
  return undefined
}

function run(file: string, args: string[], cwd?: string, timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        // `--json` failures print `{ ok: false, error: { code, message } }` on stdout.
        let detail = ''
        try {
          const parsed = JSON.parse(stdout.toString())
          if (parsed?.error) detail = `${parsed.error.code ?? 'error'}: ${parsed.error.message ?? ''}`
        } catch {
          // not JSON
        }
        if (!detail) detail = (stderr || stdout || '').toString().trim().split('\n').slice(-3).join(' ')
        reject(new Error(`${file} ${args.slice(0, 3).join(' ')}: ${detail || error.message}`))
      } else resolve(stdout.toString())
    })
  })
}

async function orcaJson(cli: string, args: string[]): Promise<any> {
  const out = await run(cli, [...args, '--json'])
  const parsed = JSON.parse(out)
  if (parsed && parsed.ok === false) {
    throw new Error(parsed.error?.message ?? 'orca command failed')
  }
  return parsed?.result ?? parsed
}

function envArgs(server?: string): string[] {
  return server ? ['--environment', server] : []
}

export function nodeCli(getPath: () => Promise<string>): Cli {
  return {
    async listAccounts(server, options) {
      const cli = resolveOrcaCli(await getPath())
      const refreshUsage = !!options?.refreshUsage
      if (server) return remoteListAccounts(cli, server, refreshUsage)
      return localListAccounts(cli, refreshUsage, options?.refreshStaleUsage)
    },
    async select(provider: Provider, accountId: string, server?: string) {
      const cli = resolveOrcaCli(await getPath())
      if (server) {
        await remoteSelectAccount(cli, provider, accountId, server)
        return
      }
      await orcaJson(cli, ['account', 'select', '--agent', provider, '--account', accountId])
    },
    async closeTerminal(terminalId: string, server?: string) {
      await orcaJson(resolveOrcaCli(await getPath()), ['terminal', 'close', '--terminal', terminalId, ...envArgs(server)])
    },
    async focusTerminal(terminalId: string, server?: string) {
      await orcaJson(resolveOrcaCli(await getPath()), ['terminal', 'switch', '--terminal', terminalId, ...envArgs(server)])
    },
    async sendText(terminalId: string, text: string, server?: string) {
      // `--text=…`: as a word of its own, a text that starts with `--` is read as another flag
      // (live, Orca 1.4.263: `--text --enter` is refused as invalid_argument).
      await orcaJson(resolveOrcaCli(await getPath()), ['terminal', 'send', '--terminal', terminalId, `--text=${text}`, '--enter', ...envArgs(server)])
    },
    async typeText(terminalId: string, text: string, server?: string) {
      await orcaJson(resolveOrcaCli(await getPath()), ['terminal', 'send', '--terminal', terminalId, `--text=${text}`, ...envArgs(server)])
    },
    async git(cwd: string, args: string[]) {
      return run('git', ['-C', cwd, ...args], undefined, 10_000)
    },
    async activeTerminals(server?: string) {
      return shownTerminalsIn(await terminalList(resolveOrcaCli(await getPath()), server))
    },
    async visibleTerminals(server?: string) {
      return shownTerminalsIn(await terminalList(resolveOrcaCli(await getPath()), server), true)
    },
    async draft(terminalId: string, server?: string) {
      const result = await orcaJson(resolveOrcaCli(await getPath()), ['terminal', 'read', '--terminal', terminalId, '--limit', '1', ...envArgs(server)])
      // Orca leaves `draft` out when the input box is empty. An answer without the terminal is
      // no answer: the engine then treats the pane as possibly holding unsent text.
      const terminal = result?.terminal
      if (!terminal || typeof terminal !== 'object') return undefined
      return typeof terminal.draft === 'string' ? terminal.draft : ''
    },
    async workspaceServer(workspaceId?: string) {
      return resolveWorkspaceHostFromCatalog(resolveOrcaCli(await getPath()), workspaceId)
    }
  }
}

/** As `activeTerminalsIn`, for an answer of the CLI. An answer without layouts (an Orca that does
 *  not know `--include-visual-layouts` lists the terminals and leaves them out) does not say
 *  that no terminal is shown: it is no answer, so this throws, and the engine takes a session
 *  for the one on screen rather than for one in another tab. */
export function shownTerminalsIn(result: any, everyPane = false): string[] {
  if (!Array.isArray(result?.visualLayouts)) throw new Error('orca terminal list gave no layouts')
  return activeTerminalsIn(result, everyPane)
}

/** The terminal handles shown in each workspace's active tab, from `orca terminal list
 *  --include-visual-layouts`: its active leaf when the tab is split (the pane the user works
 *  in), or with `everyPane` every pane of that tab (all of them are on screen). */
export function activeTerminalsIn(result: any, everyPane = false): string[] {
  const handles: string[] = []
  const layouts: any[] = Array.isArray(result?.visualLayouts) ? result.visualLayouts : []
  const terminals = (node: any, out: any[] = []): any[] => {
    if (!node || typeof node !== 'object') return out
    if (Array.isArray(node)) {
      for (const n of node) terminals(n, out)
      return out
    }
    if (node.type === 'terminal' && typeof node.handle === 'string') out.push(node)
    for (const [k, v] of Object.entries(node)) if (k !== 'type' && typeof v === 'object') terminals(v, out)
    return out
  }
  const groups = (node: any, out: any[] = []): any[] => {
    if (!node || typeof node !== 'object') return out
    if (Array.isArray(node)) {
      for (const n of node) groups(n, out)
      return out
    }
    if (node.type === 'group' && Array.isArray(node.tabs)) out.push(node)
    for (const v of Object.values(node)) if (typeof v === 'object') groups(v, out)
    return out
  }
  for (const layout of layouts) {
    for (const group of groups(layout.root)) {
      const tab = group.tabs.find((t: any) => t?.tabId === group.activeTabId) ?? group.tabs[0]
      if (!tab) continue
      const panes = terminals(tab.panes)
      if (everyPane) {
        handles.push(...panes.map((p) => p.handle))
        continue
      }
      const leaf = panes.find((p) => p.leafId && p.leafId === tab.activeLeafId) ?? panes.find((p) => p.active) ?? panes[0]
      if (leaf) handles.push(leaf.handle)
    }
  }
  return handles
}
