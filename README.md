# OAH — Orca Auto Hand-off (`v0.5.0`)

**Hit a rate limit? Auto-switch to your next account and keep working.**

OAH is a **CLI-first, zero-dependency Node.js daemon (`oah` / `oahd`)** with a **thin Orca sidebar panel** for automatic account switching and failover across **Claude, Codex, Antigravity, OpenCode, and Devin**. Claude stays Claude, Codex stays Codex: a session always keeps its provider.

Product page: <https://ngoohebi.github.io/orca-auto-handoff/>

---

## Architecture

OAH runs a **dual-plane, current-session-attached** architecture with zero npm dependencies:

1. **`oahd` Daemon (`bin/oahd`):** Owns all state, settings, usage cache, burn-rate samples, circuit breaker state, and hand-off logic in `~/.orca/oah/` (`config.json`, `state.json`, `usage.json`, `samples.json`, `providers.json`, `oahd.sock`, permissions `0700`/`0600`). Auto-starts on demand when `oah` or the Orca plugin connects.
2. **`oah` CLI (`bin/oah`):** First-class command line with `--json` on every subcommand. Works locally, on headless `orca serve` hosts, on paired remote servers, and inside scripts/agents — even without the Orca panel.
3. **Thin Orca Plugin (`src/plugin/worker.ts` + `src/panel.tsx`):** Zero business logic or local state. Stays attached to the focused workspace's `oah` session (local `oahd.sock` or persistent `oah session` NDJSON), forwards `agent.status.changed` / `workspace.changed` / `agent.launch.before`, provides native Claude `agent.resume` and desktop notifications, and renders the **OAH** sidebar panel (**Accounts**, **History**, **Settings**).
4. **Optional Local HTTP Proxy (`src/daemon/proxy.ts`):** Opt-in `127.0.0.1:4080` failover gateway (`oah proxy start`) for Anthropic & OpenAI API-key/relay providers, sharing the same 3-state circuit breaker and offering one-click endpoint latency benchmarking (`oah bench`).

---

## Quick Start

### 1. Run the `oah` CLI (requires Node.js ≥ 22.18, zero npm dependencies)

```sh
git clone https://github.com/ngoohebi/orca-auto-handoff.git
cd orca-auto-handoff

./bin/oah status                 # auto-starts oahd and shows accounts, usage & circuit state
./bin/oah active --json          # active account(s) for scripts & external agents
./bin/oah refresh                # ask Orca to refresh usage, then show status
./bin/oah use work@example.com   # select account + hand off on-screen session
./bin/oah daemon status          # check oahd pid, uptime, socket & Orca bridge
```

Optional: symlink `~/.orca/oah/bin/oah` into your `PATH` (e.g. `export PATH="$HOME/.orca/oah/bin:$PATH"`).

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

Open the **OAH** panel (gauge icon, right sidebar). The defaults (**Auto · Early when away · Ask me first**) require no configuration.

---

## Key Features (`v0.5.0`)

### Subscription Pool & Proactive Forecasting
- **Same-service pooling:** Pools all Orca-managed accounts per provider (**Claude, Codex, Antigravity, OpenCode, Devin**) without ever reading tokens or keychains.
- **Set up Antigravity hand-offs:** Sign in with `agy` on the Orca host and save the current login in **Orca Settings → AI Provider Accounts** before switching Google accounts. Repeat for a second account, then refresh OAH. Run `orca account list --agent antigravity` to check that both profiles are saved on that host.
- **Auto (`smart`) vs. Custom Order (`my-order`):**
  - *Auto* ranks accounts by projected runway (2-sample burn rate + nested whole-window pace `usedPercent / elapsedFraction` with a 5% minimum elapsed guard), prioritizes expiring weekly quota (`>15%` left, `<48h` to reset), and prevents flapping (`leftLow`).
  - *Custom order* follows your ranking and switches back to higher-priority accounts once they recover.
- **Formal 3-State Circuit Breaker (`closed` / `open` / `half_open`):**
  - Cooldowns open the circuit; after expiry, seats enter `half_open` and are deprioritized behind healthy `closed` seats until a clean turn closes the circuit (or `oah clear <account>` resets it).
- **Codex `ordinaryUsageAllowed` Gate & Typed Auth Errors:**
  - Gates Codex eligibility on `ordinaryUsageAllowed` (ignoring the `codex_bengalfox` Spark decoy bucket) and classifies expired/missing logins as `sign-in` so dead logins never trigger blind failover loops.
- **Per-Model Window Policy (`model_window_policy`):**
  - Choose how per-model weekly caps (e.g., Claude Fable/Opus) are handled: `fallback-model` (try `/model <next>` first), `rotate` (proactively rotate and avoid accounts with 0% left in that model bucket), or `ignore`.
- **Live quota:** On by default (**Settings → Usage → Live quota**). Orca is the source of usage: OAH asks it only for a refresh of what is stale, within Orca's own throttles and Retry-After (never a forced refresh). Orca reads only the account in use, and only while you are using Orca, so OAH fills the gaps: when Orca's reading of an account is missing or older than 15 minutes (Claude) or 10 minutes (the others), OAH asks that account's provider directly, with the sign-in Orca already saved for it (manage sign-ins in **Orca Settings → AI Provider Accounts**). Not every service can: Antigravity only for the account signed in to Antigravity on this Mac, OpenCode only with OpenCode Go, and never an agent's own login. When a Claude account's saved sign-in has expired, OAH runs Claude Code's own `claude -p /usage` for that account (at most every 15 minutes), so Claude Code renews it and OAH never writes the Keychain. A check that needs a look is said on the account in **Accounts**. Off: usage comes only from Orca.
  - Claude checks verify the profile's email and organization with Anthropic. Codex checks verify the account ID returned by the profile's app-server.
  - On macOS, OAH matches the native Antigravity login's Google account ID to a saved Orca profile. Other Antigravity profiles use Orca readings or the cache.
  - OpenCode Go checks use the key from the linked managed profile's `opencode-go` integration.
  - Devin checks read daily and weekly quota using the credential in the managed CLI profile.
  - If Orca's account list becomes unavailable, OAH can still probe profiles it already discovered in this daemon session. The Accounts panel shows the Orca error, and readings from Orca use the cache until the account list returns.

### Session Continuity & Fail-Closed Safety
- **Exact resume vs. summary hand-off:**
  - **Claude:** Closes the old pane safely, resumes the exact session (`agent.resume`), types `"Continue."` (only after a limit/error interruption), restores plain unsent text (≤4,000 chars) via bracketed paste, and adopts the background pane into a real tab.
  - **Codex, Antigravity, OpenCode, Devin:** Hand off only at a real limit (or manual trigger) into a new session with a structured summary (≤4,096 chars: reason, branch, `git status`, `git diff --stat`, last 40 lines).
- **Session-on-screen care (`active_terminal`):** `ask` (default), `careful` (presence-aware countdown), `wait` (wait for tab switch), or `now`.
- **Unsent text guard:** Reads the input box twice before closing; aborts if typing is in progress, parks if queued messages or non-portable drafts (`[Image #1]`, `>4,000` chars) are present.
- **Per-workspace / per-pane pinning:** `oah pin <workspaceId|terminalId> <account>` keeps dedicated sessions on their pinned account.
- **Instant `StopFailure` hook:** Claude Code's `StopFailure` hook can notify `oahd` immediately via `oah event stop-failure` (zero regex lag, works on Terminal and Chat sessions).
- **Claude console status line:** Fast (~40ms) POSIX `sh` wrapper showing live multi-account 5h/7d/model bars right inside Claude panes. On by default (**Settings → Usage → Claude status line**, or `oah statusline install` / `remove`): it applies to every workspace on this computer, including ones opened later. A status line you already had (the workspace's own, or the one in your Claude config folder's `settings.json`) keeps showing, with the account rows below it; turning it off puts back what was there. The row of the account a pane runs on is marked `▶`, also when a launcher such as ClaudeBar starts Claude from its own config folder (matched to the Orca account with the same sign-in). An optional header line can still be set with the `console_statusline_format` setting.

### API Backup and Endpoint Benchmarking
- **Mid-turn failover for API-key / relay providers:** Run `oah proxy start --port 4080` and point `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` at `http://127.0.0.1:4080`.
- Transparently retries the next healthy provider on HTTP `429` / `500` / `502` / `503` / `529` or timeout, shares the 3-state circuit breaker, supports per-provider `modelMap` rewriting, and streams SSE responses directly.
- **Endpoint latency bench:** `oah bench` tests all configured endpoints concurrently and reports `<300ms` (`fast`), `300–500ms` (`ok`), `>500ms` (`slow`), or `error`.

---

## `oah` CLI Reference

Every command supports `--json` for machine-readable output. Set `OAH_HOME=/path` to isolate state and socket.

```sh
# Status & inspection
oah [status] [--json]               # Accounts, usage, runway, cooldowns, circuit state, waiting
oah active [service] [--json]       # Active account(s) for scripts and external agents
oah refresh [--json]                # Force Orca usage refresh, then status
oah history [--limit 50] [--json]   # Recent hand-off history (7 days, up to 1,000 entries)
oah debug [--json]                  # Daemon health, bridge status, recent events
oah version [--json]                # CLI and daemon version

# Account & hand-off controls
oah use <account> [--force]         # Select <account> and hand off the on-screen session
oah handoff                         # Hand off the focused workspace session
oah next [service]                  # Select the next healthy account for new sessions
oah pause | oah resume              # Global automatic hand-off off or on
oah service <service> on|off        # Per-service automatic hand-off
oah clear <account>                 # Clear cooldown and reset circuit breaker
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
oah bench [--json]                  # Benchmark latency across configured proxy providers

# Configuration, hooks, sync & daemon
oah config [get [key]]              # View ~/.orca/oah/config.json settings
oah config set <key> <value>        # Validate and update a setting
oah statusline [status|install|remove]
oah event stop-failure [--session <id>] [--terminal <id>] [--error <kind>]
oah sync export | import <file>     # Export/import portable config JSON (API keys redacted)
oah session                         # Persistent bidirectional NDJSON stdio session
oah daemon start|stop|restart|status|logs
oah rpc <method> [jsonParams]       # Direct JSON-RPC passthrough to oahd
```

---

## Settings (`~/.orca/oah/config.json`)

Editable via `oah config set <key> <value>` or the panel's **Settings** tab:

| Key | Default | Choices / Range | Purpose |
|---|---|---|---|
| `pick` | `smart` | `smart`, `my-order` | Auto (runway + expiring quota) vs. Custom order |
| `timing` | `early` | `early`, `at-limit` | Early when away (Claude) vs. At limit only |
| `when_all_used` | `wait` | `wait`, `stop` | Wait for earliest reset vs. Stop |
| `active_terminal` | `ask` | `ask`, `careful`, `wait`, `now` | How the on-screen session is handled at a limit |
| `away_minutes` | `10` | `0–240` min | Inactivity before early hand-offs start (`0` = always) |
| `early_minutes` | `10` | `1–120` min | Runway horizon before handing off early |
| `early_percent_left` | `1` | `0–50` % | Fixed 5h floor regardless of pace (`0` = pace only) |
| `idle_minutes` | `15` | `0–1440` min | Idle hand-off threshold (`0` = never) |
| `switch_cooldown_minutes` | `5` | `0–240` min | Minimum interval between automatic early switches |
| `model_window_policy` | `fallback-model` | `fallback-model`, `rotate`, `ignore` | Per-model weekly cap (Fable/Opus) behavior |
| `model_fallback` | empty | `claude=sonnet,haiku` | In-place `/model` fallback list per service |
| `restore_unsent_text` | `true` | boolean | Restore plain unsent text via bracketed paste (Claude) |
| `auto_message` | `Continue.` | text | First message typed after a limit/API error interruption |
| `max_api_retries` | `6` | `0–50` | Fibonacci-backoff retries on 5xx / overloaded errors |
| `default_cooldown_minutes` | `60` | `1–1440` min | Cooldown when a limit banner omits a reset time |
| `poll_interval_seconds` | `60` | `15–3600` s | Background Orca usage poll cadence |

---

## Permissions & Privacy

- **Subscription accounts:** Orca manages sign-in and switching. For direct quota checks, OAH reads the linked profile's existing credential for the request. The credential stays in memory for the check. The provider CLI remains responsible for refreshing its credentials.
- **Local storage (`~/.orca/oah/`):** Directory is `0700`, files (`config.json`, `state.json`, `usage.json`, `samples.json`, `providers.json`, `status.tsv`, `oahd.sock`) are `0600` (owner-only). `oah sync export` redacts `apiKey` fields automatically.
- **CLI invocations:** Uses `execFile` with explicit argument arrays (never a shell) for `orca` (`account`, `agent`, `terminal`, `worktree`) and `git` (`status`, `diff --stat`).

---

## Known Limitations

- Closing a pane stops background shell jobs/dev servers started inside that pane.
- Codex, Antigravity, OpenCode, and Devin cannot resume by session ID across accounts; they start a new session with a ≤4,096-char hand-off summary at real limits only.
- Without the thin Orca plugin installed on a host, `oah` CLI still manages accounts, status, pinning, proxy failover, and summary hand-offs, but native Claude `agent.resume` by session ID requires the Orca plugin bridge.
- Scroll position is not preserved across pane hand-offs.
- The Claude console status line is a POSIX `sh` script (macOS/Linux/WSL; not native Windows cmd/PowerShell).

---

## Develop

```sh
npm run test:cli                 # 15 standalone Node tests (v0.5 core, daemon, probes, proxy, CLI, thin bridge)
npm run test:plugin              # 420 tests across all 15 suites via `orca plugin test`
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
- `src/panel.tsx`, `src/protocol.ts` — Orca sidebar panel UI (**Accounts**, **History**, **Settings**).

## License

MIT — see [LICENSE](LICENSE).
