// The console status line: the status file, the settings.local.json merge, the wrapper script run
// by a real `sh`, and the worker commands against memory files.
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  DEFAULT_FORMAT,
  SCRIPT,
  STATUSLINE_COMMAND,
  displayLabels,
  installIntoSettings,
  renderStatusFile,
  uninstallFromSettings
} from './statusline'
import { ConsoleStatusLine, memoryFiles, nodeFiles } from './statusline-files'
import type { Snapshot } from './types'
import { activateWith } from './worker'

const NOW = 1_800_000_000_000
const seat = (
  provider: 'claude' | 'codex',
  accountId: string,
  label: string,
  extra: Partial<Snapshot['seats'][number]> = {}
): Snapshot['seats'][number] => ({
  key: `${provider}:${accountId}`,
  provider,
  accountId,
  label,
  active: false,
  usage: { known: true, session: { usedPercent: 42.4, resetsAt: null }, weekly: { usedPercent: 18, resetsAt: null } },
  ...extra
})
const snapshot = (now = NOW): Snapshot => ({
  paused: false,
  updatedAt: now,
  seats: [
    seat('claude', 'aaa', 'me@example.com', { active: true, usage: { known: true, session: { usedPercent: 42.4, resetsAt: null }, weekly: { usedPercent: 18, resetsAt: null }, model: { name: 'fable', usedPercent: 94, resetsAt: null } } }),
    seat('claude', 'bbb', 'other@example.com', { cooldownUntil: now + 80 * 60_000, cooldownReason: 'rate_limit', usage: { known: true, session: { usedPercent: 100, resetsAt: null }, weekly: { usedPercent: 60, resetsAt: null } } }),
    seat('claude', 'system', 'system (third@example.com)', { usage: { known: false } }),
    seat('codex', 'x1', 'team@example.com', { active: true })
  ],
  waiting: [],
  history: [],
  services: { claude: true, codex: true, antigravity: true, opencode: true, devin: true }
})

test('status file: one seat row per account, short labels, cooldowns as epoch seconds', () => {
  const text = renderStatusFile(snapshot(), '  {model}\t{accounts}  ', NOW)
  const rows = text.split('\n')
  assert.equal(rows[1], 'format\t{model} {accounts}')
  assert.equal(rows[2], 'width\t8')
  assert.equal(rows[3], 'paused\t0')
  // Every Claude account is @example.com, so the domain is dropped. Rows follow the panel's
  // order: the account in use, usable standbys, then the limited and drained ones.
  assert.equal(rows[4], `seat\tclaude\taaa\tme\t1\t42\t18\t0\t94\tfable`)
  assert.equal(rows[5], `seat\tclaude\tsystem\tsystem (third)\t0\t-\t-\t0\t-\t-`)
  assert.equal(rows[6], `seat\tclaude\tbbb\tother\t0\t100\t60\t${Math.ceil((NOW + 80 * 60_000) / 1000)}\t-\t-`)
  assert.equal(rows[7], `seat\tcodex\tx1\tteam\t1\t42\t18\t0\t-\t-`)
  assert.ok(renderStatusFile(snapshot(), '', NOW).includes('format\t\nwidth'), 'no header by default')
  assert.ok(renderStatusFile(snapshot(), '', NOW, 12).includes('width\t12'))
  assert.ok(renderStatusFile(snapshot(), '', NOW, 0).includes('width\t8'), 'an invalid width falls back')
  // Numbers Orca marks as not fresh (the account has not run yet) are written as unknown.
  const stale = snapshot()
  stale.seats[0]!.usage = { known: false, session: { usedPercent: 0, resetsAt: null }, weekly: { usedPercent: 0, resetsAt: null } }
  assert.ok(renderStatusFile(stale, '', NOW).includes('seat\tclaude\taaa\tme\t1\t-\t-\t0\t-\t-'))
  // A cooldown already over is not written.
  const over = snapshot()
  over.seats[1]!.cooldownUntil = NOW - 1
  assert.ok(renderStatusFile(over, '', NOW).includes('seat\tclaude\tbbb\tother\t0\t100\t60\t0\t'))
})

test('status file: accounts in the order the panel shows them, not the order Orca lists them', () => {
  const snap = snapshot()
  const usage = (used: number): Snapshot['seats'][number]['usage'] => ({ known: true, session: { usedPercent: used, resetsAt: null }, weekly: { usedPercent: 5, resetsAt: null } })
  snap.seats = [
    seat('claude', 'drained', 'drained@example.com', { usage: usage(95) }),
    seat('claude', 'low', 'low@example.com', { usage: usage(70) }),
    seat('claude', 'limited', 'limited@example.com', { cooldownUntil: NOW + 60_000, usage: usage(10) }),
    seat('claude', 'fresh', 'fresh@example.com', { usage: usage(20) }),
    seat('claude', 'unknown', 'unknown@example.com', { usage: { known: false } }),
    seat('claude', 'active', 'active@example.com', { active: true, usage: usage(60) })
  ]
  const ids = renderStatusFile(snap, '', NOW)
    .split('\n')
    .filter((l) => l.startsWith('seat\t'))
    .map((l) => l.split('\t')[2])
  assert.deepEqual(ids, ['active', 'fresh', 'low', 'unknown', 'limited', 'drained'])
})

test('labels keep the domain when the accounts of a service differ in it', () => {
  const s = snapshot()
  s.seats[1]!.label = 'other@Other.org'
  const mixed = displayLabels(s.seats, 'claude')
  assert.equal(mixed.get('claude:aaa'), 'me@example.com')
  assert.equal(mixed.get('claude:bbb'), 'other@Other.org')
  assert.equal(mixed.get('claude:system'), 'system (third@example.com)')
  // Codex is judged on its own accounts: one domain → stripped.
  assert.equal(displayLabels(s.seats, 'codex').get('codex:x1'), 'team')
  // Case does not split a domain; a label without an email is left alone.
  s.seats[1]!.label = 'other@EXAMPLE.com'
  s.seats[2]!.label = 'system'
  assert.deepEqual([...displayLabels(s.seats, 'claude').values()], ['me', 'other', 'system'])
})

test('settings.local.json: install keeps an earlier statusLine aside, uninstall restores it', () => {
  const fresh = installIntoSettings(null)
  assert.equal(fresh.replaced, false)
  const parsed = JSON.parse(fresh.text)
  assert.deepEqual(parsed.statusLine, { type: 'command', command: STATUSLINE_COMMAND, padding: 0 })

  const theirs = JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, statusLine: { type: 'command', command: 'my-line' } })
  const merged = installIntoSettings(theirs)
  assert.equal(merged.replaced, true)
  const m = JSON.parse(merged.text)
  assert.deepEqual(m.permissions, { allow: ['Bash(ls)'] })
  assert.equal(m.statusLine.command, STATUSLINE_COMMAND)
  assert.deepEqual(m.accountRotatorPreviousStatusLine, { type: 'command', command: 'my-line' })
  // Installing twice does not move our own line into the backup.
  assert.equal(installIntoSettings(merged.text).replaced, false)

  const restored = uninstallFromSettings(merged.text)
  assert.equal(restored.changed, true)
  assert.deepEqual(JSON.parse(restored.text!), { permissions: { allow: ['Bash(ls)'] }, statusLine: { type: 'command', command: 'my-line' } })
  assert.deepEqual(uninstallFromSettings(fresh.text), { text: null, changed: true })
  assert.equal(uninstallFromSettings(theirs).changed, false)
  assert.throws(() => installIntoSettings('{ not json'))
  assert.throws(() => installIntoSettings('[]'))
})

type Run = { stdout: string; stderr: string; code: number }
function sh(script: string, stdin: string, env: Record<string, string>, cwd?: string): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile('/bin/sh', [script], { env, timeout: 5000, maxBuffer: 1 << 20, ...(cwd ? { cwd } : {}) }, (error, stdout, stderr) =>
      resolve({ stdout, stderr, code: error ? Number((error as { code?: number }).code ?? 1) : 0 })
    ) as { stdin: { end(text: string): void } }
    child.stdin.end(stdin)
  })
}
const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '')
/** The label column: the widest name of the rows, at most 15; longer names keep 14 + `…`. */
const pad = (label: string, width: number) => (label.length > 15 ? `${label.slice(0, 14)}…` : label.padEnd(width))

function fakeHome(): { home: string; hookOut: string; cleanup(): void } {
  const home = mkdtempSync(join(tmpdir(), 'rotator-sl-'))
  mkdirSync(join(home, '.orca/account-rotator'), { recursive: true })
  mkdirSync(join(home, '.orca/agent-hooks'), { recursive: true })
  writeFileSync(join(home, '.orca/account-rotator/claude-statusline.sh'), SCRIPT, { mode: 0o755 })
  const hookOut = join(home, 'hook-got.json')
  writeFileSync(join(home, '.orca/agent-hooks/claude-statusline.sh'), `#!/bin/sh\ncat > "${hookOut}"\n`)
  chmodSync(join(home, '.orca/agent-hooks/claude-statusline.sh'), 0o755)
  return { home, hookOut, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

const nowSec = Math.floor(Date.now() / 1000)
const PAYLOAD = JSON.stringify({
  model: { id: 'claude-opus-4-1', display_name: 'Opus 4.1' },
  context_window: {
    context_window_size: 200000,
    current_usage: { input_tokens: 50000, cache_creation_input_tokens: 10000, cache_read_input_tokens: 20000, output_tokens: 100 },
    used_percentage: 40.5
  },
  rate_limits: { five_hour: { used_percentage: 85.2, resets_at: nowSec + 7200 }, seven_day: { used_percentage: 19.9, resets_at: nowSec + 99999 } }
})

test('wrapper script: a header and one gauge row per account of the service, this pane marked and live', async () => {
  const fx = fakeHome()
  try {
    const status = renderStatusFile(snapshot(Date.now()), DEFAULT_FORMAT, Date.now())
    writeFileSync(join(fx.home, '.orca/account-rotator/status.tsv'), status)
    const script = join(fx.home, '.orca/account-rotator/claude-statusline.sh')
    const env = { HOME: fx.home, PATH: process.env.PATH ?? '/usr/bin:/bin', CLAUDE_CONFIG_DIR: `${fx.home}/claude-profiles/bbb/home` }

    const run = await sh(script, PAYLOAD, env)
    assert.equal(run.code, 0, run.stderr)
    const lines = plain(run.stdout).split('\n')
    assert.deepEqual(lines, [
      // No header by default. The next-launch account (aaa) keeps the file's numbers; the pane's
      // own (bbb) shows the live 85 % / 20 % used as 14 % / 80 % left, and its cooldown. The model
      // column is headed by the window's name from Orca (fable), `model` where unknown. Rows are
      // in the panel's order: the account in use, standbys, then the limited one last.
      `· ${pad('me', 14)}  5h █████░░░  58%  7d ███████░  82%  fable █░░░░░░░   6%`,
      `· ${pad('system (third)', 14)}  5h ········  n/a  7d ········  n/a  model ········  n/a`,
      `▶ ${pad('other', 14)}  5h █░░░░░░░  14%  7d ██████░░  80%  model ········  n/a  ⏸1h20m`,
      ''
    ])
    assert.ok(!run.stdout.includes('team'), 'codex seats are not shown in a Claude pane')
    // Colors: 15 % left is red, 82 % green, 0 would be bold red; the pane label is bold.
    assert.ok(run.stdout.includes('\u001b[31m█\u001b[0m\u001b[2m░░░░░░░\u001b[0m \u001b[31m 14%\u001b[0m'))
    assert.ok(run.stdout.includes('\u001b[32m███████\u001b[0m\u001b[2m░\u001b[0m \u001b[32m 82%\u001b[0m'))
    assert.ok(run.stdout.includes(`\u001b[1m${pad('other', 14)}\u001b[0m`))
    assert.ok(run.stdout.includes('\u001b[2m·\u001b[0m me '), 'other accounts get a dim dot')
    assert.ok(run.stdout.includes('\u001b[1;33m⏸1h20m\u001b[0m'))
    // Claude trims leading spaces off each row: no row may start with one.
    assert.ok(lines.filter(Boolean).every((l) => !l.startsWith(' ')), 'no row starts with a space')

    // Orca's hook got the payload unchanged (it runs in the background; give it a moment).
    await new Promise((r) => setTimeout(r, 300))
    const { readFileSync } = await import('node:fs')
    assert.equal(readFileSync(fx.hookOut, 'utf8'), PAYLOAD)

    // A header when the format is set, paused; pane on the system login; 0 % left is bold red; a
    // longer model name widens that column for every row.
    const paused = snapshot(Date.now())
    paused.paused = true
    paused.seats[0]!.usage.model = { name: 'mythos', usedPercent: 94, resetsAt: null }
    paused.seats[2]!.label = 'system (averyveryverylongname@example.com)' // 42 chars
    paused.seats[2]!.usage = { known: true, session: { usedPercent: 100, resetsAt: null }, weekly: { usedPercent: 130, resetsAt: null } }
    paused.seats[1]!.label = 'me@other.org' // a second domain → full emails
    writeFileSync(join(fx.home, '.orca/account-rotator/status.tsv'), renderStatusFile(paused, '{model}', Date.now()))
    const sys = await sh(script, PAYLOAD, { HOME: fx.home, PATH: env.PATH })
    assert.deepEqual(plain(sys.stdout).split('\n'), [
      'Opus 4.1 │ ⏸ switching paused',
      `· ${pad('me@example.com', 15)}  5h █████░░░  58%  7d ███████░  82%  mythos █░░░░░░░   6%`,
      `· ${pad('me@other.org', 15)}  5h ░░░░░░░░   0%  7d ███░░░░░  40%  model  ········  n/a  ⏸1h20m`,
      '▶ system (averyv…  5h █░░░░░░░  14%  7d ██████░░  80%  model  ········  n/a',
      ''
    ])
    assert.ok(sys.stdout.includes('\u001b[1;31m\u001b[0m\u001b[2m░░░░░░░░\u001b[0m \u001b[1;31m  0%\u001b[0m'))

    // No status file yet: the live numbers alone, with a hint.
    rmSync(join(fx.home, '.orca/account-rotator/status.tsv'))
    const bare = await sh(script, PAYLOAD, env)
    assert.deepEqual(plain(bare.stdout).split('\n'), [
      `▶ ${pad('this pane', 9)}  5h █░░░░░░░  14%  7d ██████░░  80%  model ········  n/a  no rotator status yet`,
      ''
    ])

    // Empty stdin prints nothing.
    assert.equal((await sh(script, '', env)).stdout, '')
  } finally {
    fx.cleanup()
  }
})

test('wrapper script: without jq the sed fallback reads the same fields', async () => {
  const fx = fakeHome()
  try {
    writeFileSync(join(fx.home, '.orca/account-rotator/status.tsv'), renderStatusFile(snapshot(Date.now()), '{model}|{ctx}|{5h}|{7d}|{best}', Date.now()))
    const script = join(fx.home, '.orca/account-rotator/claude-statusline.sh')
    // A PATH with the basics but no jq.
    const bin = join(fx.home, 'bin')
    mkdirSync(bin)
    const { existsSync, symlinkSync } = (await import('node:fs')) as unknown as { existsSync(p: string): boolean; symlinkSync(target: string, path: string): void }
    for (const tool of ['sed', 'tr', 'date', 'cat']) {
      const found = ['/usr/bin', '/bin'].map((d) => join(d, tool)).find((p) => existsSync(p))
      assert.ok(found, `${tool} on this machine`)
      symlinkSync(found!, join(bin, tool))
    }
    const withoutCtxPercent = PAYLOAD.replace(',"used_percentage":40.5', '')
    const run = await sh(script, withoutCtxPercent, { HOME: fx.home, PATH: bin, CLAUDE_CONFIG_DIR: `${fx.home}/claude-profiles/aaa/home` })
    assert.equal(run.code, 0, run.stderr)
    assert.equal(plain(run.stdout).split('\n')[0], 'Opus 4.1|60|14|80|fable', run.stderr)
    assert.equal(plain(run.stdout).split('\n')[1], `▶ ${pad('me', 14)}  5h █░░░░░░░  14%  7d ██████░░  80%  fable █░░░░░░░   6%`)
  } finally {
    fx.cleanup()
  }
})

// ---- per-pane live usage (live-usage.ts) ------------------------------------------------------

const liveFile = (home: string, key: string) => join(home, `.orca/account-rotator/live/claude-${key}.tsv`)
const fs = () => import('node:fs')
const FIVE_RESET = nowSec + 7200
const WEEK_RESET = nowSec + 99999

test('wrapper script: leaves the pane\'s own numbers in a live file for its profile, and for the system login', async () => {
  const fx = fakeHome()
  try {
    const { existsSync, readFileSync, readdirSync } = await fs()
    const script = join(fx.home, '.orca/account-rotator/claude-statusline.sh')
    const base = { HOME: fx.home, PATH: process.env.PATH ?? '/usr/bin:/bin' }
    const before = Math.floor(Date.now() / 1000)
    const run = await sh(script, PAYLOAD, { ...base, CLAUDE_CONFIG_DIR: `${fx.home}/claude-profiles/abc-123_x.y/home` })
    assert.equal(run.code, 0, run.stderr)
    const row = readFileSync(liveFile(fx.home, 'abc-123_x.y'), 'utf8')
    assert.match(row, /^1\t\d+\t85\.2\t\d+\t19\.9\t\d+\n$/)
    const [version, stamp, five, fiveReset, seven, sevenReset] = row.trim().split('\t')
    assert.deepEqual([version, five, fiveReset, seven, sevenReset], ['1', '85.2', String(FIVE_RESET), '19.9', String(WEEK_RESET)])
    assert.ok(Number(stamp) >= before && Number(stamp) <= before + 5, 'stamped with the time of writing')
    // The file is numbers only: no path, name or model.
    assert.ok(!row.includes(fx.home) && !/[A-Za-z]/.test(row))

    // Claude's own login: no CLAUDE_CONFIG_DIR, or the default ~/.claude.
    await sh(script, PAYLOAD, base)
    assert.match(readFileSync(liveFile(fx.home, 'system'), 'utf8'), /^1\t\d+\t85\.2\t/)
    rmSync(liveFile(fx.home, 'system'))
    await sh(script, PAYLOAD, { ...base, CLAUDE_CONFIG_DIR: `${fx.home}/.claude` })
    assert.ok(existsSync(liveFile(fx.home, 'system')))

    // Only one window known: the other is "-".
    rmSync(liveFile(fx.home, 'system'))
    const onlyFive = JSON.stringify({ model: { display_name: 'Opus 4.1' }, rate_limits: { five_hour: { used_percentage: 12, resets_at: FIVE_RESET } } })
    await sh(script, onlyFive, base)
    assert.match(readFileSync(liveFile(fx.home, 'system'), 'utf8'), new RegExp(`^1\\t\\d+\\t12\\t${FIVE_RESET}\\t-\\t-\\n$`))
    // No temp file is left behind.
    assert.deepEqual(readdirSync(join(fx.home, '.orca/account-rotator/live')).sort(), ['claude-abc-123_x.y.tsv', 'claude-system.tsv'])
  } finally {
    fx.cleanup()
  }
})

test('wrapper script: no live file for an unknown config dir, a background job, or a payload without limits', async () => {
  const fx = fakeHome()
  try {
    const { existsSync } = await fs()
    const script = join(fx.home, '.orca/account-rotator/claude-statusline.sh')
    const base = { HOME: fx.home, PATH: process.env.PATH ?? '/usr/bin:/bin' }
    const live = join(fx.home, '.orca/account-rotator/live')
    const quiet = async (payload: string, env: Record<string, string>, why: string) => {
      const run = await sh(script, payload, { ...base, ...env })
      assert.equal(run.code, 0, run.stderr)
      assert.ok(plain(run.stdout).startsWith('▶ this pane'), `${why}: the line still prints`)
      assert.equal(existsSync(live), false, why)
    }
    await quiet(PAYLOAD, { CLAUDE_CONFIG_DIR: '/somewhere/else/.claude' }, 'a config dir that is no Orca profile')
    await quiet(PAYLOAD, { CLAUDE_CONFIG_DIR: `${fx.home}/claude-profiles/bad id!/home` }, 'a profile id with other characters')
    await quiet(PAYLOAD, { CLAUDE_CONFIG_DIR: `${fx.home}/claude-profiles/../home` }, 'a profile id that is a path step')
    await quiet(PAYLOAD, { CLAUDE_CONFIG_DIR: `${fx.home}/claude-profiles/bbb` }, 'a profile dir without a home under it')
    await quiet(PAYLOAD, { CLAUDE_CONFIG_DIR: `${fx.home}/claude-profiles/bbb/home`, CLAUDE_JOB_DIR: '/tmp/job' }, 'a background job')
    await quiet(PAYLOAD, { CLAUDE_JOB_DIR: '/tmp/job' }, 'a background job on the system login')
    const noLimits = JSON.stringify({ model: { display_name: 'Opus 4.1' }, context_window: { used_percentage: 40.5 } })
    await quiet(noLimits, { CLAUDE_CONFIG_DIR: `${fx.home}/claude-profiles/bbb/home` }, 'no rate limits in the payload')
    await quiet(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 'lots' }, seven_day: {} } }), {}, 'limits that are not numbers')
  } finally {
    fx.cleanup()
  }
})

test('wrapper script: the jq and the sed path write the same live file', async () => {
  const fx = fakeHome()
  try {
    const { existsSync, readFileSync, symlinkSync } = await fs()
    const script = join(fx.home, '.orca/account-rotator/claude-statusline.sh')
    const bin = join(fx.home, 'bin')
    mkdirSync(bin)
    for (const tool of ['sed', 'tr', 'date', 'cat', 'mkdir', 'mv']) {
      const found = ['/usr/bin', '/bin'].map((d) => join(d, tool)).find((p) => existsSync(p))
      assert.ok(found, `${tool} on this machine`)
      symlinkSync(found!, join(bin, tool))
    }
    const values = (key: string) => readFileSync(liveFile(fx.home, key), 'utf8').trim().split('\t').filter((_, i) => i !== 1)
    const viaSed = await sh(script, PAYLOAD, { HOME: fx.home, PATH: bin, CLAUDE_CONFIG_DIR: `${fx.home}/claude-profiles/sed/home` })
    assert.equal(viaSed.code, 0, viaSed.stderr)
    assert.deepEqual(values('sed'), ['1', '85.2', String(FIVE_RESET), '19.9', String(WEEK_RESET)])
    const hasJq = (process.env.PATH ?? '/usr/bin:/bin').split(':').some((d) => d && existsSync(join(d, 'jq')))
    if (hasJq) {
      await sh(script, PAYLOAD, { HOME: fx.home, PATH: process.env.PATH ?? '/usr/bin:/bin', CLAUDE_CONFIG_DIR: `${fx.home}/claude-profiles/jq/home` })
      assert.deepEqual(values('jq'), values('sed'))
    }
    // The sed path without mkdir and mv on the PATH: no file, and the line is unharmed.
    rmSync(join(fx.home, '.orca/account-rotator/live'), { recursive: true, force: true })
    rmSync(join(bin, 'mkdir'))
    rmSync(join(bin, 'mv'))
    const bare = await sh(script, PAYLOAD, { HOME: fx.home, PATH: bin, CLAUDE_CONFIG_DIR: `${fx.home}/claude-profiles/sed/home` })
    assert.equal(bare.code, 0, bare.stderr)
    assert.equal(bare.stderr, '')
    assert.ok(plain(bare.stdout).includes('5h █░░░░░░░  14%'))
  } finally {
    fx.cleanup()
  }
})

test('wrapper script: a model name that is empty, a glob or holds a tab never shifts or changes the numbers', async () => {
  const fx = fakeHome()
  try {
    const { readFileSync } = await fs()
    const script = join(fx.home, '.orca/account-rotator/claude-statusline.sh')
    // A working directory with files in it, as a pane has: `*` must not become their names.
    const cwd = join(fx.home, 'project')
    mkdirSync(cwd)
    for (const name of ['a', 'b', 'c']) writeFileSync(join(cwd, name), '')
    writeFileSync(join(fx.home, '.orca/account-rotator/status.tsv'), renderStatusFile(snapshot(Date.now()), '{model}|{5h}|{7d}', Date.now()))
    const limits = { five_hour: { used_percentage: 85.2, resets_at: FIVE_RESET }, seven_day: { used_percentage: 19.9, resets_at: WEEK_RESET } }
    const values = (key: string) => readFileSync(liveFile(fx.home, key), 'utf8').trim().split('\t').filter((_, i) => i !== 1)
    const cases: [string, string, string][] = [['star', '*', '*'], ['empty', '', '-'], ['tab', 'Opus\t4.1', 'Opus\t4.1'], ['query', '?', '?']]
    for (const [key, name, shown] of cases) {
      const payload = JSON.stringify({ model: { display_name: name }, context_window: { used_percentage: 40.5 }, rate_limits: limits })
      const run = await sh(script, payload, { HOME: fx.home, PATH: process.env.PATH ?? '/usr/bin:/bin', CLAUDE_CONFIG_DIR: `${fx.home}/claude-profiles/${key}/home` }, cwd)
      assert.equal(run.code, 0, run.stderr)
      assert.deepEqual(values(key), ['1', '85.2', String(FIVE_RESET), '19.9', String(WEEK_RESET)], `model name ${JSON.stringify(name)}`)
      assert.equal(plain(run.stdout).split('\n')[0], `${shown}|14|80`, `model name ${JSON.stringify(name)}`)
    }
    // Only the weekly window known and no model name: the weekly numbers stay the weekly numbers.
    const weekOnly = JSON.stringify({ model: { display_name: '' }, rate_limits: { seven_day: limits.seven_day } })
    await sh(script, weekOnly, { HOME: fx.home, PATH: process.env.PATH ?? '/usr/bin:/bin', CLAUDE_CONFIG_DIR: `${fx.home}/claude-profiles/week/home` }, cwd)
    assert.deepEqual(values('week'), ['1', '-', '-', '19.9', String(WEEK_RESET)])
  } finally {
    fx.cleanup()
  }
})

test('wrapper script: a model name that holds a header placeholder is printed as it is, without looping', async () => {
  const fx = fakeHome()
  try {
    const script = join(fx.home, '.orca/account-rotator/claude-statusline.sh')
    writeFileSync(join(fx.home, '.orca/account-rotator/status.tsv'), renderStatusFile(snapshot(Date.now()), '{model} {5h} {model}', Date.now()))
    const payload = JSON.stringify({ model: { display_name: 'a{model}b' }, rate_limits: { five_hour: { used_percentage: 85.2, resets_at: FIVE_RESET } } })
    const run = await sh(script, payload, { HOME: fx.home, PATH: process.env.PATH ?? '/usr/bin:/bin' })
    assert.equal(run.code, 0, 'the script ends')
    assert.equal(plain(run.stdout).split('\n')[0], 'a{model}b 14 a{model}b')
  } finally {
    fx.cleanup()
  }
})

test('wrapper script: a payload value that is not a plain number is shown as unknown and never evaluated by the shell', async () => {
  const fx = fakeHome()
  try {
    const { existsSync, readdirSync } = await fs()
    const script = join(fx.home, '.orca/account-rotator/claude-statusline.sh')
    writeFileSync(join(fx.home, '.orca/account-rotator/status.tsv'), renderStatusFile(snapshot(Date.now()), '{ctx}|{5h}|{7d}|{reset}', Date.now()))
    const env = { HOME: fx.home, PATH: process.env.PATH ?? '/usr/bin:/bin' }
    const marker = join(fx.home, 'ran')
    // Shell arithmetic expands an array subscript, so a "number" like this would run its command.
    const evil = `x[$(touch ${marker})]`
    const odd: unknown[] = [evil, { a: 1 }, '2026-11-19T10:00:00Z', 'lots', -3, true]
    for (const value of odd) {
      const payload = JSON.stringify({
        model: { display_name: 'Opus 4.1' },
        context_window: { used_percentage: value },
        rate_limits: { five_hour: { used_percentage: value, resets_at: value }, seven_day: { used_percentage: value, resets_at: value } }
      })
      const run = await sh(script, payload, env)
      const what = JSON.stringify(value)
      assert.equal(run.code, 0, what)
      assert.equal(run.stderr, '', what)
      assert.equal(existsSync(marker), false, `${what} ran a command`)
      const lines = plain(run.stdout).split('\n')
      // Unknown, not "100 % left": the header has no numbers and this pane's row keeps the file's.
      assert.equal(lines[0], '-|-|-|now', what)
      assert.ok(lines.includes(`▶ ${pad('system (third)', 14)}  5h ········  n/a  7d ········  n/a  model ········  n/a`), `${what}: ${lines.join(' / ')}`)
      assert.deepEqual(readdirSync(join(fx.home, '.orca/account-rotator')).includes('live'), false, `${what}: no live file`)
    }
  } finally {
    fx.cleanup()
  }
})

test('wrapper script: a status file value that is not a plain number is shown as unknown and never evaluated by the shell', async () => {
  const fx = fakeHome()
  try {
    const { existsSync } = await fs()
    const script = join(fx.home, '.orca/account-rotator/claude-statusline.sh')
    const file = join(fx.home, '.orca/account-rotator/status.tsv')
    const env = { HOME: fx.home, PATH: process.env.PATH ?? '/usr/bin:/bin', CLAUDE_CONFIG_DIR: `${fx.home}/claude-profiles/zzz/home` }
    const marker = join(fx.home, 'ran')
    const evil = `x[$(touch ${marker})]`
    // The worker writes numbers only; the script still reads the file as text anyone may have left.
    for (const column of [5, 6, 7, 8]) {
      const cells = ['seat', 'claude', 'aaa', 'work', '0', '10', '20', '0', '30', 'fable']
      cells[column] = evil
      writeFileSync(file, `${cells.join('\t')}\n`)
      const run = await sh(script, '{}', env)
      assert.equal(run.code, 0, `column ${column}`)
      assert.equal(run.stderr, '', `column ${column}`)
      assert.equal(existsSync(marker), false, `column ${column} ran a command`)
      const row = plain(run.stdout).split('\n').find((l) => l.includes('work'))
      assert.ok(row, `column ${column}: ${run.stdout}`)
      // The odd cell reads as unknown (no cooldown for the cooldown column); the others stay.
      assert.equal((row!.match(/n\/a/g) ?? []).length, column === 7 ? 0 : 1, `column ${column}: ${row}`)
      assert.ok(!row!.includes('\u23f8'), `column ${column}: ${row}`)
    }
  } finally {
    fx.cleanup()
  }
})

test('wrapper script: a live dir that cannot be written still prints the line and feeds Orca\'s hook', async () => {
  const fx = fakeHome()
  try {
    const { existsSync, readFileSync } = await fs()
    const script = join(fx.home, '.orca/account-rotator/claude-statusline.sh')
    // `live` is a file, so neither the directory nor anything in it can be made.
    writeFileSync(join(fx.home, '.orca/account-rotator/live'), 'in the way\n')
    const env = { HOME: fx.home, PATH: process.env.PATH ?? '/usr/bin:/bin', CLAUDE_CONFIG_DIR: `${fx.home}/claude-profiles/bbb/home` }
    const run = await sh(script, PAYLOAD, env)
    assert.equal(run.code, 0, run.stderr)
    assert.equal(run.stderr, '')
    assert.deepEqual(plain(run.stdout).split('\n'), [
      `▶ ${pad('this pane', 9)}  5h █░░░░░░░  14%  7d ██████░░  80%  model ········  n/a  no rotator status yet`,
      ''
    ])
    assert.equal(readFileSync(join(fx.home, '.orca/account-rotator/live'), 'utf8'), 'in the way\n')
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(readFileSync(fx.hookOut, 'utf8'), PAYLOAD)

    // A read-only directory (skipped for root, who can write anywhere).
    rmSync(join(fx.home, '.orca/account-rotator/live'))
    mkdirSync(join(fx.home, '.orca/account-rotator/live'))
    chmodSync(join(fx.home, '.orca/account-rotator/live'), 0o555)
    const locked = await sh(script, PAYLOAD, env)
    assert.equal(locked.code, 0, locked.stderr)
    assert.equal(locked.stderr, '')
    assert.ok(plain(locked.stdout).startsWith('▶ this pane'))
    if (process.env.USER !== 'root') assert.equal(existsSync(liveFile(fx.home, 'bbb')), false)
    chmodSync(join(fx.home, '.orca/account-rotator/live'), 0o755)
  } finally {
    fx.cleanup()
  }
})

test('wrapper script: unchanged numbers are rewritten at most once a minute, changed ones at once', async () => {
  const fx = fakeHome()
  try {
    const { readFileSync } = await fs()
    const script = join(fx.home, '.orca/account-rotator/claude-statusline.sh')
    const env = { HOME: fx.home, PATH: process.env.PATH ?? '/usr/bin:/bin', CLAUDE_CONFIG_DIR: `${fx.home}/claude-profiles/bbb/home` }
    const file = liveFile(fx.home, 'bbb')
    mkdirSync(join(fx.home, '.orca/account-rotator/live'))
    const same = `85.2\t${FIVE_RESET}\t19.9\t${WEEK_RESET}`
    const stampAfter = async (existing: string) => {
      writeFileSync(file, existing)
      const run = await sh(script, PAYLOAD, env)
      assert.equal(run.code, 0, run.stderr)
      return readFileSync(file, 'utf8')
    }
    const t = Math.floor(Date.now() / 1000)
    // Same numbers, written 30 s ago: left alone.
    assert.equal(await stampAfter(`1\t${t - 30}\t${same}\n`), `1\t${t - 30}\t${same}\n`)
    // Same numbers, two minutes old: stamped again.
    const again = await stampAfter(`1\t${t - 120}\t${same}\n`)
    assert.ok(Number(again.split('\t')[1]) >= t, again)
    assert.ok(again.endsWith(`\t${same}\n`))
    // Other numbers, however recent: replaced.
    const changed = await stampAfter(`1\t${t - 5}\t84\t${FIVE_RESET}\t19.9\t${WEEK_RESET}\n`)
    assert.ok(Number(changed.split('\t')[1]) >= t && changed.endsWith(`\t${same}\n`), changed)
    // A stamp from the future, another version, or junk never blocks a write.
    for (const odd of [`1\t${t + 500}\t${same}\n`, `2\t${t - 5}\t${same}\n`, 'junk\n', '']) {
      const fixed = await stampAfter(odd)
      assert.ok(fixed.startsWith('1\t') && Number(fixed.split('\t')[1]) >= t && Number(fixed.split('\t')[1]) <= t + 5 && fixed.endsWith(`\t${same}\n`), JSON.stringify([odd, fixed]))
    }
    // Two runs in a row: the second leaves the first's file as it is.
    const first = await stampAfter('')
    await new Promise((r) => setTimeout(r, 1100))
    await sh(script, PAYLOAD, env)
    assert.equal(readFileSync(file, 'utf8'), first)
  } finally {
    fx.cleanup()
  }
})

test('worker: install and uninstall edit the focused workspace, the status file follows the snapshot', async () => {
  const files = memoryFiles('/home/u')
  const host = mockHost({
    settings: { console_statusline_format: '{model} {reset}', console_statusline_bar_width: 12 },
    results: {
      'agents.list': { agents: [] },
      'workspace.list': { workspaces: [{ id: 'w1', kind: 'worktree', name: 'app', path: '/repo', branch: 'main', hostId: 'local' }], truncated: false },
      'workspace.readContext': { workspaceId: 'w1', branch: 'main', displayName: 'app', terminals: [] },
      'statusBar.update': { ok: true }
    }
  })
  const mod = {
    default: async (orca: OrcaWorkerApi) => {
      await activateWith(
        orca,
        {
          cli: {
            listAccounts: async () => ({ claude: { accounts: [{ id: 'aaa', email: 'me@example.com' }, { id: 'bbb', email: 'other@example.com' }], activeAccountId: 'aaa' }, rateLimits: {} }),
            select: async () => undefined,
            closeTerminal: async () => undefined,
            sendText: async () => undefined,
            git: async () => '', draft: async () => ''
          },
          now: () => NOW,
          sleep: async () => undefined
        },
        { tick: false, files }
      )
    }
  }
  const worker = await mountWorker(mod, { host })
  try {
    await worker.command('rotator.refresh')
    const status = files.files.get('/home/u/.orca/account-rotator/status.tsv')
    assert.ok(status, 'status file written on publish')
    assert.ok(status!.includes('format\t{model} {reset}'))
    assert.ok(status!.includes('width\t12'))
    assert.ok(status!.includes('seat\tclaude\taaa\tme\t1\t'))
    assert.ok(status!.includes('seat\tclaude\tbbb\tother\t0\t'))
    assert.equal(files.files.get('/home/u/.orca/account-rotator/claude-statusline.sh'), SCRIPT)
    assert.equal(files.modes.get('/home/u/.orca/account-rotator/claude-statusline.sh'), 0o755)

    files.files.set('/repo/.claude/settings.local.json', '{"permissions":{"allow":["Bash(ls)"]}}\n')
    assert.deepEqual(await worker.request('rotator.consoleLine', {}), { installed: false, workspace: 'app' })
    const start = worker.posts.length
    const pushed = () => worker.posts.slice(start).filter((p) => p.event === 'rotator.consoleLine').map((p) => p.payload)
    const installed = await worker.command('rotator.installStatusLine')
    assert.match(String(installed), /installed for app/)
    // An open panel is told at once: its Status line switch never shows the state before the command.
    assert.deepEqual(pushed(), [{ installed: true, workspace: 'app' }])
    const local = JSON.parse(files.files.get('/repo/.claude/settings.local.json')!)
    assert.equal(local.statusLine.command, STATUSLINE_COMMAND)
    assert.deepEqual(local.permissions, { allow: ['Bash(ls)'] })

    assert.deepEqual(await worker.request('rotator.consoleLine', {}), { installed: true, workspace: 'app' })
    const removed = await worker.command('rotator.uninstallStatusLine')
    assert.match(String(removed), /removed from app/)
    assert.deepEqual(pushed().at(-1), { installed: false, workspace: 'app' })
    assert.equal(pushed().length, 2)
    assert.deepEqual(JSON.parse(files.files.get('/repo/.claude/settings.local.json')!), { permissions: { allow: ['Bash(ls)'] } })
    assert.match(String(await worker.command('rotator.uninstallStatusLine')), /not installed/)
    // The panel switch goes through the same install and remove.
    const on = await worker.request('rotator.consoleLine', { enabled: true })
    assert.equal(on.installed, true)
    assert.match(on.message ?? '', /installed for app/)
    const off = await worker.request('rotator.consoleLine', { enabled: false })
    assert.equal(off.installed, false)
    assert.match(off.message ?? '', /removed from app/)

    // Only ours in the file → the file goes away.
    files.files.delete('/repo/.claude/settings.local.json')
    await worker.command('rotator.installStatusLine')
    await worker.command('rotator.uninstallStatusLine')
    assert.equal(files.files.has('/repo/.claude/settings.local.json'), false)
  } finally {
    await worker.deactivate()
  }
})

test('worker: when the focused workspace changes, the panel is told the status line state of the new one', async () => {
  const files = memoryFiles('/home/u')
  let focused: string | null = 'w1'
  const host = mockHost({
    results: {
      'agents.list': { agents: [] },
      'workspace.list': {
        workspaces: [
          { id: 'w1', kind: 'worktree', name: 'app', path: '/repo', branch: 'main', hostId: 'local' },
          { id: 'w2', kind: 'worktree', name: 'docs', path: '/docs', branch: 'main', hostId: 'local' },
          { id: 'w3', kind: 'worktree', name: 'far', path: '/srv/far', branch: 'main', hostId: 'ssh:build-box' }
        ],
        truncated: false
      },
      'workspace.readContext': () => (focused ? { workspaceId: focused, branch: 'main', displayName: focused, terminals: [] } : null),
      'statusBar.update': { ok: true }
    }
  })
  const mod = {
    default: async (orca: OrcaWorkerApi) => {
      await activateWith(
        orca,
        {
          cli: { listAccounts: async () => ({ claude: { accounts: [{ id: 'aaa', email: 'me@example.com' }], activeAccountId: 'aaa' }, rateLimits: {} }), select: async () => undefined, closeTerminal: async () => undefined, sendText: async () => undefined, git: async () => '', draft: async () => '' },
          now: () => NOW,
          sleep: async () => undefined
        },
        { tick: false, files }
      )
    }
  }
  const worker = await mountWorker(mod, { host })
  try {
    await worker.command('rotator.installStatusLine')
    const told = () => worker.posts.filter((p) => p.event === 'rotator.consoleLine').map((p) => p.payload)
    const move = async (to: string | null) => {
      focused = to
      await worker.emit('workspace.changed', { context: to ? { workspaceId: to, branch: 'main', displayName: to, terminals: [] } : null })
    }
    const before = told().length
    await move('w2')
    assert.deepEqual(told().at(-1), { installed: false, workspace: 'docs' })
    await move('w1')
    assert.deepEqual(told().at(-1), { installed: true, workspace: 'app' })
    // Where it cannot be installed, the reason goes with it.
    await move('w3')
    assert.deepEqual(told().at(-1), { installed: false, reason: 'The focused workspace is not on this computer' })
    await move(null)
    assert.deepEqual(told().at(-1), { installed: false, reason: 'No focused workspace' })
    // Once per change.
    assert.equal(told().length, before + 4)
  } finally {
    await worker.deactivate()
  }
})

test('worker: the console status line is not installed for a workspace on another machine', async () => {
  const mount = async (workspace: Record<string, unknown>, projects?: Record<string, unknown>[]) => {
    const files = memoryFiles('/home/u')
    const host = mockHost({
      results: {
        'agents.list': { agents: [] },
        'workspace.list': { workspaces: [{ id: 'w1', kind: 'worktree', name: 'app', path: '/home/me/repo', branch: 'main', ...workspace }], truncated: false },
        ...(projects ? { 'project.list': { projects, truncated: false } } : {}),
        'workspace.readContext': { workspaceId: 'w1', branch: 'main', displayName: 'app', terminals: [] },
        'statusBar.update': { ok: true }
      }
    })
    const mod = {
      default: async (orca: OrcaWorkerApi) => {
        await activateWith(
          orca,
          {
            cli: { listAccounts: async () => ({ claude: { accounts: [{ id: 'aaa', email: 'me@example.com' }], activeAccountId: 'aaa' }, rateLimits: {} }), select: async () => undefined, closeTerminal: async () => undefined, sendText: async () => undefined, git: async () => '', draft: async () => '' },
            now: () => NOW,
            sleep: async () => undefined
          },
          { tick: false, files }
        )
      }
    }
    return { files, worker: await mountWorker(mod, { host }) }
  }
  const settings = '/home/me/repo/.claude/settings.local.json'
  const remote: [Record<string, unknown>, Record<string, unknown>[] | undefined][] = [
    [{ hostId: 'ssh:build-box' }, undefined],
    [{ hostId: 'runtime:remote-box' }, undefined],
    // The row names no host: its project does.
    [{ hostId: null, projectId: 'p1' }, [{ id: 'p1', name: 'app', kind: 'git', hostId: 'ssh:build-box', path: '/home/me/repo' }]]
  ]
  for (const [workspace, projects] of remote) {
    const m = await mount(workspace, projects)
    try {
      // A local file at the same path belongs to another project: it is neither read nor changed.
      m.files.files.set(settings, '{"permissions":{}}\n')
      assert.match(String(await m.worker.command('rotator.installStatusLine')), /not on this computer/)
      assert.equal(m.files.files.get(settings), '{"permissions":{}}\n')
      m.files.files.set(settings, installIntoSettings(null).text)
      assert.match(String(await m.worker.command('rotator.uninstallStatusLine')), /not on this computer/)
      assert.ok(m.files.files.has(settings))
      const state = await m.worker.request('rotator.consoleLine', {})
      assert.equal(state.installed, false)
      assert.match(state.reason ?? '', /not on this computer/)
    } finally {
      await m.worker.deactivate()
    }
  }
  // A row without a host whose project is on this computer (or cannot be looked up) is local.
  for (const projects of [[{ id: 'p1', name: 'app', kind: 'git', hostId: 'local', path: '/home/me/repo' }], undefined]) {
    const m = await mount({ hostId: null, projectId: 'p1' }, projects)
    try {
      assert.match(String(await m.worker.command('rotator.installStatusLine')), /installed for app/)
      assert.ok(m.files.files.has(settings))
    } finally {
      await m.worker.deactivate()
    }
  }
})

// The status file and the live files carry account names (emails): only their owner reads them.
const modeOf = (path: string) => statSync(path).mode & 0o777

test('private files: the worker writes status.tsv as 0600 in a 0700 folder, also when both existed with wider modes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rotator-modes-'))
  try {
    const dir = join(home, '.orca/account-rotator')
    // As an earlier version left them.
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    chmodSync(dir, 0o755)
    writeFileSync(join(dir, 'status.tsv'), 'old\n', { mode: 0o644 })
    chmodSync(join(dir, 'status.tsv'), 0o644)
    const line = new ConsoleStatusLine({ ...nodeFiles(), home }, { host: { call: async () => ({}) }, settings: async () => ({}), log: () => undefined, now: () => NOW })
    await line.writeStatus(snapshot())
    assert.equal(modeOf(join(dir, 'status.tsv')), 0o600)
    assert.equal(modeOf(dir), 0o700)
    assert.equal(modeOf(join(dir, 'claude-statusline.sh')), 0o755)
    // A workspace's settings file is not the plugin's to lock down.
    const repo = join(home, 'repo/.claude')
    nodeFiles().write(join(repo, 'settings.local.json'), '{}\n')
    assert.equal(modeOf(join(repo, 'settings.local.json')), 0o644)
    assert.equal(modeOf(repo) & 0o700, 0o700)
    assert.notEqual(modeOf(repo), 0o700)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  // The same through the stand-in the worker tests use.
  const files = memoryFiles('/home/u')
  const line = new ConsoleStatusLine(files, { host: { call: async () => ({}) }, settings: async () => ({}), log: () => undefined, now: () => NOW })
  await line.writeStatus(snapshot())
  assert.equal(files.modes.get('/home/u/.orca/account-rotator/status.tsv'), 0o600)
  assert.equal(files.modes.get('/home/u/.orca/account-rotator'), 0o700)
})

test('private files: the wrapper script writes a live file as 0600 and makes its folder 0700', async () => {
  const fx = fakeHome()
  try {
    const script = join(fx.home, '.orca/account-rotator/claude-statusline.sh')
    const env = { HOME: fx.home, PATH: process.env.PATH ?? '/usr/bin:/bin', CLAUDE_CONFIG_DIR: `${fx.home}/claude-profiles/bbb/home` }
    const run = await sh(script, PAYLOAD, env)
    assert.equal(run.code, 0, run.stderr)
    assert.equal(modeOf(liveFile(fx.home, 'bbb')), 0o600)
    assert.equal(modeOf(join(fx.home, '.orca/account-rotator/live')), 0o700)
  } finally {
    fx.cleanup()
  }
})
