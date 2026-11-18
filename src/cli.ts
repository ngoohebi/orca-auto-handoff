// The `orca` CLI and git, run from the worker (Node). The host API has no account switch, so
// selecting an account goes through `orca account select`, as the status-bar switcher does.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { Cli } from './engine'
import type { Provider } from './types'

const MAC_APP_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'

export function resolveOrcaCli(configured: string): string {
  if (configured.trim()) return configured.trim()
  const fromEnv = process.env.ORCA_CLI_COMMAND
  if (fromEnv) return fromEnv
  if (process.platform === 'darwin' && existsSync(MAC_APP_CLI)) return MAC_APP_CLI
  // On Linux bare `orca` is usually the GNOME screen reader; Orca installs `orca-ide` there.
  return process.platform === 'linux' ? 'orca-ide' : 'orca'
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

export function nodeCli(getPath: () => Promise<string>): Cli {
  return {
    async listAccounts() {
      return orcaJson(resolveOrcaCli(await getPath()), ['account', 'list'])
    },
    async select(provider: Provider, accountId: string) {
      await orcaJson(resolveOrcaCli(await getPath()), ['account', 'select', '--agent', provider, '--account', accountId])
    },
    async closeTerminal(terminalId: string) {
      await orcaJson(resolveOrcaCli(await getPath()), ['terminal', 'close', '--terminal', terminalId])
    },
    async sendText(terminalId: string, text: string) {
      await orcaJson(resolveOrcaCli(await getPath()), ['terminal', 'send', '--terminal', terminalId, '--text', text, '--enter'])
    },
    async git(cwd: string, args: string[]) {
      return run('git', ['-C', cwd, ...args], undefined, 10_000)
    }
  }
}
