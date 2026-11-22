// Console status line for Claude Code panes. Orca points Claude's `statusLine` at its own hook,
// which forwards usage to Orca's status bar and prints nothing, so a Claude pane in Orca shows no
// status line. The plugin installs a wrapper in a workspace's `.claude/settings.local.json` (project
// settings win over the user settings Orca writes) that still forwards the payload to Orca's hook
// and then prints one line: the model, context use, and every account of the pane's service with
// the one this pane runs on marked.
//
// The worker writes `~/.orca/account-rotator/status.tsv` whenever the snapshot changes; the script
// reads it, so the line needs no CLI call and stays under Claude's status line budget.
import { displayLabels, seatOrder } from './labels.ts'
import type { Snapshot } from './types.ts'

export { displayLabels }

export const DATA_DIR = '.orca/account-rotator'
export const SCRIPT_NAME = 'claude-statusline.sh'
export const STATUS_NAME = 'status.tsv'
/** Where the wrapper leaves each account's latest numbers: `live/claude-<key>.tsv` (live-usage.ts). */
export const LIVE_DIR = 'live'
/** What `.claude/settings.local.json` runs; `$HOME` stays literal so the file is portable. */
export const STATUSLINE_COMMAND = `/bin/sh "$HOME/${DATA_DIR}/${SCRIPT_NAME}"`
/** Claude Code `StopFailure` hook command: instantly notifies `oahd` on rate limits. */
export const STOP_FAILURE_HOOK_COMMAND = '"$HOME/.orca/oah/bin/oah" event stop-failure'
/** The optional header line; empty = account rows only. */
export const DEFAULT_FORMAT = ''
/** Seconds between Claude's re-runs of the status line besides its own events, so a pane that
 *  sits idle still picks up the numbers the panel shows (Claude Code 2.1+; older ones ignore it). */
export const REFRESH_SECONDS = 10
/** The `statusLine` value the plugin installs. */
export const WRAPPER_SETTING = { type: 'command', command: STATUSLINE_COMMAND, padding: 0, refreshInterval: REFRESH_SECONDS }

/** One shell word that is `text` exactly. */
const shellWord = (text: string) => `'${text.split("'").join("'\\''")}'`

/** The earlier status line's command, when it was a command. */
function commandOf(value: unknown): string | undefined {
  const command = value && typeof value === 'object' ? (value as SettingsJson).command : undefined
  return typeof command === 'string' && command.trim() ? command : undefined
}

/** The wrapper, running `previous` (the workspace's earlier status line) first, above its rows. */
export function wrapperSetting(previous?: unknown) {
  const command = commandOf(previous)
  return { ...WRAPPER_SETTING, command: command ? `${STATUSLINE_COMMAND} ${shellWord(command)}` : STATUSLINE_COMMAND }
}
/** Key under which an earlier `statusLine` is kept so uninstall can put it back. */
const PREVIOUS_KEY = 'accountRotatorPreviousStatusLine'

/** One cell of the status file: no tab or line break (they would start another cell or row), and
 *  no other control character (the script prints names to the terminal as they are, so an escape
 *  sequence in an account's name would be run by it). */
const clean = (s: unknown) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()
const pct = (n: number | undefined) => (typeof n === 'number' ? String(Math.round(n)) : '-')

export const DEFAULT_BAR_WIDTH = 8

/** The tab-separated file the script reads. One `seat` row per account, every provider, in the
 *  order the panel lists them (`seatOrder`), so the line and the panel agree. */

export function renderStatusFile(snapshot: Snapshot, format: string, now: number, barWidth = DEFAULT_BAR_WIDTH, dirs: [string, string][] = []): string {
  const width = Number.isInteger(barWidth) && barWidth >= 1 && barWidth <= 99 ? barWidth : DEFAULT_BAR_WIDTH
  const lines = [
    '# Auto Hand-off (Orca plugin) — read by claude-statusline.sh; rewritten on every change',
    `format\t${clean(format)}`,
    `width\t${width}`,
    `paused\t${snapshot.paused ? 1 : 0}`
  ]
  const providers = [...new Set(snapshot.seats.map((s) => s.provider))]
  for (const provider of providers) {
    const labels = displayLabels(snapshot.seats, provider)
    for (const seat of snapshot.seats.filter((s) => s.provider === provider).sort(seatOrder(now))) {
      const cooldown = seat.cooldownUntil && seat.cooldownUntil > now ? Math.ceil(seat.cooldownUntil / 1000) : 0
      lines.push(
        [
          'seat',
          seat.provider,
          clean(seat.accountId),
          clean(labels.get(seat.key) ?? seat.label),
          seat.active ? 1 : 0,
          // An account Orca has no fresh numbers for (it has not run yet) is unknown, not 0 % used.
          pct(seat.usage.known ? seat.usage.session?.usedPercent : undefined),
          pct(seat.usage.known ? seat.usage.weekly?.usedPercent : undefined),
          cooldown,
          pct(seat.usage.known ? seat.usage.model?.usedPercent : undefined),
          clean(seat.usage.model?.name ?? '-') || '-'
        ].join('\t')
      )
    }
  }
  // Claude config folders that are not an Orca profile, and the account each one signs in as.
  for (const [path, id] of dirs) lines.push(['dir', clean(path), clean(id)].join('\t'))
  return lines.join('\n') + '\n'
}

type SettingsJson = Record<string, unknown>

function parseSettings(text: string | null): SettingsJson {
  if (!text || !text.trim()) return {}
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('settings.local.json is not a JSON object')
  }
  return parsed as SettingsJson
}

/** Whether a `statusLine` setting is the plugin's wrapper. */
export const isOurs = (value: unknown) =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as SettingsJson).command === 'string' &&
  ((value as SettingsJson).command as string).includes(`/${DATA_DIR}/${SCRIPT_NAME}`)

/** Whether `.claude/settings.local.json` text has the wrapper installed. */
export function isInstalledIn(text: string | null): boolean {
  try {
    return isOurs(parseSettings(text).statusLine)
  } catch {
    return false
  }
}

/** `.claude/settings.local.json` with the wrapper as `statusLine`. An earlier status line keeps
 *  running, above the wrapper's rows, and is kept aside so uninstall puts it back. */
export function installIntoSettings(text: string | null): { text: string; replaced: boolean } {
  const settings = parseSettings(text)
  const previous = settings.statusLine
  const replaced = previous !== undefined && !isOurs(previous)
  if (replaced) settings[PREVIOUS_KEY] = previous
  settings.statusLine = wrapperSetting(settings[PREVIOUS_KEY])
  return { text: JSON.stringify(settings, null, 2) + '\n', replaced }
}

/** Whether an installed wrapper setting is older than this version's: it has no refresh interval,
 *  or does not run the workspace's earlier status line kept aside. Otherwise (whatever else the
 *  user changed in it since) it is left as it is. */
export function needsUpgrade(text: string | null): boolean {
  try {
    const settings = parseSettings(text)
    const current = settings.statusLine
    if (!isOurs(current)) return false
    if ((current as SettingsJson).refreshInterval === undefined) return true
    return (current as SettingsJson).command !== wrapperSetting(settings[PREVIOUS_KEY]).command
  } catch {
    return false
  }
}

/** Whether `.claude/settings.local.json` has OAH's `StopFailure` hook installed. */
export function isStopFailureHookInstalledIn(text: string | null): boolean {
  try {
    const hooks = parseSettings(text).hooks as Record<string, unknown> | undefined
    const list = Array.isArray(hooks?.StopFailure) ? hooks.StopFailure : []
    return list.some((entry: any) =>
      Array.isArray(entry?.hooks) && entry.hooks.some((h: any) => typeof h?.command === 'string' && h.command.includes('oah') && h.command.includes('stop-failure'))
    )
  } catch {
    return false
  }
}

/** Installs OAH's `StopFailure` hook into `.claude/settings.local.json` without clobbering user hooks. */
export function installStopFailureHook(text: string | null): { text: string; added: boolean } {
  const settings = parseSettings(text)
  if (isStopFailureHookInstalledIn(text)) return { text: JSON.stringify(settings, null, 2) + '\n', added: false }
  const hooks = (settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? { ...(settings.hooks as Record<string, unknown>) } : {}) as Record<string, unknown>
  const existing = Array.isArray(hooks.StopFailure) ? [...hooks.StopFailure] : []
  existing.push({ hooks: [{ type: 'command', command: STOP_FAILURE_HOOK_COMMAND }] })
  hooks.StopFailure = existing
  settings.hooks = hooks
  return { text: JSON.stringify(settings, null, 2) + '\n', added: true }
}

/** Removes OAH's `StopFailure` hook from `.claude/settings.local.json`, leaving user hooks intact. */
export function uninstallStopFailureHook(text: string | null): { text: string | null; removed: boolean } {
  if (!text) return { text: null, removed: false }
  const settings = parseSettings(text)
  const hooks = settings.hooks as Record<string, unknown> | undefined
  if (!hooks || !Array.isArray(hooks.StopFailure)) return { text, removed: false }
  const filtered = hooks.StopFailure.filter(
    (entry: any) => !(Array.isArray(entry?.hooks) && entry.hooks.some((h: any) => typeof h?.command === 'string' && h.command.includes('oah') && h.command.includes('stop-failure')))
  )
  if (filtered.length === hooks.StopFailure.length) return { text, removed: false }
  if (filtered.length === 0) delete hooks.StopFailure
  else hooks.StopFailure = filtered
  if (Object.keys(hooks).length === 0) delete settings.hooks
  return { text: Object.keys(settings).length === 0 ? null : JSON.stringify(settings, null, 2) + '\n', removed: true }
}

/** Removes the wrapper and restores what was there; `null` text means the file can be deleted. */
export function uninstallFromSettings(text: string | null): { text: string | null; changed: boolean } {
  const settings = parseSettings(text)
  if (!isOurs(settings.statusLine)) return { text, changed: false }
  if (settings[PREVIOUS_KEY] !== undefined) {
    settings.statusLine = settings[PREVIOUS_KEY]
    delete settings[PREVIOUS_KEY]
  } else {
    delete settings.statusLine
  }
  if (Object.keys(settings).length === 0) return { text: null, changed: true }
  return { text: JSON.stringify(settings, null, 2) + '\n', changed: true }
}

/**
 * The wrapper itself, POSIX sh. Claude Code pipes its status JSON on stdin and prints the first
 * line of stdout; ANSI colors are allowed. It must return fast: Orca's hook (curl, ≤1.5 s) runs
 * in the background with its output closed, jq is used when present (macOS 15+ ships it) and a
 * sed fallback covers the rest.
 *
 * Shell `${…}` is written `@{…}` here, because a template literal would read it as JavaScript;
 * `SCRIPT` has the real thing. `String.raw` keeps the backslashes sed and printf need.
 */
const RAW = String.raw`#!/bin/sh
# Auto Hand-off (Orca plugin): Claude Code status line wrapper.
# Written by the plugin; edits are overwritten. Format and accounts come from status.tsv next to it.
payload=$(cat)
[ -n "$payload" ] || exit 0
dir="@{HOME:-}/${DATA_DIR}"
status="$dir/status.tsv"
orca_hook="@{HOME:-}/.orca/agent-hooks/claude-statusline.sh"

# Keep Orca's status bar fed: its hook posts the payload to Orca and prints nothing.
if [ -x "$orca_hook" ]; then
  printf '%s' "$payload" | /bin/sh "$orca_hook" >/dev/null 2>&1 &
fi

# The status line that was set before ours keeps running, and prints above our rows: the
# workspace's own (the plugin passes its command as $1 when it installs the wrapper), else the
# user's, in the settings.json of the config dir this pane runs on (the workspace's wrapper hides
# it from Claude). Orca's hook (fed above, prints nothing) and this wrapper are never run here.
prev=@{1:-}
if [ -z "$prev" ] && command -v jq >/dev/null 2>&1; then
  user_settings="@{CLAUDE_CONFIG_DIR:-@{HOME:-}/.claude}"
  user_settings="@{user_settings%/}/settings.json"
  [ -r "$user_settings" ] && prev=$(jq -r '.statusLine.command // empty' "$user_settings" 2>/dev/null)
fi
case "$prev" in *agent-hooks/claude-statusline*|*"/${DATA_DIR}/${SCRIPT_NAME}"*) prev= ;; esac
prev_out=
[ -n "$prev" ] && prev_out=$(printf '%s' "$payload" | /bin/sh -c "$prev" 2>/dev/null)

tab=$(printf '\t')
model=- ctx=- five=- seven=- reset=- wreset=-
if command -v jq >/dev/null 2>&1; then
  # The model name goes last: it is the one field Claude does not make from numbers, and whatever
  # it holds (nothing, a tab, a "*") must not shift or expand the fields before it.
  fields=$(printf '%s' "$payload" | jq -r '[
      (.context_window.used_percentage // (
        if (.context_window.context_window_size // 0) > 0 and .context_window.current_usage then
          ((.context_window.current_usage.input_tokens // 0) + (.context_window.current_usage.cache_creation_input_tokens // 0) + (.context_window.current_usage.cache_read_input_tokens // 0)) * 100 / .context_window.context_window_size
        else "-" end)),
      (.rate_limits.five_hour.used_percentage // "-"),
      (.rate_limits.seven_day.used_percentage // "-"),
      (.rate_limits.five_hour.resets_at // "-"),
      (.rate_limits.seven_day.resets_at // "-"),
      (.model.display_name // "-")
    ] | map(tostring) | join("\t")' 2>/dev/null)
  if [ -n "$fields" ]; then
    IFS="$tab" read -r ctx five seven reset wreset model <<EOF
$fields
EOF
    model=@{model:-"-"}; ctx=@{ctx:-"-"}; five=@{five:-"-"}; seven=@{seven:-"-"}; reset=@{reset:-"-"}; wreset=@{wreset:-"-"}
  fi
else
  flat=$(printf '%s' "$payload" | tr -d '\n')
  model=$(printf '%s' "$flat" | sed -n 's/.*"display_name":"\([^"]*\)".*/\1/p'); model=@{model:-"-"}
  five=$(printf '%s' "$flat" | sed -n 's/.*"five_hour":{[^}]*"used_percentage":\([0-9.]*\).*/\1/p'); five=@{five:-"-"}
  seven=$(printf '%s' "$flat" | sed -n 's/.*"seven_day":{[^}]*"used_percentage":\([0-9.]*\).*/\1/p'); seven=@{seven:-"-"}
  reset=$(printf '%s' "$flat" | sed -n 's/.*"five_hour":{[^}]*"resets_at":\([0-9]*\).*/\1/p'); reset=@{reset:-"-"}
  wreset=$(printf '%s' "$flat" | sed -n 's/.*"seven_day":{[^}]*"resets_at":\([0-9]*\).*/\1/p'); wreset=@{wreset:-"-"}
  cw=@{flat#*\"context_window\":\{}
  if [ "$cw" != "$flat" ]; then
    size=$(printf '%s' "$cw" | sed -n 's/.*"context_window_size":\([0-9]*\).*/\1/p')
    cu=@{cw#*\"current_usage\":\{}
    if [ -n "$size" ] && [ "$size" -gt 0 ] 2>/dev/null && [ "$cu" != "$cw" ]; then
      a=$(printf '%s' "$cu" | sed -n 's/^[^}]*"input_tokens":\([0-9]*\).*/\1/p')
      b=$(printf '%s' "$cu" | sed -n 's/^[^}]*"cache_creation_input_tokens":\([0-9]*\).*/\1/p')
      c=$(printf '%s' "$cu" | sed -n 's/^[^}]*"cache_read_input_tokens":\([0-9]*\).*/\1/p')
      ctx=$(( (@{a:-0} + @{b:-0} + @{c:-0}) * 100 / size ))
    fi
  fi
fi
# Only plain numbers go on. These values are used in shell arithmetic below, and arithmetic would
# run a command hidden in any other text (an array subscript is expanded): the rest is unknown.
case "$ctx" in ''|.*|*[!0-9.]*|*.*.*) ctx=- ;; esac
case "$five" in ''|.*|*[!0-9.]*|*.*.*) five=- ;; esac
case "$seven" in ''|.*|*[!0-9.]*|*.*.*) seven=- ;; esac
case "$reset" in ''|.*|*[!0-9.]*|*.*.*) reset=- ;; esac
case "$wreset" in ''|.*|*[!0-9.]*|*.*.*) wreset=- ;; esac

now=$(date +%s 2>/dev/null || printf '%s' 0)

# Leave this pane's own numbers for the plugin: Orca polls only the selected account, so this is
# how an account that runs in a pane but is not selected stays known. One line, per account:
#   1 <tab> written (epoch s) <tab> 5h used % <tab> 5h reset (epoch s) <tab> 7d used % <tab> 7d reset
# The account is the one this pane runs on (below). Background jobs do not write.
# Nothing here may fail the line: it runs in a subshell with errors dropped.
#
# Which account this pane runs on: Orca sets CLAUDE_CONFIG_DIR to the profile's home, and an empty
# one or ~/.claude is Claude's own login ("system"). Any other config dir (a launcher such as
# ClaudeBar sets its own) is looked up in the status file's "dir" rows, which the plugin fills by
# matching that folder's sign-in to an Orca account. Until it has, the folder is noted for it in
# live/dirs/ (its path only, once) and no account is marked.
me=
case "@{CLAUDE_CONFIG_DIR:-}" in
  ''|"@{HOME:-}/.claude"|"@{HOME:-}/.claude/") me=system ;;
  */claude-profiles/*/*) me=@{CLAUDE_CONFIG_DIR##*/claude-profiles/}; me=@{me%%/*} ;;
  *)
    if [ -r "$status" ]; then
      while IFS="$tab" read -r kind path id rest; do
        if [ "$kind" = dir ] && [ "$path" = "$CLAUDE_CONFIG_DIR" ]; then me=$id; break; fi
      done <"$status"
    fi
    if [ -z "$me" ] && [ -n "@{HOME:-}" ]; then
      (
        key=$(printf '%s' "$CLAUDE_CONFIG_DIR" | cksum | cut -d' ' -f1)
        seen="$dir/${LIVE_DIR}/dirs"
        [ -n "$key" ] && [ ! -e "$seen/$key" ] || exit 0
        umask 077
        mkdir -p "$seen" && printf '%s\n' "$CLAUDE_CONFIG_DIR" >"$seen/$key"
      ) 2>/dev/null || :
    fi ;;
esac
case "$me" in ''|.|..|*[!A-Za-z0-9._-]*) me= ;; esac
live_key=$me
# A plain number, or "-".
num_of() { case "$1" in ''|.|*[!0-9.]*|*.*.*) printf '%s' '-' ;; *) printf '%s' "$1" ;; esac; }
if [ -n "$live_key" ] && [ -n "@{HOME:-}" ] && [ -z "@{CLAUDE_JOB_DIR:-}" ] && [ "$now" -gt 0 ] 2>/dev/null; then
  (
    row="$(num_of "$five")$tab$(num_of "$reset")$tab$(num_of "$seven")$tab$(num_of "$wreset")"
    case "$row" in -"$tab"*"$tab"-"$tab"*) exit 0 ;; esac
    live="$dir/${LIVE_DIR}"
    file="$live/claude-$live_key.tsv"
    # Unchanged numbers are rewritten at most once a minute.
    if [ -r "$file" ]; then
      IFS="$tab" read -r v at a b c d <"$file" || :
      if [ "$v" = 1 ] && [ "$a$tab$b$tab$c$tab$d" = "$row" ]; then
        case "$at" in ''|*[!0-9]*) ;; *) [ $((now - at)) -ge 0 ] && [ $((now - at)) -lt 60 ] && exit 0 ;; esac
      fi
    fi
    # The file names nothing but numbers, yet its name is the account's profile: owner only.
    umask 077
    [ -d "$live" ] || mkdir -p "$live" || exit 0
    tmp="$file.$$"
    printf '1\t%s\t%s\n' "$now" "$row" >"$tmp" && mv -f "$tmp" "$file"
  ) 2>/dev/null || :
fi

# Percent left from percent used, clamped to 0..100.
left_of() {
  case "$1" in ''|-|null) printf '%s' '-'; return ;; esac
  l=$(( 100 - @{1%%.*} ))
  # 19.9 % used is 80.1 % left: floor, not 81.
  case "$1" in *.*) case "@{1#*.}" in *[1-9]*) l=$((l - 1)) ;; esac ;; esac
  [ "$l" -lt 0 ] && l=0
  [ "$l" -gt 100 ] && l=100
  printf '%s' "$l"
}
five=$(left_of "$five"); seven=$(left_of "$seven")
ctx=$(left_of "$ctx")

# "1h20m" until an epoch second, or "" when past or unknown.
until_text() {
  case "$1" in ''|-|null|0) return ;; esac
  left=$(( @{1%%.*} - now ))
  [ "$left" -gt 0 ] || return
  if [ "$left" -ge 3600 ]; then printf '%dh%02dm' $((left / 3600)) $((left % 3600 / 60))
  elif [ "$left" -ge 60 ]; then printf '%dm' $((left / 60))
  else printf '%ds' "$left"; fi
}
reset_text=$(until_text "$reset")

esc=$(printf '\033')
dim="@{esc}[2m"; good="@{esc}[32m"; warn="@{esc}[33m"; bad="@{esc}[31m"; worst="@{esc}[1;31m"; bold="@{esc}[1m"; alert="@{esc}[1;33m"; off="@{esc}[0m"
width=8
repeat() { i=0; while [ "$i" -lt "$2" ]; do printf '%s' "$1"; i=$((i + 1)); done; }
# A gauge of what is left: green above 50, yellow 21-50, red at 20 or less, bold red at 0; the
# number after it, 4 wide; "·" cells and n/a when unknown. Never empty while anything is left.
bar() {
  case "$1" in ''|-)
    printf '%s' "@{dim}$(repeat '·' "$width")@{off}  n/a"
    return ;;
  esac
  filled=$(( ($1 * width + 50) / 100 ))
  [ "$1" -gt 0 ] && [ "$filled" -lt 1 ] && filled=1
  color=$good
  [ "$1" -le 50 ] && color=$warn
  [ "$1" -le 20 ] && color=$bad
  [ "$1" -le 0 ] && color=$worst
  printf '%s' "@{color}$(repeat '█' "$filled")@{off}@{dim}$(repeat '░' $((width - filled)))@{off} @{color}$(printf '%3d' "$1")%@{off}"
}
# Label column: the widest account name, at most 15; a longer one keeps its first 14 and an
# ellipsis, so the start of the local part (what tells accounts apart) stays.
labelmax=15
labelw=1
label() {
  if [ "@{#1}" -gt "$labelmax" ]; then printf '%.14s…' "$1"; else printf '%-*s' "$labelw" "$1"; fi
}

format='${DEFAULT_FORMAT}'
paused=0
best=?
namew=5
# The model-window column only when some account has one; otherwise it would be "n/a" on every row.
hasmodel=
rows=
if [ -r "$status" ]; then
  # Column widths: the widest account name (20..40) and the widest model-window name (fable,
  # opus, ...), so every row lines up.
  while IFS="$tab" read -r kind provider id short active s w cool m mname; do
    [ "$kind" = seat ] && [ "$provider" = claude ] || continue
    { [ "$mname" != - ] || [ "$m" != - ]; } && hasmodel=1
    [ "$mname" != - ] && [ "@{#mname}" -gt "$namew" ] && namew=@{#mname}
    [ "@{#short}" -gt "$labelw" ] && labelw=@{#short}
  done <"$status"
  [ "$labelw" -gt "$labelmax" ] && labelw=$labelmax
  while IFS="$tab" read -r kind provider id short active s w cool m mname; do
    case "$kind" in
      format) format=$provider; continue ;;
      width) case "$provider" in [1-9]|[1-9][0-9]) width=$provider ;; esac; continue ;;
      paused) paused=$provider; continue ;;
      seat) ;;
      *) continue ;;
    esac
    [ "$provider" = claude ] || continue
    # As for the payload: only plain numbers reach the arithmetic below.
    case "$s" in ''|.*|*[!0-9.]*|*.*.*) s=- ;; esac
    case "$w" in ''|.*|*[!0-9.]*|*.*.*) w=- ;; esac
    case "$m" in ''|.*|*[!0-9.]*|*.*.*) m=- ;; esac
    case "$cool" in ''|.*|*[!0-9.]*|*.*.*) cool=- ;; esac
    s=$(left_of "$s"); w=$(left_of "$w"); m=$(left_of "$m")
    # Claude trims leading spaces off each row, so the first column is never blank: ▶ is the
    # account this pane runs on, a dim dot any other.
    mark="@{dim}·@{off}"; name=$(label "$short")
    if [ "$id" = "$me" ]; then
      mark='▶'
      name="@{bold}$name@{off}"
      [ "$mname" != - ] && best=$mname
      # Every row shows the file's numbers, the same ones the panel shows: the plugin has already
      # merged this pane's own reading into them. The pane's numbers only fill a gap.
      [ "$s" = - ] && [ "$five" != - ] && s=$five
      [ "$w" = - ] && [ "$seven" != - ] && w=$seven
    fi
    [ "$best" = '?' ] && [ "$mname" != - ] && best=$mname
    cool_text=$(until_text "$cool")
    [ -n "$cool_text" ] && cool_text="  @{alert}⏸$cool_text@{off}"
    col=$mname
    [ "$col" = - ] && col=model
    modelcol=
    [ -n "$hasmodel" ] && modelcol="  $(printf '%-*s' "$namew" "$col") $(bar "$m")"
    row="$mark $name  5h $(bar "$s")  7d $(bar "$w")$modelcol$cool_text"
    rows="@{rows:+$rows
}$row"
  done <"$status"
fi
case "$best" in -|'') best=? ;; esac
if [ -z "$rows" ]; then
  labelw=12
  rows="▶ $(label 'this session')  5h $(bar "$five")  7d $(bar "$seven")"
  [ -r "$status" ] || rows="$rows  @{dim}no Auto Hand-off status yet@{off}"
fi

# {placeholder} substitution in the header, every occurrence, no eval.
line=$format
# A value is put in as it is and never read again, so one that holds a placeholder cannot loop.
subst() {
  put=; rest=$line
  while case "$rest" in *"$1"*) true ;; *) false ;; esac; do
    put="$put@{rest%%"$1"*}$2"
    rest=@{rest#*"$1"}
  done
  line="$put$rest"
}
subst '{model}' "$model"
subst '{ctxbar}' "$(bar "$ctx")"
subst '{ctx}' "$ctx"
subst '{5h}' "$five"
subst '{7d}' "$seven"
subst '{reset}' "@{reset_text:-now}"
subst '{best}' "$best"
[ -r "$status" ] || line="$line │ no Auto Hand-off status yet"
[ "$paused" = 1 ] && line="$line │ @{alert}⏸ automatic hand-off paused@{off}"
# The earlier status line first, then ours below it. The header is optional (the format
# setting); by default only the account rows print.
[ -n "$prev_out" ] && printf '%s\n' "$prev_out"
[ -n "$format" ] && printf '%s\n' "$line"
printf '%s\n' "$rows"
exit 0
`

export const SCRIPT = RAW.split('@{').join('${')
