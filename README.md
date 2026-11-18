# Account Rotator (Orca plugin)

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
| A turn ends while the seat is over a threshold | Switch (thresholds default to 100 %, so this is reactive only) |
| Every seat limited | Park; wake when the earliest seat frees up (*Wait for reset*) |

Detection reads at most the last 14 non-empty lines when a pane turns `done` or `waiting`. It
ignores input lines (`❯`, `›`, `>`), the TUI frame, and Claude's own `⏺` replies, so a
conversation about rate limits never triggers a switch. Each banner is handled once, and a banner
that has scrolled up is treated as old.

**On/off per service.** Each service has its own switch: on its card in the panel, or as
*Auto-switch Claude/Codex/Antigravity/OpenCode/Devin accounts* in Settings. All are on by default.
For a service that is off, the plugin never closes, switches or resumes its panes, and its parked
sessions stay parked. Manual switching from the panel or the commands still works. The status bar
shows it as `codex off`. The *Automatic switching* toggle at the top pauses every service at once.

Strategies: **drain** (next account in chain order; the default), **balanced** (most room),
**priority** (always the first healthy account in the chain), **manual** (never automatic).

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
  `chain`, `default_cooldown_minutes`, `handoff_max_chars` and
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
- moving idle sessions off an over-threshold seat (`auto_swap_idle_after_seconds`);
- `cux attach`.

Disable cux's own hooks (`cux uninstall-hooks`) before you enable this plugin, so the two don't
both rotate.

## Develop

```sh
orca plugin test . --json        # 41 tests: adapters (real captured banners), selector, worker end to end, panel
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
