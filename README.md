# Account Rotator (Orca plugin)

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
heuristic, though; the `Automatic switching` toggle and the per-service switches are the off
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
*Auto-switch Claude/Codex/Antigravity/OpenCode/Devin accounts* in Settings. All are on by default.
For a service that is off, the plugin never closes, switches or resumes its panes, and its parked
sessions stay parked. Manual switching from the panel or the commands still works. The status bar
shows it as `codex off`. The *Automatic switching* toggle at the top pauses every service at once.

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
- **Panel** (gauge icon, right sidebar):
  - each account with 5-hour, weekly and model bars, active and limited badges, a cooldown
    countdown, *Clear* and *Use for new launches*;
  - the automatic-switching toggle;
  - parked sessions;
  - swap history (the last 1,000 entries are kept).
- **Commands:** switch Claude or Codex to the next account, move this workspace's agent to
  another account, pause or resume, refresh usage.
- **Settings** (Settings → Plugins → Account Rotator): every cux key (`thresholds`, `strategy`,
  `auto_resume`, `auto_message`, `wait_for_reset`, `retry_on_api_error`, `model_fallback`, …) plus
  `chain`, `exclude`, `switch_back`, `switch_cooldown_minutes`, `min_headroom_gap`,
  `auto_swap_idle_after_seconds`, `default_cooldown_minutes`, `handoff_max_chars` and
  `orca_cli_path`.

`chain` example: `me@example.com, claude:*`. It orders the accounts *within* each service. Accounts
are matched by email or by seat key (`claude:<id>`, `codex:system`); an email matches that address
on every service, but each service keeps its own chain.

## Provider notes

- **Claude:** resumes by session id. Every Orca Claude profile's `projects/` is a symlink to
  `~/.claude/projects`, so the transcript is visible from every account. Usage for an inactive
  account is unknown until it runs, so it is treated as eligible.
- **Codex:** each Orca Codex account keeps its own `sessions/`, so a session may not exist on the
  next account. Codex moves by handoff until cross-account resume is verified. A Codex profile that
  routes to another backend (such as Ollama Cloud) reports billing limits as
  `stream disconnected … Add usage credits`, which the plugin treats as a rate limit.
- **Antigravity, OpenCode, Devin:** move by handoff. OpenCode and Devin report no usage, so only
  rate limits trigger a switch for them.

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

A handoff prompt (for services that cannot resume by session id) includes up to 40 lines of the
previous agent's output, so treat it like any pasted terminal output.

## License

MIT; see [LICENSE](LICENSE).

## Develop

```sh
orca plugin test . --json        # 46 tests: adapters (real captured banners), selector, worker end to end, panel
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
