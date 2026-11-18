# Auto Hand-off (Orca plugin)

**Hit a rate limit? Auto-switch to your next account.** Automatic account switching for Orca agents. When a Claude, Codex, Antigravity, OpenCode or Devin account hits a limit, Auto Hand-off moves the session to your next account and keeps working. Claude stays Claude, Codex stays Codex: a session always keeps its provider.

Product page: <https://ngoohebi.github.io/orca-account-rotator/>

Runs Orca's managed agent accounts as one pool, like [cux](https://github.com/inulute/cux) does for
Claude Code, but inside Orca and for every provider Orca manages: Claude, Codex, Antigravity,
OpenCode and Devin. When an agent pane hits a rate limit, or a usage threshold you set, the plugin:

1. puts that account on cooldown until the limit resets,
2. picks the next healthy account,
3. runs `orca account select`,
4. closes the limited pane,
5. resumes the same session (`agent.resume`),
6. types the configured first message ("Go continue." by default).

When every account of the provider is exhausted it parks the session and resumes it when the
earliest limit resets. It only ever switches between accounts of the **same service**: a Claude
pane moves to another Claude account and a Codex pane to another Codex account, never across
services. Where the service cannot resume a session by id on another account (Codex, Antigravity,
OpenCode, Devin), the same agent is started on the next account with a handoff prompt: why the
previous run stopped, the session title, branch, `git status`, `git diff --stat` and the last output.

Usage numbers come from Orca itself (`orca account list --json` → `rateLimits`). The plugin never
reads tokens or keychains.

**Projects on a paired Orca server.** Managed accounts belong to the Orca that runs the agent, so a
project on a paired server (Orca host `runtime:<server>`) has its own accounts and its own active
selection. The plugin follows the project: the panel lists that server's accounts and names the
server, and a pane there is switched, closed and resumed with that server's accounts. Each server's
accounts are cached separately. Since the `orca account` commands refuse `--environment`, the
worker reaches a paired server through Orca's own runtime client (see *Permissions*). A project on
a direct SSH target (host `ssh:<target>`) is different: its agents run with that machine's own
login and Orca manages no accounts for it, so the plugin leaves those panes alone, notes a limit
there in the history instead of switching, and the panel says so.

## What it does

| Trigger | Action |
|---|---|
| Rate-limit banner in the pane's latest output | Cooldown that seat until the parsed reset time (else Orca's `resetsAt`, else *Default cooldown*), switch, resume |
| Model-specific cap (e.g. Claude Fable weekly) | Type `/model <next>` from *Model fallback* in place; switch accounts only when the list runs out |
| API error (529, overloaded, stream disconnected) | Type the first message again after a Fibonacci backoff (5 s … 120 s), up to *Maximum API error retries* |
| Auth failure | 12 h cooldown on that seat, switch |
| A turn ends while the seat is over a threshold | Switch (thresholds default to 100 %, so this is reactive only); the seat left stays out of rotation until that window resets |
| Every seat limited | Park; wake when the earliest seat frees up (*Wait for reset*). Carry on in the parked pane yourself and the wait ends |
| A higher-priority account is healthy again | **Switch back:** select it for new launches; sessions on lower accounts move back when they finish a turn or sit idle |
| A session idles on an over-threshold account | Move it after *Move idle sessions after* seconds (900 by default; 0 = off) |
| `orca account select` fails for an account | Skip that account for 10 minutes, take the next |

Detection runs when a pane turns `done` or `waiting`. A banner only counts when all of these hold:

- it is among the last five meaningful lines, because an agent that stopped on a limit stops there;
- it has the shape of a CLI status line: Claude `⎿` or unindented system lines, or the error
  markers other CLIs use (`■`, `⚠`, `error:`, …);
- it is not an input line (`❯`, `›`, `>`), TUI frame or footer, or one of Claude's own `⏺` replies.

An agent's reply that mentions rate limits is therefore not treated as a limit. Detection is
heuristic, though; the `Automatic hand-off` toggle and the per-service switches are the off
switches if it ever misfires.

Each banner is handled once *per session*, so a session that Orca restores or restarts in a new
pane, redrawing its old transcript, is not switched again. Once a banner has scrolled away, the
same text appearing again later counts as a new limit.

**Panes the plugin did not start** (opened before it loaded, or restored by Orca) have no recorded
account. When one hits a limit while Orca reports plenty of room on the active account, the plugin
assumes the pane was on another account. It cools nothing and resumes the session on the active
account; from then on the pane's account is known.

**`auto_resume` off:** the plugin only switches the account for new launches and tells you. The
limited pane stays as it is for you to resume.

**On/off per service.** Each service has its own switch: on its card in the panel, or as
*Auto hand-off Claude/Codex/Antigravity/OpenCode/Devin accounts* in Settings. All are on by default.
For a service that is off, the plugin never closes, switches or resumes its panes, and its parked
sessions stay parked. Manual switching from the panel or the commands still works. The status bar
shows it as `codex off`. The *Automatic hand-off* toggle at the top pauses every service at once.

Strategies: **drain** (next account in chain order; the default), **balanced** (most room),
**priority** (always the first healthy account in the chain), **soonest-reset** (the account whose
weekly window resets first, so expiring usage is spent first), **manual** (never automatic).

**Switch back** (on by default; drain and priority, where the chain is a priority order): once an
account earlier in the chain is out of cooldown and under its thresholds, the plugin selects it
again so new launches use it, and moves sessions that are still on lower accounts back to it when
they finish a turn, or once they have been idle for *Move idle sessions after* seconds. The same
close → resume → first message as any other swap.

**Guards on advisory moves** (threshold, idle, switch-back; hard limits ignore them):

- a pane whose input box holds unsent text is never closed (the move waits for the next turn end);
- the target needs at least *Minimum headroom gap* (10 %) more room than the current account when
  both are known, and an exhausted account may always leave;
- one provider's selection changes automatically at most once per *Minimum minutes between
  automatic selection changes* (5), so two accounts near the line never ping-pong. Moving a pane
  onto the account that is already selected is not a selection change.

**Never switch to:** accounts listed in `exclude` (same tokens as `chain`) are kept out of
automatic rotation and switch-back; picking them from the panel still works.

## UI

- **Status bar:** `claude 2/3 · 7%·18% | codex 1/3 · 0%`. The tone turns to warning at 80 % and to
  danger while a session is parked. Click it to move Claude to the next account.
- **Panel** (gauge icon, right sidebar), laid out after Orca's own style guide (quiet and
  monochrome, colour only for state):
  - one section per service, in Orca's order except that the service of the agent in the current
    terminal tab comes first, marked *this terminal* (the panel re-checks every few seconds while
    open, since switching tabs raises no event); each sits on a band
    washed in the tone nearest its brand with a brand-coloured rule under its name, a status
    light, "n of m ready" and, when it has more than one account, that service's auto hand-off
    toggle; the Claude section also has a
    *Status line* switch that installs or removes the console status line in the focused
    workspace (the same as the install and remove commands);
  - each account, the one in use first, then the usable ones with the most headroom first, then
    the drained and limited ones; each with a status light (solid green in use, hollow green
    ready, amber low, red limited or drained, grey idle), its 5-hour, weekly and model windows as
    "% left" plus the reset time on the same bar Orca's account switcher draws (green, yellow
    from 80 % used, red from 90 %), and *Clear* on a cooldown;
  - on each standby account, *Hand off*, which asks first: new sessions of that
    service start on it, and the session in the current tab moves once it finishes its reply
    (a working pane keeps its account). Automatic hand-off for that service then turns off, so
    the plugin never undoes a choice you made by hand: no switch-back, no threshold or limit
    handling, until you turn *Auto hand-off* for the service on again. The block says so while it
    is off, and a desktop notification reminds you at the time. A limited standby cannot be
    chosen until its cooldown is cleared. The panel only displays;
    selection changes come from the plugin, the status-bar click or the commands;
  - the automatic-switching toggle and when usage was last read;
  - parked sessions;
  - swap history: the last 7 days, older entries are cleaned up automatically (at most 1,000 kept).
- **Commands:** switch Claude or Codex to the next account, move this workspace's agent to
  another account, pause or resume, refresh usage, install or remove the console status line.
- **Console status line** (Claude panes): see below.
- **Settings** (Settings → Plugins → Auto Hand-off): every cux key (`thresholds`, `strategy`,
  `auto_resume`, `auto_message`, `wait_for_reset`, `retry_on_api_error`, `model_fallback`, …) plus
  `chain`, `exclude`, `switch_back`, `switch_cooldown_minutes`, `min_headroom_gap`,
  `auto_swap_idle_after_seconds`, `default_cooldown_minutes`, `handoff_max_chars` and
  `orca_cli_path`.

`chain` example: `me@example.com, claude:*`. It orders the accounts *within* each service. Accounts
are matched by email or by seat key (`claude:<id>`, `codex:system`); an email matches that address
on every service, but each service keeps its own chain.

## Console status line

Orca points Claude Code's `statusLine` at its own hook, which feeds Orca's status bar and prints
nothing, so a Claude pane in Orca shows no status line. *Auto Hand-off: Install the console
status line in this workspace* writes a wrapper into the focused workspace's
`.claude/settings.local.json` (project settings win over the user settings Orca manages). The
wrapper still forwards every payload to Orca's hook, then prints one row per account of the pane's
own service (a Claude pane lists the Claude accounts, never Codex):

```
▶ work          5h ██████░░  78%  7d ████████  96%  fable ████████  94%
· personal      5h ████████ 100%  7d ████████ 100%  fable ████████ 100%
· side          5h ░░░░░░░░   0%  7d ██████░░  81%  fable ██████░░  81%  ⏸1h20m
```

Every gauge is **percent left**: the 5-hour window, the 7-day window and the best model's weekly
window, headed by that window's name as Orca reports it (`fableWeekly` → `fable`; `model` when
Orca has none for that account). Green above 50 %, yellow from 50 down to 21, red at 20 or less,
bold red at 0; a window without numbers shows `········  n/a`. `▶` and a bold label mark the
account this pane runs on (from `CLAUDE_CONFIG_DIR`; its 5h/7d come from the live numbers Claude
just reported); every other account gets a dim `·`, because Claude trims leading spaces off a row.
`⏸1h20m` at the end of a row is a cooldown. Rows keep Orca's account order so they never jump. The
name column shows the account email (or `system (email)` for the provider's own login); when every
account of the service shares one domain the domain is dropped, otherwise the full address shows.
The column is as wide as the longest name up to 15 characters; a longer name keeps its first 14
and an `…`, so the start of the local part, which tells accounts apart, stays.

Settings: *Console status line header* is an optional line above the rows (empty by default), with
`{model}`, `{ctxbar}` (context-left gauge), `{ctx}` (context left %), `{5h}` and `{7d}` (this pane,
% left), `{reset}` (time until the 5-hour window resets) and `{best}` (the best model's name); it
ends with `⏸ switching paused` while automatic hand-off is off. *Console status line bar width*
is the cells per gauge (8). The worker rewrites `~/.orca/account-rotator/status.tsv` whenever a
seat changes and keeps the script at `~/.orca/account-rotator/claude-statusline.sh`; the line
never runs the Orca CLI, so it stays well inside Claude's status line budget (about 40 ms with jq,
which macOS ships; a sed fallback covers machines without it). *Remove the console status line
from this workspace* restores whatever `statusLine` the file had before, and deletes the file when
the wrapper was all it held.

## Provider notes

- **Claude:** resumes by session id. Every Orca Claude profile's `projects/` is a symlink to
  `~/.claude/projects`, so the transcript is visible from every account. Usage for an inactive
  account is unknown until it runs, so it is treated as eligible.
- **Codex:** each Orca Codex account keeps its own `sessions/`, so a session may not exist on the
  next account. Codex moves by handoff until cross-account resume is verified. A Codex profile that
  routes to another backend (such as Ollama Cloud) reports billing limits as
  `stream disconnected … Add usage credits`, which the plugin treats as a rate limit.
- **Antigravity, OpenCode, Devin:** move by handoff. OpenCode and Devin report no usage, so only
  rate limits trigger a switch for them. Antigravity's own host login shows in the panel with its
  usage even when no managed account exists, so you can watch it; with one account there is
  nothing to switch to.

## Verified live (Orca 1.4.261)

A scratch Claude agent printed a `5-hour limit reached ∙ resets 3pm` line. The plugin then:

- cooled the account down until 3pm,
- ran `orca account select` for the next account,
- closed the pane,
- `agent.resume`d the same session on the new account,
- typed "Go continue.", which the agent answered.

There was exactly one swap and no cascade. Behaviour learned on the way, all covered by
regression tests:

- **Workspace ids:** `agents.list` takes the event's `workspaceId` (`<repo>::<path>`). It refuses
  `workspaceListId`.
- **Panes outside the focused workspace:** the host API refuses `terminal.sendText` and
  `terminal.close` there, so the plugin falls back to `orca terminal send` and
  `orca terminal close`.
- **Redrawn banners:** a resumed Claude session redraws its transcript, old banner included, and
  sometimes only after a delay. A banner counts as new only when a new copy of it appears.
- **Orca's restart prompt:** when the selected account changes, Orca itself may offer to restart
  other running Claude sessions on the new account (a "Review" toast). That is Orca's choice; the
  plugin only moves the pane that hit the limit.

## Not migrated from cux

These cux features are not in the plugin yet:

- per-directory project bindings (only one global `chain` setting);
- `cux attach`.

## Borrowed from elsewhere

- Switch back to a higher-priority account when its window resets: Orca issue
  [#33193](https://github.com/stablyai/orca/issues/33193), tokenmaxx's return-to-primary, cswap's
  `priority-consume-first`.
- Headroom gap and selection cooldown: Orca PR [#28044](https://github.com/stablyai/orca/pull/28044),
  cswap's hysteresis.
- Skipping an account that fails to switch, per-account exclusion: Orca PR
  [#43578](https://github.com/stablyai/orca/pull/43578), cswap `disable`, AgentsRoom "never used as
  backup".
- `soonest-reset`: Orca PR [#42856](https://github.com/stablyai/orca/pull/42856), cswap `weekly-first`.
- Leaving a pane with unsent text alone: Orca issue [#41488](https://github.com/stablyai/orca/issues/41488).
- Idle-session moves: cux `auto_swap_idle_after_seconds`.

Disable cux's own hooks (`cux uninstall-hooks`) before you enable this plugin, so the two don't
both rotate.

## Permissions

Orca asks you to approve the plugin's access. Beyond the host API, the worker runs the `orca` CLI
(`account select`, `account list`, `terminal close`, `terminal send`) and `git status` and
`git diff --stat`. It always uses an argument list, never a shell. The CLI is used because the host
API cannot select accounts, and refuses to close or type into panes outside the focused workspace.

For a project on a paired Orca server the worker loads Orca's own runtime client from the app
bundle (`app.asar.unpacked/out/cli/runtime/client.js`) and calls that server's `accounts.*` RPCs
(`accounts.list`, `accounts.selectClaude`, …) over the pairing saved on this computer, because the
CLI's account commands only answer for this computer. Those modules are Orca internals, not a
published API: an Orca update can break the server path, in which case the panel shows the error
and this computer's accounts keep working.

A handoff prompt (for services that cannot resume by session id) includes up to 40 lines of the
previous agent's output, so treat it like any pasted terminal output.

## License

MIT; see [LICENSE](LICENSE).

## Develop

```sh
orca plugin test . --json        # 76 tests: adapters (real captured banners), selector, worker end to end, panel
orca plugin check . --json       # renders the panel with the real worker (reads your real accounts)
npx -p typescript tsc -p .       # type-check; src/node-shim.d.ts stands in for @types/node
orca plugin validate . --json
orca plugin dev load . --json    # needs --approve <fingerprint> the first time
orca plugin dev request . rotator.debug   # last status events, agents.list, workspace ids
```

Code layout:

- `src/adapters.ts`: per-provider banner rules and reset-time parsing.
- `src/accounts.ts`: parses `orca account list --json`.
- `src/selector.ts`: the chain, eligibility and strategies.
- `src/engine.ts`: the swap logic, with every side effect injected.
- `src/cli.ts`: runs the `orca` CLI and `git`.
- `src/worker.ts`: wiring and the status bar.
- `src/panel.tsx`: the panel.
