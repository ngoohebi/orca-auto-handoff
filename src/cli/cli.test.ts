// Tests for the `oah` CLI commands and formatting against a live in-process `OahDaemon`.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Cli, HostLike } from '../core/engine.ts'
import { memoryFiles } from '../core/statusline-files.ts'
import { VERSION } from '../core/version.ts'
import { OahDaemon } from '../daemon/server.ts'
import { OahClient } from './client.ts'
import { runCli } from './commands.ts'

function setupDaemon() {
  const dir = mkdtempSync(join(tmpdir(), 'oah-cli-'))
  const selected: string[] = []
  const host: HostLike = {
    async call(method: string) {
      if (method === 'agents.list') return { agents: [] }
      if (method === 'workspace.list') return { workspaces: [] }
      if (method === 'workspace.getFocused') return { workspace: null }
      if (method === 'project.list') return { projects: [] }
      return {}
    }
  }
  const cli: Cli = {
    async listAccounts() {
      return {
        claude: {
          activeAccountId: 'a1',
          accounts: [
            { id: 'a1', email: 'work@example.com', rateLimits: { claude: { session: { usedPercent: 30, resetsAt: null }, weekly: { usedPercent: 15, resetsAt: null } } } },
            { id: 'a2', email: 'personal@example.com', rateLimits: { claude: { session: { usedPercent: 5, resetsAt: null }, weekly: { usedPercent: 10, resetsAt: null } } } }
          ]
        }
      }
    },
    async select(provider, accountId) {
      selected.push(`${provider}:${accountId}`)
    },
    async closeTerminal() {},
    async sendText() {},
    async git() {
      return ''
    },
    async activeTerminals() {
      return []
    },
    async visibleTerminals() {
      return []
    },
    async draft() {
      return ''
    }
  }
  const daemon = new OahDaemon({ home: dir, host, cli, files: memoryFiles('/home/test'), background: false })
  const client = new OahClient(dir, daemon.sockPath)
  return { dir, daemon, client, selected }
}

test('oah CLI: help, version, status, --json, pause/resume, service, skip, config', async () => {
  const { dir, daemon, client } = setupDaemon()
  try {
    await daemon.start()

    const help = await runCli(['help'], client, { autoStart: false })
    assert.equal(help.code, 0)
    assert.match(help.stdout, /oah — Orca Auto Hand-off CLI/)

    const ver = await runCli(['version', '--json'], client, { autoStart: false })
    assert.equal(ver.code, 0)
    assert.equal(JSON.parse(ver.stdout).cli, VERSION)
    assert.equal(JSON.parse(ver.stdout).daemon, VERSION)

    const status = await runCli(['refresh'], client, { autoStart: false })
    assert.equal(status.code, 0)
    assert.match(status.stdout, /work@example\.com/)
    assert.match(status.stdout, /personal@example\.com/)

    const paused = await runCli(['pause', '--json'], client, { autoStart: false })
    assert.equal(paused.code, 0)
    assert.equal(JSON.parse(paused.stdout).paused, true)

    const resumed = await runCli(['resume'], client, { autoStart: false })
    assert.equal(resumed.code, 0)
    assert.match(resumed.stdout, /resumed/)

    const svc = await runCli(['service', 'claude', 'off', '--json'], client, { autoStart: false })
    assert.equal(svc.code, 0)
    assert.equal(JSON.parse(svc.stdout).services.claude, false)

    const skip = await runCli(['skip', 'personal', '--json'], client, { autoStart: false })
    assert.equal(skip.code, 0)
    assert.equal(JSON.parse(skip.stdout).excluded, true)

    const set = await runCli(['config', 'set', 'timing', 'at-limit', '--json'], client, { autoStart: false })
    assert.equal(set.code, 0)
    assert.equal(JSON.parse(set.stdout).timing, 'at-limit')

    const getOne = await runCli(['config', 'get', 'timing'], client, { autoStart: false })
    assert.equal(getOne.code, 0)
    assert.match(getOne.stdout, /timing = "at-limit"/)

    const daemonStatus = await runCli(['daemon', 'status'], client, { autoStart: false })
    assert.equal(daemonStatus.code, 0)
    assert.match(daemonStatus.stdout, /oahd .* running/)

    // Custom order, clear cooldown, history, debug, rpc passthrough
    const ordered = await runCli(['order', 'up', 'personal', '--json'], client, { autoStart: false })
    assert.equal(ordered.code, 0)
    assert.equal(JSON.parse(ordered.stdout).direction, 'up')

    const cleared = await runCli(['clear', 'work', '--json'], client, { autoStart: false })
    assert.equal(cleared.code, 0)
    assert.equal(JSON.parse(cleared.stdout).cleared, true)

    const hist = await runCli(['history', '--limit', '10', '--json'], client, { autoStart: false })
    assert.equal(hist.code, 0)
    assert.ok(Array.isArray(JSON.parse(hist.stdout)))

    const dbg = await runCli(['debug', '--json'], client, { autoStart: false })
    assert.equal(dbg.code, 0)
    assert.equal(JSON.parse(dbg.stdout).version, VERSION)

    const rpc = await runCli(['rpc', 'ping'], client, { autoStart: false })
    assert.equal(rpc.code, 0)
    assert.equal(JSON.parse(rpc.stdout).version, VERSION)

    const bad = await runCli(['unknown-cmd'], client, { autoStart: false })
    assert.equal(bad.code, 1)
    assert.match(bad.stderr, /Unknown command/)

    const badJson = await runCli(['unknown-cmd', '--json'], client, { autoStart: false })
    assert.equal(badJson.code, 1)
    assert.equal(JSON.parse(badJson.stdout).ok, false)
  } finally {
    await daemon.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
