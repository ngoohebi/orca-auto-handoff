// Orca transport for `oahd`: implements `HostLike` by delegating to a connected thin Orca plugin
// bridge when available (for instant `agent.resume`, `notifications.show`, and focused workspace
// metadata), and falling back cleanly to the `orca` CLI when running standalone/headless.
import { execFile } from 'node:child_process'
import { resolveOrcaCli } from '../core/cli.ts'
import type { HostLike } from '../core/engine.ts'

export type BridgeCaller = (method: string, params?: unknown) => Promise<any>

function runOrcaJson(cliPath: string, args: string[], timeout = 30_000): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(cliPath, [...args, '--json'], { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        let detail = ''
        try {
          const parsed = JSON.parse(stdout.toString())
          if (parsed?.error) detail = `${parsed.error.code ?? 'error'}: ${parsed.error.message ?? ''}`
        } catch {
          // Not JSON.
        }
        if (!detail) detail = (stderr || stdout || '').toString().trim().split('\n').slice(-3).join(' ')
        reject(new Error(`orca ${args.slice(0, 3).join(' ')}: ${detail || error.message}`))
        return
      }
      try {
        const parsed = JSON.parse(stdout.toString())
        if (parsed && parsed.ok === false) {
          reject(new Error(parsed.error?.message ?? 'orca command failed'))
          return
        }
        resolve(parsed?.result ?? parsed)
      } catch (parseErr) {
        reject(new Error(`orca ${args.slice(0, 2).join(' ')}: invalid JSON: ${String((parseErr as Error).message)}`))
      }
    })
  })
}

export class OrcaTransport implements HostLike {
  private bridge: BridgeCaller | null = null
  private readonly getCliPath: () => string
  private readonly log: (msg: string) => void

  constructor(getCliPath: () => string, log: (msg: string) => void) {
    this.getCliPath = getCliPath
    this.log = log
  }

  get bridgeConnected(): boolean {
    return this.bridge !== null
  }

  setBridge(caller: BridgeCaller | null): void {
    this.bridge = caller
  }

  async call(method: string, params?: any): Promise<any> {
    // Prefer the connected thin Orca plugin bridge when available.
    const bridge = this.bridge
    if (bridge) {
      return bridge(method, params)
    }

    const cli = resolveOrcaCli(this.getCliPath())
    switch (method) {
      case 'agents.list': {
        const args = ['agent', 'list']
        if (params?.workspaceId) args.push('--worktree', `id:${params.workspaceId}`)
        const res = await runOrcaJson(cli, args)
        const agents = Array.isArray(res?.agents) ? res.agents : Array.isArray(res) ? res : []
        return { agents }
      }
      case 'workspace.list': {
        const res = await runOrcaJson(cli, ['worktree', 'list'])
        const list = Array.isArray(res?.worktrees) ? res.worktrees : Array.isArray(res) ? res : []
        return {
          workspaces: list.map((w: any) => ({
            id: w.id ?? w.worktreeId ?? '',
            path: w.path ?? '',
            branch: w.branch,
            name: w.name ?? w.displayName,
            hostId: w.hostId ?? w.executionHostId
          }))
        }
      }
      case 'workspace.getFocused': {
        try {
          const res = await runOrcaJson(cli, ['worktree', 'show', '--worktree', 'active'])
          const w = res?.worktree ?? res
          if (!w?.id && !w?.worktreeId) return { workspace: null }
          return {
            workspace: {
              id: w.id ?? w.worktreeId,
              path: w.path ?? '',
              branch: w.branch,
              name: w.name ?? w.displayName,
              hostId: w.hostId ?? w.executionHostId
            }
          }
        } catch {
          return { workspace: null }
        }
      }
      case 'project.list': {
        const res = await runOrcaJson(cli, ['project', 'list'])
        return { projects: Array.isArray(res?.projects) ? res.projects : Array.isArray(res) ? res : [] }
      }
      case 'terminal.list': {
        const args = ['terminal', 'list']
        if (params?.workspaceId) args.push('--worktree', `id:${params.workspaceId}`)
        const res = await runOrcaJson(cli, args)
        return { terminals: Array.isArray(res?.terminals) ? res.terminals : [] }
      }
      case 'terminal.read': {
        const args = ['terminal', 'read', '--terminal', String(params?.terminalId ?? '')]
        if (params?.maxLines) args.push('--limit', String(params.maxLines))
        const res = await runOrcaJson(cli, args)
        const text = typeof res?.output === 'string' ? res.output : typeof res?.text === 'string' ? res.text : ''
        const lines = Array.isArray(res?.lines) ? res.lines : text ? text.split('\n') : []
        return { lines, text }
      }
      case 'terminal.sendText': {
        const args = ['terminal', 'send', '--terminal', String(params?.terminalId ?? ''), `--text=${String(params?.text ?? '')}`]
        if (params?.enter) args.push('--enter')
        await runOrcaJson(cli, args)
        return { ok: true }
      }
      case 'terminal.close': {
        await runOrcaJson(cli, ['terminal', 'close', '--terminal', String(params?.terminalId ?? '')])
        return { ok: true }
      }
      case 'agent.launch': {
        const args = ['agent', 'launch', '--agent', String(params?.agent ?? ''), '--surface', 'terminal']
        if (params?.workspaceId) args.push('--worktree', `id:${params.workspaceId}`)
        if (params?.prompt) args.push('--prompt', String(params.prompt))
        const res = await runOrcaJson(cli, args)
        return { terminalId: res?.terminalId ?? res?.terminal?.id ?? res?.handle }
      }
      case 'agent.resume': {
        throw new Error(
          'Resuming a session by ID requires the thin OAH Orca plugin to be enabled in Orca (orca agent launch does not yet expose --resume).'
        )
      }
      case 'notifications.show': {
        this.log(`[notify] ${String(params?.title ?? 'OAH')}: ${String(params?.body ?? '')}`)
        return { ok: true }
      }
      default:
        throw new Error(`Unsupported standalone host method "${method}" (connect the thin OAH Orca plugin)`)
    }
  }
}
