// Command router for the `oah` CLI. Pure enough to test in-process with an injected `OahClient`.
import { existsSync, readFileSync } from 'node:fs'
import type { HistoryEntry, Snapshot } from '../core/types.ts'
import { VERSION } from '../core/version.ts'
import { logPathFor } from '../daemon/store.ts'
import type { OahClient } from './client.ts'
import { formatDaemonStatus, formatHistory, formatStatus, HELP_TEXT, resolveSeat } from './format.ts'

export type CliOutput = {
  code: number
  stdout: string
  stderr: string
}

function parseArgs(argv: readonly string[]): { words: string[]; flags: Record<string, string | boolean> } {
  const words: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--json' || a === '--force' || a === '-h' || a === '--help') {
      flags[a === '-h' ? 'help' : a.replace(/^--/, '')] = true
    } else if (a === '--limit') {
      flags.limit = argv[++i] ?? ''
    } else {
      words.push(a)
    }
  }
  return { words, flags }
}

function parseOnOff(word: string | undefined, fallback?: boolean): boolean {
  if (word === undefined) {
    if (fallback !== undefined) return fallback
    throw new Error('Specify "on" or "off".')
  }
  if (/^(on|yes|true|1)$/i.test(word)) return true
  if (/^(off|no|false|0)$/i.test(word)) return false
  throw new Error(`Expected "on" or "off", got "${word}".`)
}

function parseSettingValue(raw: string): string | number | boolean {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  return raw
}

export async function runCli(
  argv: readonly string[],
  client: OahClient,
  opts: { autoStart?: boolean; now?: () => number } = {}
): Promise<CliOutput> {
  const { words, flags } = parseArgs(argv)
  const json = flags.json === true
  const ok = (text: string, data?: unknown): CliOutput => ({
    code: 0,
    stdout: `${json ? JSON.stringify(data ?? { message: text }, null, 2) : text}\n`,
    stderr: ''
  })

  try {
    if (flags.help || words[0] === 'help') return ok(HELP_TEXT, { help: HELP_TEXT })

    const cmd = words[0] ?? 'status'

    // Daemon lifecycle commands do not auto-start unless asked.
    if (cmd === 'daemon') {
      const sub = words[1] ?? 'status'
      if (sub === 'status') {
        const info = await client.ping()
        return ok(formatDaemonStatus(info, client.sockPath), { running: !!info, sockPath: client.sockPath, ...(info ?? {}) })
      }
      if (sub === 'start') {
        const info = await client.ensureDaemon()
        return ok(formatDaemonStatus(info, client.sockPath), { running: true, sockPath: client.sockPath, ...info })
      }
      if (sub === 'stop') {
        const res = await client.stopDaemon()
        return ok(res.stopped ? `oahd stopped${res.pid ? ` (pid ${res.pid})` : ''}` : 'oahd is not running', res)
      }
      if (sub === 'restart') {
        await client.stopDaemon()
        const info = await client.ensureDaemon()
        return ok(formatDaemonStatus(info, client.sockPath), { running: true, sockPath: client.sockPath, ...info })
      }
      if (sub === 'logs') {
        const logFile = logPathFor(client.home)
        if (!existsSync(logFile)) return ok('No daemon log yet.', { logFile, lines: [] })
        const lines = readFileSync(logFile, 'utf8').trim().split('\n')
        const limit = Number(flags.limit) > 0 ? Number(flags.limit) : 50
        const tail = lines.slice(-limit)
        return ok(tail.join('\n'), { logFile, lines: tail })
      }
      throw new Error(`Unknown daemon subcommand "${sub}". Use: start, stop, restart, status, logs.`)
    }

    if (cmd === 'version') {
      const info = await client.ping()
      const text = info ? `oah ${VERSION} · oahd ${info.version} (pid ${info.pid})` : `oah ${VERSION} · oahd not running`
      return ok(text, { cli: VERSION, daemon: info?.version ?? null, pid: info?.pid ?? null })
    }

    // All other commands talk to `oahd` (auto-starting it by default).
    if (opts.autoStart !== false) await client.ensureDaemon()
    const snap = () => client.call<Snapshot>('snapshot', {})

    switch (cmd) {
      case 'status':
      case 'refresh': {
        const data = await client.call<Snapshot>('snapshot', cmd === 'refresh' ? { refresh: true } : {})
        return ok(formatStatus(data, VERSION, opts.now?.()), data)
      }
      case 'history': {
        const limit = Number(flags.limit) > 0 ? Number(flags.limit) : 50
        const data = await client.call<HistoryEntry[]>('history', { limit })
        return ok(formatHistory(data), data)
      }
      case 'use': {
        const seat = resolveSeat(await snap(), words[1])
        let res = await client.call<{ message: string; draft?: { terminalId: string; text: string } }>('switchTo', { seatKey: seat.key })
        if (res.draft && flags.force) {
          res = await client.call('switchTo', { seatKey: seat.key, acceptDraft: true, draft: res.draft })
        }
        const extra = res.draft ? '\nRun again with --force to hand it off anyway; that text will be lost.' : ''
        return ok(`${res.message}${extra}`, res)
      }
      case 'handoff': {
        const res = await client.call<{ message: string }>('handoff', {})
        return ok(res.message, res)
      }
      case 'next': {
        const provider = (words[1] ?? 'claude').toLowerCase()
        const res = await client.call<{ message: string }>('nextAccount', { provider })
        return ok(res.message, res)
      }
      case 'pause':
      case 'resume': {
        const paused = cmd === 'pause'
        const res = await client.call<{ paused: boolean }>('pause', { paused })
        return ok(`Automatic hand-off ${paused ? 'paused' : 'resumed'}`, res)
      }
      case 'service': {
        const provider = String(words[1] ?? '').toLowerCase()
        if (!provider) throw new Error('Usage: oah service <claude|codex|antigravity|opencode|devin> on|off')
        const enabled = parseOnOff(words[2])
        const res = await client.call('setService', { provider, enabled })
        return ok(`${provider}: automatic hand-off ${enabled ? 'on' : 'off'}`, res)
      }
      case 'skip': {
        const seat = resolveSeat(await snap(), words[1])
        const excluded = parseOnOff(words[2], true)
        await client.call('setExcluded', { seatKey: seat.key, excluded })
        return ok(`${seat.label}: ${excluded ? 'skipped by automatic hand-off' : 'no longer skipped'}`, { seatKey: seat.key, excluded })
      }
      case 'clear': {
        const seat = resolveSeat(await snap(), words[1])
        await client.call('clearCooldown', { seatKey: seat.key })
        return ok(`${seat.label}: cooldown cleared`, { seatKey: seat.key, cleared: true })
      }
      case 'order': {
        const dir = words[1]
        if (dir !== 'up' && dir !== 'down') throw new Error('Usage: oah order up|down <account>')
        const seat = resolveSeat(await snap(), words[2])
        await client.call('moveSeat', { seatKey: seat.key, by: dir === 'up' ? -1 : 1 })
        return ok(`${seat.label} moved ${dir} in custom order`, { seatKey: seat.key, direction: dir })
      }
      case 'up':
      case 'down': {
        const seat = resolveSeat(await snap(), words[1])
        await client.call('moveSeat', { seatKey: seat.key, by: cmd === 'up' ? -1 : 1 })
        return ok(`${seat.label} moved ${cmd} in custom order`, { seatKey: seat.key, direction: cmd })
      }
      case 'settings':
      case 'config': {
        const sub = cmd === 'settings' ? 'get' : words[1] ?? 'get'
        if (sub === 'set') {
          const key = words[2]
          if (!key || words.length < 4) throw new Error('Usage: oah config set <key> <value>')
          const val = parseSettingValue(words.slice(3).join(' '))
          const all = await client.call<Record<string, unknown>>('settings', { key, value: val })
          return ok(`${key} = ${JSON.stringify(all[key])}`, all)
        }
        const all = await client.call<Record<string, unknown>>('settings', {})
        const key = sub === 'get' ? words[2] : sub
        if (key && key !== 'get') {
          if (!(key in all)) throw new Error(`Unknown setting "${key}".`)
          return ok(`${key} = ${JSON.stringify(all[key])}`, { [key]: all[key] })
        }
        const text = Object.keys(all)
          .map((k) => `${k} = ${JSON.stringify(all[k])}`)
          .join('\n')
        return ok(text, all)
      }
      case 'set': {
        const key = words[1]
        if (!key || words.length < 3) throw new Error('Usage: oah set <key> <value>')
        const val = parseSettingValue(words.slice(2).join(' '))
        const all = await client.call<Record<string, unknown>>('settings', { key, value: val })
        return ok(`${key} = ${JSON.stringify(all[key])}`, all)
      }
      case 'now': {
        if (!words[1]) throw new Error('Usage: oah now <terminalId>')
        const res = await client.call<{ ok: true; message?: string }>('handoffNow', { terminalId: words[1] })
        return ok(res.message ?? 'Handed off', res)
      }
      case 'notnow': {
        if (!words[1]) throw new Error('Usage: oah notnow <terminalId>')
        const res = await client.call('declineHandoff', { terminalId: words[1] })
        return ok('Waiting until you switch tabs', res)
      }
      case 'cancel': {
        if (!words[1]) throw new Error('Usage: oah cancel <terminalId>')
        const res = await client.call('cancelWaiting', { terminalId: words[1] })
        return ok('No longer waiting to hand off', res)
      }
      case 'statusline': {
        const sub = words[1] ?? 'status'
        if (sub === 'status') {
          const res = await client.call<{ installed: boolean; workspace?: string; reason?: string }>('consoleLine', {})
          const text = res.installed
            ? `Status line installed (${res.workspace ?? 'workspace'})`
            : `Status line not installed${res.reason ? `: ${res.reason}` : ''}`
          return ok(text, res)
        }
        if (sub === 'install' || sub === 'remove') {
          const res = await client.call<{ installed: boolean; message?: string }>('consoleLine', { enabled: sub === 'install' })
          return ok(res.message ?? (sub === 'install' ? 'Installed' : 'Removed'), res)
        }
        throw new Error(`Unknown statusline subcommand "${sub}". Use: status, install, remove.`)
      }
      case 'debug': {
        const res = await client.call('debug', {})
        return ok(JSON.stringify(res, null, 2), res)
      }
      case 'rpc': {
        const method = words[1]
        if (!method) throw new Error('Usage: oah rpc <method> [jsonParams]')
        const params = words[2] ? (JSON.parse(words[2]) as Record<string, unknown>) : {}
        const res = await client.call(method, params)
        return ok(JSON.stringify(res, null, 2), res)
      }
      default:
        throw new Error(`Unknown command "${cmd}". Run \`oah help\`.`)
    }
  } catch (err) {
    const message = String((err as Error)?.message ?? err)
    return {
      code: 1,
      stdout: json ? `${JSON.stringify({ ok: false, error: { message } }, null, 2)}\n` : '',
      stderr: json ? '' : `oah: ${message}\n`
    }
  }
}
