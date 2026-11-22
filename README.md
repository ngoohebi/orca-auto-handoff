# OAH (Orca Auto Hand-off) v0.5.0

**Hit a rate limit? Auto-switch to your next account and keep working.**

OAH is an **Orca plugin** that pools your managed accounts per service (**Claude, Codex, Antigravity, OpenCode, and Devin**) and automatically hands off sessions when an account hits a rate limit or runs low while you are away. Claude stays Claude, Codex stays Codex: a session always keeps its provider.

Product page: <https://ngoohebi.github.io/orca-auto-handoff/>

---

## Install

1. Add at least two accounts of a service in **Orca → Settings → AI Provider Accounts** (for example, two Claude or Codex accounts).
2. Install OAH in Orca:

   ```sh
   orca plugin install ngoohebi/orca-auto-handoff
   ```

   Orca shows the requested permissions and prints the same command with `--approve <fingerprint>`; run that to approve.
3. Open the **OAH** panel (gauge icon, right sidebar). That's it — the defaults (**Auto · Early when away · Ask me first**, **Live quota** on, **Claude status line** on) need no configuration.
4. Work as usual. While you are at Orca, sessions hand off only at a real limit; once you have been away for 10 minutes, Claude sessions hand off shortly before running out so work never stalls mid-turn.

---

## How It Works

### Same-Service Account Pooling & Hand-off
- **Claude (exact resume):** Cools down the limited account, selects the next healthy Claude account (`orca account select`), safely closes the old pane, resumes the exact same session (`agent.resume`), types `"Continue."` (only after a limit or API error interruption), restores plain unsent text via bracketed paste, and adopts the new pane into a real tab.
- **Codex, Antigravity, OpenCode, Devin (summary hand-off):** These providers cannot resume a session by ID on another account, so OAH hands them off only at a real limit (or when you click **Early hand off**) into a new session with a structured summary (≤4,096 chars: reason, branch, `git status`, `git diff --stat`, and the last 40 lines of output).
- **When every account is used up:** Sessions wait for the earliest reset and continue automatically (or stop if *When everything is used up* is set to *Stop*). If a waiting session's own account resets first, it continues right where it is.

### Direct Live Quota (on by default)
Orca is the primary source of usage (OAH reads Orca's local socket in ~1 ms, using stale-only refreshes within Orca's throttles). Because Orca only polls the active account while you are using Orca, **Live quota** fills missing or stale readings (>15 min for Claude, >10 min for other services) directly from each provider using the sign-in Orca already saved:

| Provider | Direct Quota Source | Notes |
|---|---|---|
| **Claude** | OAuth profile check → Anthropic usage API | If a saved sign-in is expired, OAH runs Claude Code's own `claude -p /usage` for that profile (at most every 15 min) so Claude Code renews it. OAH never writes the Keychain. |
| **Codex** | Direct Codex usage API per managed profile | Verified by account ID; gates on `ordinaryUsageAllowed` (ignoring the `codex_bengalfox` Spark bucket). |
| **Antigravity** | Google identity check → Cloud Code quota API | Direct check for the account signed in on this Mac; falls back to Orca's cached readings for other saved profiles. |
| **OpenCode Go** | OpenCode Go usage API | Reports rolling, weekly, and monthly windows. |
| **Devin** | Devin status API | Reports daily (`day`) and weekly (`week`) windows. |

Turn **Live quota** off in Settings if you prefer usage strictly from Orca.

### Smart Forecasting & 3-State Circuit Breaker
- **Auto (`smart`) vs. Custom Order (`my-order`):**
  - *Auto* ranks accounts by projected runway (2-sample burn rate + nested whole-window projection `usedPercent / elapsedFraction` with a 5% minimum elapsed guard), spends expiring weekly quota (`>15%` left, `<48h` to reset) first, and avoids flapping (`leftLow`).
  - *Custom order* follows your arrow-arranged ranking and switches back to higher-priority accounts once they recover.
- **Formal 3-State Circuit Breaker (`closed` / `open` / `half_open`):** Cooldowns open the circuit; after expiry, seats enter `half_open` and stay behind healthy `closed` seats until a clean turn completes (or **End cooldown** resets it).
- **Per-Model Weekly Cap Policy (`model_window_policy`):** Choose `fallback-model` (try `/model <next>` first), `rotate` (proactively rotate away on model weekly caps like Claude Fable and avoid accounts with 0% left in that bucket), or `ignore`.

### Quiet 3-Tab Orca Panel
- **Minimal header:** The global switch sits alone on the first line (`OAH (Orca Auto Hand-off) v0.5.0`), with current state, reading age, and refresh icon directly below.
- **Accounts:** Monochrome, hairline-divided rows with one-line service headers, status beside each account name, and right-aligned actions (**Early hand off**, **End cooldown**). **Early hand off** moves the on-screen session and keeps automatic hand-off ON. The focused service follows tab switches within ~1 second.
- **History:** Entries grouped by day (failed hand-offs highlighted in danger tone).
- **Settings:** 6 core settings up front, grouped **Advanced** fine-tuning below, and explicit **Save / Undo** buttons for typed values.

### Session Safety & Global Claude Status Line
- **Session-on-screen care (`active_terminal`):** `ask` (default), `careful` (presence-aware countdown), `wait` (wait for tab switch), or `now`.
- **Unsent draft guard:** Reads the input box twice before closing; aborts if typing is in progress, restores plain text (≤4,000 chars) unsent on Claude, and parks panes with queued messages or pasted images.
- **Global Claude status line (`console_statusline`, on by default):** One switch in Settings shows live multi-account usage bars at the bottom of Claude Code across every workspace on this computer (~40 ms), keeping any existing status line above OAH's rows and matching launcher config dirs (such as ClaudeBar) automatically.
- **Instant `StopFailure` hook:** Optional zero-regex Claude limit trigger for Terminal and Chat sessions.

---

## Settings

All settings are in the **OAH** panel's **Settings** tab (stored in `~/.orca/oah/config.json`):

### Core Settings
| Setting | Key | Default | Choices | What it does |
|---|---|---|---|---|
| **Pick the next account** | `pick` | `smart` | `smart`, `my-order` | Auto (runway + expiring quota) vs. Custom order |
| **When to hand off** | `timing` | `early` | `early`, `at-limit` | Early when away (Claude) vs. At limit only |
| **When everything is used up** | `when_all_used` | `wait` | `wait`, `stop` | Wait for earliest reset vs. Stop |
| **Session on screen** | `active_terminal` | `ask` | `ask`, `careful`, `wait`, `now` | Extra care for the session currently shown in Orca |
| **Live quota** | `direct_quota` | `true` | boolean | Fill missing/stale Orca readings directly from providers |
| **Claude status line** | `console_statusline` | `true` | boolean | Show multi-account usage rows in Claude Code across workspaces |

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

## Optional: `oah` CLI (Power Users / Headless)

You never need the command line for everyday use in Orca. Under the hood, OAH runs a lightweight local background helper (`oahd` on `~/.orca/oah/oahd.sock`) so state and timers survive panel closes and reloads. If you want terminal automation, scripting, or headless `orca serve` control, the optional **`oah` CLI** (`bin/oah`, `--json` on every command) exposes the same engine:

- **Status & controls:** `oah status`, `oah active [service]`, `oah refresh`, `oah use <account> [--force]`, `oah handoff`, `oah next [service]`, `oah pause|resume`, `oah service <svc> on|off`, `oah clear <account>`, `oah order up|down <account>`, `oah history`, `oah config [get|set]`
- **Pinning & waiting responses:** `oah pin <workspace|terminal> <account>`, `oah unpin <id>`, `oah pins`, `oah now|notnow|cancel <terminalId>`
- **Sync, hooks & daemon:** `oah sync export|import <file>`, `oah event stop-failure`, `oah session`, `oah daemon start|stop|restart|status|logs`

---

## Permissions & Privacy

- **Credentials stay with Orca and provider CLIs:** OAH never writes the macOS Keychain, never creates accounts, and never copies subscription tokens into its own config.
- **Owner-only local storage (`~/.orca/oah/`):** Directory mode `0700`, files mode `0600`.
- **No shell interpolation:** Runs external CLIs (`orca`, `claude`, `git`) via argument arrays only.

## Known Limitations

- Closing a pane stops background shell jobs or dev servers running inside that pane.
- Codex, Antigravity, OpenCode, and Devin start a new session with a ≤4,096-char summary at real limits only.
- Antigravity direct quota checks apply to the account signed in on this Mac; other saved profiles fall back to Orca's cached readings.
- Scroll position is not preserved across pane hand-offs.
- The Claude console status line is a POSIX `sh` script (macOS/Linux/WSL).

## Develop

```sh
npm run test:cli                 # standalone Node tests
npm run test:plugin              # full test suite via `orca plugin test`
npm run typecheck                # strict TypeScript check (zero npm deps)
npm run validate                 # validates orca-plugin.json
orca plugin check . --json       # renders the panel against the real worker
```

## License

MIT — see [LICENSE](LICENSE).
