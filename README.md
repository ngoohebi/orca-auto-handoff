# OAH — Orca Auto Hand-off (`v0.5.0`)

**Hit a rate limit? Auto-switch to your next account and keep working.**

OAH is a **CLI-first, zero-dependency Node.js daemon (`oah` / `oahd`)** with a **quiet, Orca-native sidebar panel** for automatic account hand-off and direct live quota tracking across **Claude, Codex, Antigravity, OpenCode, and Devin**. Claude stays Claude, Codex stays Codex: a session always keeps its provider.

Product page: <https://ngoohebi.github.io/orca-auto-handoff/>

---

## Architecture

OAH is **CLI- and daemon-centered** with zero npm dependencies:

1. **`oahd` Daemon (`bin/oahd`):** Owns all state, settings, usage cache, burn-rate samples, direct quota checks, circuit breakers, and hand-off logic in `~/.orca/oah/` (`config.json`, `state.json`, `usage.json`, `samples.json`, `providers.json`, `oahd.sock`, permissions `0700`/`0600`). Auto-starts on demand when `oah` or the Orca plugin connects.
2. **`oah` CLI (`bin/oah`):** First-class command line with `--json` on every subcommand. Works locally, on headless `orca serve` hosts, over SSH, and inside scripts or agents — even without the Orca panel.
3. **Thin Orca Plugin (`src/plugin/worker.ts` + `src/panel.tsx`):** Zero business logic or local state. Connects to `oahd.sock`, forwards `agent.status.changed` / `workspace.changed` / `agent.launch.before`, provides native Claude `agent.resume` and desktop notifications, and renders the 3-tab **OAH** sidebar panel (**Accounts**, **History**, **Settings**).
4. **Optional Local HTTP Proxy (`src/daemon/proxy.ts`):** Opt-in `127.0.0.1:4080` failover gateway (`oah proxy start`) for Anthropic & OpenAI API-key/relay providers, sharing the same 3-state circuit breaker and offering concurrent latency benchmarking (`oah bench`).

---

## Quick Start

### 1. Run the `oah` CLI (requires Node.js ≥ 22.18, zero npm dependencies)

```sh
git clone https://github.com/ngoohebi/orca-auto-handoff.git
cd orca-auto-handoff

./bin/oah status                 # auto-starts oahd and shows accounts, usage & circuit state
./bin/oah active --json          # active account(s) for scripts & external agents
./bin/oah refresh                # refresh usage, then show status
./bin/oah use work@example.com   # select account + hand off on-screen session
./bin/oah daemon status          # check oahd pid, uptime, socket & Orca bridge
```

Optional: add `~/.orca/oah/bin` to your `PATH` (e.g. `export PATH="$HOME/.orca/oah/bin:$PATH"`).

### 2. Install the Thin Orca Plugin (recommended for desktop Orca)

```sh
orca plugin install ngoohebi/orca-auto-handoff
# approve with the printed fingerprint:
orca plugin install ngoohebi/orca-auto-handoff --approve ap1-…
```

To install from a local checkout:

```sh
orca plugin install . --json
# then re-run with the printed --approve <fingerprint>
```

Open the **OAH** panel (gauge icon, right sidebar). Out of the box, OAH runs **Auto · Early when away · Ask me first**, with **Live quota** and the **Claude status line** turned on automatically.

---

## Key Features

### Direct Live Quota (`direct_quota`, on by default)
Orca only reads usage for the account currently in use, and only while you are at Orca. When Orca's reading for an account is missing or stale, OAH fills the gap by querying the provider directly using the sign-in Orca already saved (Claude at most every 15 minutes, other providers every 10 minutes), so inactive accounts and away time stay current too:

| Provider | Direct Quota Source | Notes |
|---|---|---|
| **Claude** | OAuth profile identity check → Anthropic usage API | If a saved sign-in is expired, OAH runs Claude Code's own `claude -p /usage` for that profile (at most every 15 min) so Claude Code renews it. OAH never writes the Keychain. |
| **Codex** | `codex app-server` → `account/rateLimits/read` per managed `CODEX_HOME` | Verified by backend `accountId`; gates on `ordinaryUsageAllowed` (ignoring the `codex_bengalfox` Spark bucket). |
| **Antigravity** | Google identity check → Cloud Code quota API | Direct check for the account signed in to Antigravity on this Mac; falls back to Orca's cached readings for other saved profiles. |
| **OpenCode Go** | OpenCode Go usage API | Reports rolling, weekly, and monthly windows. |
| **Devin** | Devin status API | Reports daily (`day`) and weekly (`week`) windows. |

Turn **Live quota** off in Settings to rely solely on Orca's own usage readings.

### Smart Forecasting & 3-State Circuit Breaker
- **Auto (`smart`) vs. Custom Order (`my-order`):**
  - *Auto* ranks accounts by projected runway (2-sample burn rate + nested whole-window projection `usedPercent / elapsedFraction` with a 5% minimum elapsed guard), prioritizes expiring weekly quota (`>15%` left, `<48h` to reset), and avoids flapping (`leftLow`).
  - *Custom order* follows your arrow-arranged ranking and switches back to higher-priority accounts once they recover.
- **Formal 3-State Circuit Breaker (`closed` / `open` / `half_open`):**
  - Cooldowns open the circuit; after expiry, seats enter `half_open` and are deprioritized behind healthy `closed` seats until a clean turn closes the circuit (or **End cooldown** / `oah clear <account>` resets it).
- **Per-Model Weekly Cap Policy (`model_window_policy`):**
  - Choose how per-model weekly windows (e.g., Claude Fable/Opus) are handled: `fallback-model` (try `/model <next>` first), `rotate` (proactively rotate away and avoid accounts with 0% left in that bucket), or `ignore`.

### Session Continuity & Fail-Closed Safety
- **Exact resume vs. summary hand-off:**
  - **Claude:** Closes the old pane safely, resumes the exact session (`agent.resume`), types `"Continue."` (only after a limit/error interruption), restores plain unsent text (≤4,000 chars) via bracketed paste, and adopts the background pane into a real tab.
  - **Codex, Antigravity, OpenCode, Devin:** Hand off only at a real limit (or manual trigger) into a new session with a structured summary (≤4,096 chars: reason, branch, `git status`, `git diff --stat`, last 40 lines).
- **Session-on-screen care (`active_terminal`):** `ask` (default), `careful` (presence-aware countdown), `wait` (wait for tab switch), or `now`.
- **Unsent text guard:** Reads the input box twice before closing; aborts if typing is in progress, parks if queued messages or non-portable drafts (`[Image #1]`, `>4,000` chars) are present.
- **Per-workspace / per-pane pinning:** `oah pin <workspaceId|terminalId> <account>` locks dedicated long-running sessions onto their pinned account.
- **Instant `StopFailure` hook:** Claude Code's `StopFailure` hook can trigger `oah event stop-failure` immediately on rate limits (Terminal and Chat sessions).
- **Claude status line (`console_statusline`, on by default):** One switch in Settings enables a fast (~40ms) POSIX `sh` status line across every workspace on this computer, preserving any existing status line and printing OAH's multi-account usage rows below it.

### Redesigned Quiet Panel UI
- **3 focused tabs:** **Accounts**, **History** (grouped by day; tab badge counts only failed hand-offs), and **Settings** (6 core settings up front, grouped Advanced settings, Save/Undo for typed values).
- **Orca-native quiet styling:** Monochrome layout, hairline row dividers, one-line service headers, state-only status line, and per-control busy states (each action greys out only its own button).

### Optional Local HTTP Failover Proxy & Bench
- Run `oah proxy start --port 4080` and point `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` at `http://127.0.0.1:4080` for transparent mid-request failover across API-key / third-party relay providers on HTTP `429` / `5xx` / `529` or timeouts.
- Shares OAH's 3-state circuit breaker, supports per-provider `modelMap` rewriting, streams SSE responses directly, and benchmarks endpoint latency concurrently via `oah bench`.

---

## `oah` CLI Reference

Every command accepts `--json`. Set `OAH_HOME=/path` to isolate state, config, and socket.

```sh
# Status & inspection
oah [status] [--json]               # Accounts, usage, runway, cooldowns, circuit state, waiting
oah active [service] [--json]       # Active account(s) for scripts and external agents
oah refresh [--json]                # Refresh usage, then show status
oah history [--limit 50] [--json]   # Recent hand-off history (7 days, up to 1,000 entries)
oah debug [--json]                  # Daemon health, bridge status, recent events
oah version [--json]                # CLI and daemon version

# Account & hand-off controls
oah use <account> [--force]         # Select <account> and hand off the on-screen session
oah handoff                         # Hand off the focused workspace session
oah next [service]                  # Select the next healthy account for new sessions
oah pause | oah resume              # Global automatic hand-off off or on
oah service <service> on|off        # Per-service automatic hand-off
oah clear <account>                 # End cooldown and reset circuit breaker
oah order up|down <account>         # Move an account in Custom order
oah pin <id> <account>              # Pin a workspace or terminal to one account
oah unpin <id> | oah pins           # Remove or list pins

# Waiting session responses
oah now <terminalId>                # Hand off a waiting on-screen session now
oah notnow <terminalId>             # Wait until you switch tabs
oah cancel <terminalId>             # Cancel a waiting hand-off

# Local HTTP proxy & API-key providers
oah proxy start [--port 4080] | stop | status
oah provider list
oah provider add <anthropic|openai> <name> <baseUrl> <apiKey> [--priority N]
oah provider on|off|rm <id>
oah bench [--json]                  # Benchmark endpoint latency across configured providers

# Configuration, hooks, sync & daemon
oah config [get [key]]              # View ~/.orca/oah/config.json settings
oah config set <key> <value>        # Validate and update a setting (aliases: settings, set)
oah statusline [status|install|remove]
oah event stop-failure [--session <id>] [--terminal <id>] [--error <kind>]
oah sync export | import <file>     # Export/import portable config JSON (API keys redacted)
oah session                         # Persistent bidirectional NDJSON stdio session
oah daemon start|stop|restart|status|logs
oah rpc <method> [jsonParams]       # Direct JSON-RPC passthrough to oahd
```

---

## Settings (`~/.orca/oah/config.json`)

Editable from `oah config set <key> <value>` or the panel's **Settings** tab:

### Core Settings
| Key | Default | Choices | Purpose |
|---|---|---|---|
| `pick` | `smart` | `smart`, `my-order` | Auto (runway + expiring quota) vs. Custom order |
| `timing` | `early` | `early`, `at-limit` | Early when away (Claude) vs. At limit only |
| `when_all_used` | `wait` | `wait`, `stop` | Wait for earliest reset vs. Stop |
| `active_terminal` | `ask` | `ask`, `careful`, `wait`, `now` | How the on-screen session is handled at a limit |
| `direct_quota` | `true` | boolean | Direct live quota checks when Orca readings are missing or stale |
| `console_statusline` | `true` | boolean | Show multi-account usage rows at the bottom of Claude Code across workspaces |

### Advanced Settings
| Key | Default | Range / Choices | Purpose |
|---|---|---|---|
| `away_minutes` | `10` | `0–240` min | Inactivity before early hand-offs start (`0` = always) |
| `early_minutes` | `10` | `1–120` min | Runway horizon before handing off early |
| `early_percent_left` | `1` | `0–50` % | Fixed 5h floor regardless of pace (`0` = pace only) |
| `idle_minutes` | `15` | `0–1440` min | Idle hand-off threshold (`0` = never) |
| `switch_cooldown_minutes` | `5` | `0–240` min | Minimum interval between automatic early switches |
| `active_countdown_seconds` | `60` | `10–3600` s | Countdown duration before moving an on-screen session |
| `active_presence_seconds` | `300` | `10–3600` s | How long activity counts as being at Orca |
| `active_reminder_minutes` | `10` | `0–1440` min | One reminder when an on-screen session waits this long (`0` = none) |
| `restore_unsent_text` | `true` | boolean | Restore plain unsent text via bracketed paste (Claude) |
| `auto_message` | `Continue.` | text | First message typed after a limit/API error interruption |
| `max_api_retries` | `6` | `0–50` | Fibonacci-backoff retries on 5xx / overloaded errors |
| `model_fallback` | empty | `claude=sonnet,haiku` | In-place `/model` fallback list per service |
| `model_window_policy` | `fallback-model` | `fallback-model`, `rotate`, `ignore` | Per-model weekly cap (Fable/Opus) behavior |
| `default_cooldown_minutes` | `60` | `1–1440` min | Cooldown when a limit banner omits a reset time |
| `poll_interval_seconds` | `60` | `15–3600` s | Background Orca usage poll cadence |
| `handoff_max_chars` | `6000` | `500–50000` chars | Max summary length for summary-only services (Orca caps at 4,096) |
| `orca_cli_path` | empty | path | Custom `orca` CLI binary path if not auto-detected |

---

## Permissions & Privacy

- **Credentials stay with Orca and provider CLIs:** OAH never writes the macOS Keychain, never creates accounts, and never copies provider tokens into its own config. Direct quota checks read the sign-in Orca already saved for each profile (and for expired Claude sign-ins, invoke Claude Code's own `claude -p /usage`).
- **Owner-only local storage (`~/.orca/oah/`):** Directory mode `0700`, files mode `0600`. `oah sync export` redacts `apiKey` fields automatically.
- **No shell interpolation:** Runs `orca`, `codex`, `claude`, and `git` via `execFile` / `spawn` argument lists only.

---

## Known Limitations

- Closing a pane stops background shell jobs or dev servers running inside that pane.
- Codex, Antigravity, OpenCode, and Devin cannot resume by session ID across accounts; they start a new session with a ≤4,096-char hand-off summary at real limits only.
- Antigravity direct quota checks apply to the account currently signed in to Antigravity on this Mac; other saved profiles fall back to Orca's cached readings.
- Without the thin Orca plugin installed on a host, `oah` CLI still manages accounts, status, pinning, direct quota checks, proxy failover, and summary hand-offs, while native Claude `agent.resume` by session ID requires the Orca plugin bridge.
- Scroll position is not preserved across pane hand-offs.
- The Claude console status line is a POSIX `sh` script (macOS/Linux/WSL; not native Windows cmd/PowerShell).

---

## Develop

```sh
npm run test:cli                 # standalone Node tests (core v0.5, daemon, probes, proxy, CLI, thin bridge)
npm run test:plugin              # full test suite via `orca plugin test`
npm run typecheck                # strict TypeScript check (zero npm deps; src/node-shim.d.ts)
npm run validate                 # validates orca-plugin.json
orca plugin check . --json       # renders the panel against the real worker
./bin/oah debug --json           # daemon status, bridge state & recent events
```

### Code Layout

- `bin/oah`, `bin/oahd` — zero-dependency Node.js executables.
- `src/core/` — pure domain logic (`engine.ts`, `smart.ts`, `selector.ts`, `adapters.ts`, `accounts.ts`, `usage-cache.ts`, `usage-history.ts`, `live-usage.ts`, `settings.ts`, `statusline.ts`, `statusline-files.ts`, `labels.ts`, `cli.ts`, `types.ts`, `version.ts`).
- `src/daemon/` — standalone `oahd` daemon (`server.ts`, `store.ts`, `ipc.ts`, `orca-transport.ts`, `probes.ts`, `proxy.ts`, `main.ts`).
- `src/cli/` — `oah` CLI (`client.ts`, `commands.ts`, `format.ts`, `session.ts`, `main.ts`).
- `src/plugin/` — thin Orca plugin worker bridge (`worker.ts`, `worker.test.ts`).
- `src/panel.tsx`, `src/protocol.ts` — quiet 3-tab Orca sidebar panel (**Accounts**, **History**, **Settings**).

## License

MIT — see [LICENSE](LICENSE).
