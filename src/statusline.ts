// Console status line for Claude Code panes. Orca points Claude's `statusLine` at its own hook,
// which forwards usage to Orca's status bar and prints nothing, so a Claude pane in Orca shows no
// status line. The plugin installs a wrapper in a workspace's `.claude/settings.local.json` (project
// settings win over the user settings Orca writes) that still forwards the payload to Orca's hook
// and then prints one line: the model, context use, and every account of the pane's service with
// the one this pane runs on marked.
//
// The worker writes `~/.orca/account-rotator/status.tsv` whenever the snapshot changes; the script
// reads it, so the line needs no CLI call and stays under Claude's status line budget.
import { displayLabels, seatOrder } from './labels'
import type { Snapshot } from './types'

export { displayLabels }

export const DATA_DIR = '.orca/account-rotator'
export const SCRIPT_NAME = 'claude-statusline.sh'
export const STATUS_NAME = 'status.tsv'
/** Where the wrapper leaves each account's latest numbers: `live/claude-<key>.tsv` (live-usage.ts). */
export const LIVE_DIR = 'live'
/** What `.claude/settings.local.json` runs; `$HOME` stays literal so the file is portable. */
export const STATUSLINE_COMMAND = `/bin/sh "$HOME/${DATA_DIR}/${SCRIPT_NAME}"`
/** The optional header line; empty = account rows only. */
export const DEFAULT_FORMAT = ''
export const HEADER_EXAMPLE = '{model} │ ctx {ctxbar} │ 5h reset {reset} │ best={best}'
/** Key under which an earlier `statusLine` is kept so uninstall can put it back. */
const PREVIOUS_KEY = 'accountRotatorPreviousStatusLine'

const clean = (s: string) => s.replace(/[\t\r\n]+/g, ' ').trim()
const pct = (n: number | undefined) => (typeof n === 'number' ? String(Math.round(n)) : '-')

export const DEFAULT_BAR_WIDTH = 8

/** The tab-separated file the script reads. One `seat` row per account, every provider, in the
 *  order the panel lists them (`seatOrder`), so the line and the panel agree. */

export function renderStatusFile(snapshot: Snapshot, format: string, now: number, barWidth = DEFAULT_BAR_WIDTH): string {
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
          seat.accountId,
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

/** `.claude/settings.local.json` with the wrapper as `statusLine`; an earlier value is kept aside. */
export function installIntoSettings(text: string | null): { text: string; replaced: boolean } {
  const settings = parseSettings(text)
  const previous = settings.statusLine
  const replaced = previous !== undefined && !isOurs(previous)
  if (replaced) settings[PREVIOUS_KEY] = previous
  settings.statusLine = { type: 'command', command: STATUSLINE_COMMAND, padding: 0 }
  return { text: JSON.stringify(settings, null, 2) + '\n', replaced }
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

tab=$(printf '\t')
model=- ctx=- five=- seven=- reset=- wreset=-
if command -v jq >/dev/null 2>&1; then
  fields=$(printf '%s' "$payload" | jq -r '[
      (.model.display_name // "-"),
      (.context_window.used_percentage // (
        if (.context_window.context_window_size // 0) > 0 and .context_window.current_usage then
          ((.context_window.current_usage.input_tokens // 0) + (.context_window.current_usage.cache_creation_input_tokens // 0) + (.context_window.current_usage.cache_read_input_tokens // 0)) * 100 / .context_window.context_window_size
        else "-" end)),
      (.rate_limits.five_hour.used_percentage // "-"),
      (.rate_limits.seven_day.used_percentage // "-"),
      (.rate_limits.five_hour.resets_at // "-"),
      (.rate_limits.seven_day.resets_at // "-")
    ] | map(tostring) | join("\t")' 2>/dev/null)
  if [ -n "$fields" ]; then
    oldifs=$IFS; IFS=$tab
    set -- $fields
    IFS=$oldifs
    model=@{1:-"-"}; ctx=@{2:-"-"}; five=@{3:-"-"}; seven=@{4:-"-"}; reset=@{5:-"-"}; wreset=@{6:-"-"}
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

now=$(date +%s 2>/dev/null || printf '%s' 0)

# Leave this pane's own numbers for the plugin: Orca polls only the selected account, so this is
# how an account that runs in a pane but is not selected stays known. One line, per account:
#   1 <tab> written (epoch s) <tab> 5h used % <tab> 5h reset (epoch s) <tab> 7d used % <tab> 7d reset
# The account is the profile in CLAUDE_CONFIG_DIR, or "system" for Claude's own login; any other
# config dir is not an account Orca manages and writes nothing. Background jobs do not write.
# Nothing here may fail the line: it runs in a subshell with errors dropped.
live_key=
case "@{CLAUDE_CONFIG_DIR:-}" in
  ''|"@{HOME:-}/.claude"|"@{HOME:-}/.claude/") live_key=system ;;
  */claude-profiles/*/*)
    live_key=@{CLAUDE_CONFIG_DIR##*/claude-profiles/}; live_key=@{live_key%%/*}
    case "$live_key" in ''|.|..|*[!A-Za-z0-9._-]*) live_key= ;; esac ;;
esac
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

# Which account this pane runs on: Orca sets CLAUDE_CONFIG_DIR to the profile's home.
me=system
case "@{CLAUDE_CONFIG_DIR:-}" in
  */claude-profiles/*) me=@{CLAUDE_CONFIG_DIR##*/claude-profiles/}; me=@{me%%/*} ;;
esac

format='${DEFAULT_FORMAT}'
paused=0
best=?
namew=5
rows=
if [ -r "$status" ]; then
  # Column widths: the widest account name (20..40) and the widest model-window name (fable,
  # opus, ...), so every row lines up.
  while IFS="$tab" read -r kind provider id short active s w cool m mname; do
    [ "$kind" = seat ] && [ "$provider" = claude ] || continue
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
    s=$(left_of "$s"); w=$(left_of "$w"); m=$(left_of "$m")
    # Claude trims leading spaces off each row, so the first column is never blank: ▶ is the
    # account this pane runs on, a dim dot any other.
    mark="@{dim}·@{off}"; name=$(label "$short")
    if [ "$id" = "$me" ]; then
      mark='▶'
      name="@{bold}$name@{off}"
      [ "$mname" != - ] && best=$mname
      # Live numbers from this pane beat the file's last poll.
      [ "$five" != - ] && s=$five
      [ "$seven" != - ] && w=$seven
    fi
    [ "$best" = '?' ] && [ "$mname" != - ] && best=$mname
    cool_text=$(until_text "$cool")
    [ -n "$cool_text" ] && cool_text="  @{alert}⏸$cool_text@{off}"
    col=$mname
    [ "$col" = - ] && col=model
    row="$mark $name  5h $(bar "$s")  7d $(bar "$w")  $(printf '%-*s' "$namew" "$col") $(bar "$m")$cool_text"
    rows="@{rows:+$rows
}$row"
  done <"$status"
fi
case "$best" in -|'') best=? ;; esac
if [ -z "$rows" ]; then
  labelw=9
  rows="▶ $(label 'this pane')  5h $(bar "$five")  7d $(bar "$seven")  model $(bar -)"
  [ -r "$status" ] || rows="$rows  @{dim}no rotator status yet@{off}"
fi

# {placeholder} substitution in the header, every occurrence, no eval.
line=$format
subst() {
  while case "$line" in *"$1"*) true ;; *) false ;; esac; do
    line="@{line%%"$1"*}$2@{line#*"$1"}"
  done
}
subst '{model}' "$model"
subst '{ctxbar}' "$(bar "$ctx")"
subst '{ctx}' "$ctx"
subst '{5h}' "$five"
subst '{7d}' "$seven"
subst '{reset}' "@{reset_text:-now}"
subst '{best}' "$best"
[ -r "$status" ] || line="$line │ no rotator status yet"
[ "$paused" = 1 ] && line="$line │ @{alert}⏸ switching paused@{off}"
# The header is optional (the format setting); by default only the account rows print.
[ -n "$format" ] && printf '%s\n' "$line"
printf '%s\n' "$rows"
exit 0
`

export const SCRIPT = RAW.split('@{').join('${')
