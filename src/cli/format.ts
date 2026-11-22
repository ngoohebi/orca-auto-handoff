// Human-readable output formatters and account resolution for the `oah` CLI.
import { PROVIDER_NAME } from '../core/labels.ts'
import type { HistoryEntry, Snapshot } from '../core/types.ts'
import type { DaemonPing } from './client.ts'

function pct(w?: { usedPercent: number }): string {
  if (!w || typeof w.usedPercent !== 'number') return '-'
  return `${Math.max(0, Math.min(100, Math.floor(100 - w.usedPercent)))}% left`
}

export function span(ms: number): string {
  if (!(ms > 0)) return 'now'
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${m % 60 ? `${m % 60}m` : ''}`
  return `${Math.round(h / 24)}d`
}

export function formatStatus(snap: Snapshot, version: string, now = Date.now()): string {
  const out: string[] = []
  const mode = snap.mode === 'my-order' ? 'Custom order' : 'Auto'
  const timing = snap.atLimitOnly ? 'At limit' : 'Early when away'
  const header = `OAH ${version} · ${snap.paused ? 'Paused' : `${mode} · ${timing}`}${snap.held ? ' · held' : ''}`
  out.push(header)

  const providers: Snapshot['seats'][number]['provider'][] = []
  for (const s of snap.seats ?? []) {
    if (!providers.includes(s.provider)) providers.push(s.provider)
  }

  if (providers.length === 0) {
    out.push('', 'No managed accounts reported by Orca yet.')
  }

  for (const p of providers) {
    out.push('')
    const off = snap.services?.[p] === false ? '  (automatic hand-off off)' : ''
    const onScreen = snap.focused === p ? '  · on screen' : ''
    out.push(`${PROVIDER_NAME[p] ?? p}${off}${onScreen}`)
    for (const s of snap.seats.filter((x) => x.provider === p)) {
      const cooling = s.cooldownUntil && s.cooldownUntil > now
      const usage = s.usage?.known
        ? `${s.provider === 'devin' ? 'day' : '5h'} ${pct(s.usage.session)}${s.usage.session?.resetsAt ? ` (${span(s.usage.session.resetsAt - now)})` : ''} · week ${pct(s.usage.weekly)}${s.usage.weekly?.resetsAt ? ` (${span(s.usage.weekly.resetsAt - now)})` : ''}`
        : 'no usage yet'
      const state = cooling ? `limited ${span(s.cooldownUntil! - now)}` : s.active ? 'active' : 'ready'
      const circuit = s.circuit && s.circuit !== 'closed' ? `  [${s.circuit.replace('_', '-')}]` : ''
      const skip = s.excluded ? '  [skipped]' : ''
      const runway = s.runwayMs !== undefined ? `  ~${span(s.runwayMs)} left` : ''
      out.push(`  ${s.active ? '●' : '○'} ${s.label}  ${state}  ${usage}${runway}${circuit}${skip}`)
    }
  }

  if ((snap.waiting ?? []).length > 0) {
    out.push('', 'Waiting to hand off:')
    for (const w of snap.waiting) {
      const due = w.wakeAt > now ? `in ${span(w.wakeAt - now)}` : 'now'
      const screen = w.activeSince !== undefined ? ' · on screen' : ''
      out.push(`  ${PROVIDER_NAME[w.agent] ?? w.agent} ${w.terminalId} · ${due}${screen}`)
    }
  }

  if (snap.error) out.push('', `Cannot read accounts: ${snap.error}`)
  return out.join('\n')
}

export function formatHistory(entries: HistoryEntry[]): string {
  if (!entries.length) return 'No hand-off history yet.'
  return entries
    .map((e) => {
      const ts = new Date(e.at).toISOString().replace('T', ' ').slice(0, 19)
      const prov = PROVIDER_NAME[e.provider] ?? e.provider
      const route = e.from || e.to ? ` ${e.from ?? '?'} -> ${e.to ?? '?'}` : ''
      const note = e.why || e.detail ? ` — ${e.why ?? e.detail}` : ''
      return `${ts}  ${prov}  [${e.result}]${route} (${e.reason})${note}`
    })
    .join('\n')
}

export function formatDaemonStatus(info: DaemonPing | null, sockPath: string): string {
  if (!info) return `oahd is not running (socket: ${sockPath})`
  const bridge = info.bridgeConnected ? 'connected' : 'standalone (no Orca plugin bridge)'
  return [
    `oahd ${info.version} running (pid ${info.pid})`,
    `  uptime: ${span(info.uptimeMs)}`,
    `  socket: ${sockPath}`,
    `  orca bridge: ${bridge}`
  ].join('\n')
}

export function resolveSeat(snap: Snapshot, query: string | undefined): Snapshot['seats'][number] {
  if (!query?.trim()) throw new Error('Name an account. Run `oah status` to see them.')
  const raw = query.trim()
  const seats = snap.seats ?? []
  const colon = raw.indexOf(':')
  const scoped = colon > 0 ? seats.filter((s) => s.provider === raw.slice(0, colon).toLowerCase()) : []
  const pool = scoped.length ? scoped : seats
  const want = (scoped.length ? raw.slice(colon + 1) : raw).toLowerCase()

  const exact =
    seats.find((s) => s.key.toLowerCase() === raw.toLowerCase()) ??
    pool.find((s) => s.accountId.toLowerCase() === want || s.label.toLowerCase() === want)
  if (exact) return exact

  const partial = pool.filter((s) => s.label.toLowerCase().includes(want) || s.accountId.toLowerCase().includes(want))
  if (partial.length === 1) return partial[0]!
  if (partial.length > 1) {
    throw new Error(`"${query}" matches ${partial.length} accounts: ${partial.map((s) => s.key).join(', ')}`)
  }
  throw new Error(`No account matching "${query}". Run \`oah status\` to see them.`)
}

export const HELP_TEXT = [
  'oah — Orca Auto Hand-off CLI',
  '',
  'Usage: oah <command> [options]',
  '',
  'Status & inspection:',
  '  oah [status] [--json]               Accounts, usage, cooldowns, circuit state and waiting sessions',
  '  oah active [service] [--json]       Active account(s) for scripts and external agents',
  '  oah refresh [--json]                Ask Orca to refresh usage, then show status',
  '  oah history [--limit N] [--json]    Recent hand-off history',
  '  oah debug [--json]                  Daemon health and recent status events',
  '  oah version [--json]                CLI and daemon version',
  '',
  'Account & hand-off controls:',
  '  oah use <account> [--force]         Select <account> and hand off the on-screen session',
  '  oah handoff                         Hand off the focused workspace session',
  '  oah next [service]                  Select the next healthy account for new sessions',
  '  oah pause | resume                  Turn automatic hand-off off or on globally',
  '  oah service <service> on|off        Turn automatic hand-off on or off for one service',
  '  oah skip <account> [on|off]         Skip an account during automatic hand-off',
  '  oah clear <account>                 Clear an account cooldown / reset circuit breaker',
  '  oah order up|down <account>         Move an account in the custom order',
  '  oah pin <id> <account>              Pin a workspace or terminal to one account',
  '  oah unpin <id> | oah pins           Remove or list explicit pins',
  '',
  'Local HTTP proxy & API-key providers:',
  '  oah proxy start [--port 4080]|stop|status',
  '  oah provider list|add|rm|on|off     Manage API-key / relay failover providers',
  '  oah bench [--json]                  Benchmark endpoint latency across providers',
  '',
  'Hooks, sync & sessions:',
  '  oah event stop-failure              Instant Claude StopFailure hook trigger',
  '  oah sync export | import <file>     Export or import portable config JSON',
  '  oah session                         Persistent NDJSON stdio session attached to oahd',
  '',
  'Waiting session responses:',
  '  oah now <terminalId>                Hand off a waiting on-screen session now',
  '  oah notnow <terminalId>             Wait until you switch tabs',
  '  oah cancel <terminalId>             Cancel a waiting hand-off',
  '',
  'Configuration & status line:',
  '  oah config [get [key]]              Show settings',
  '  oah config set <key> <value>        Change a setting (aliases: settings, set)',
  '  oah statusline [status|install|remove]',
  '',
  'Daemon:',
  '  oah daemon start|stop|restart|status|logs',
  '',
  'Flags:',
  '  --json       Print machine-readable JSON output',
  '  --force      Proceed over unsent text that cannot go along (`oah use`)',
  '  -h, --help   Show this help'
].join('\n')
