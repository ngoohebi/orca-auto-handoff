# Auto Hand-off (Orca plugin)

**Hit a rate limit? Auto-switch to your next account.** Automatic account switching for Orca agents. When a Claude, Codex, Antigravity, OpenCode or Devin account hits a limit, Auto Hand-off moves the session to your next account and keeps working. Claude stays Claude, Codex stays Codex: a session always keeps its provider.

Product page: <https://ngoohebi.github.io/orca-auto-handoff/>

## Quick start

1. Add at least two accounts of one service in Orca (Settings → Accounts), for example two Claude
   accounts.
2. Install the plugin:

   ```sh
   orca plugin install ngoohebi/orca-auto-handoff
   ```

   Orca lists the access it asks for and prints the same command with `--approve <fingerprint>`;
   run that to approve (see [Permissions](#permissions)). To try a local checkout instead, run
   `orca plugin dev load . --json` from its folder.
3. Open the **Auto Hand-off** panel. It lists your accounts per service with their usage. That is
   all: the default mode, Smart, needs no settings.
4. Work as usual. When a session hits a limit, it moves to your next account of the same service
   and carries on. The panel's History says why, in one line per move.

To stop it, use the *Automatic hand-off* toggle at the top of the panel (pause), or the switch on
a service's card. To move by hand, press *Hand off to this account* on an account's card.
Before relying on it, read [Known limitations](#known-limitations).

Runs Orca's managed agent accounts as one pool, like [cux](https://github.com/inulute/cux) does for
Claude Code, but inside Orca and for every provider Orca manages: Claude, Codex, Antigravity,
OpenCode and Devin. When an agent pane hits a rate limit, or a usage threshold you set, the plugin:

1. puts that account on cooldown until the limit resets,
2. picks the next healthy account,
3. runs `orca account select`,
4. closes the limited pane,
5. resumes the same session (`agent.resume`),
6. types the configured first message ("Continue." by default), when a limit interrupted the
   work. A session that had finished its turn and was moved early is resumed and left ready.

When every account of the provider is exhausted it parks the session and resumes it when the
earliest limit resets. It only ever switches between accounts of the **same service**: a Claude
pane moves to another Claude account and a Codex pane to another Codex account, never across
services. Where the service cannot resume a session by id on another account (Codex, Antigravity,
OpenCode, Devin), the same agent is started on the next account with a handoff prompt: why the
previous run stopped, the session title, branch, `git status`, `git diff --stat` and the last output.
That is a **new session that starts from a summary**: the earlier conversation is not carried
over. So for these services a running session moves only when it has hit a real limit (or when
you move it by hand); the early, idle, expiring-quota and switch-back moves described below apply
to Claude sessions only, which resume as the same session with their context.

Usage numbers come from Orca itself (`orca account list --json` → `rateLimits`). The plugin never
reads tokens or keychains.

**Projects on a paired Orca server.** Managed accounts belong to the Orca that runs the agent, so a
project on a paired server (Orca host `runtime:<server>`) has its own accounts and its own active
selection. The plugin follows the project: the panel lists that server's accounts and names the
server, and a pane there is switched, closed and resumed with that server's accounts. Each server's
accounts are cached separately, and so is what the plugin remembers about them: cooldowns, strikes,
probation, accounts left as Low and the 5-minute selection cooldown are kept per server, so a limit
or a switch on a paired server never holds back the accounts of this computer. A choice you make
by hand (the panel's switch, the next-account command) applies to the server of the project in
focus when you made it, also when you move on to another project while it is carried out. Since the `orca account` commands refuse `--environment`, the
worker reaches a paired server through Orca's own runtime client (see *Permissions*). A project on
a direct SSH target (host `ssh:<target>`) is different: its agents run with that machine's own
login and Orca manages no accounts for it, so the plugin leaves those panes alone, notes a limit
there in the history instead of switching, and the panel says so.

## Smart (the default)

Out of the box, Auto Hand-off runs in **Smart** mode. You do not have to set anything up.

**What it does, in plain words**

- **It looks ahead.** The plugin watches how fast each account is being used. When an account is
  about to run out (about 10 minutes left at the current pace), it moves your session to another
  account *before* the limit is hit, so a turn does not fail halfway.
- **It only moves a session at a safe moment.** That is between two turns, or when the session
  has been sitting idle for 15 minutes. It never interrupts a turn that is running, and it never
  closes a session that has text typed in its input box but not sent yet. That holds at a limit
  too: you are told once, and the session moves as soon as you have sent or cleared the text.
- **It moves one session at a time.** Only the session whose turn just ended moves. Your other
  sessions follow when their own turn ends or when they are idle.
- **It moves early only where nothing is lost.** Leaving an account before its limit, moving an
  idle session, using quota that is about to expire and going back to an earlier account apply
  to Claude sessions, which resume as the same session. Codex, Antigravity, OpenCode and Devin
  sessions would start over from a summary, so they move only at a real limit; for them, only
  the account for new sessions changes ahead of time.
- **It does not set a finished session to work.** "Continue." is typed only after a limit or
  an API error interrupted the work, or when a session that waited for a reset wakes up. A
  session that had finished its turn and was moved early, when idle, for expiring quota or back
  to an earlier account is resumed and left ready for you.
- **When it cannot check, it does not act.** If Orca cannot be asked whether a session is in the
  middle of a turn, or what its input box holds, the session is treated as busy or as holding
  unsent text: it is not closed and not typed into. A limit move then waits and is carried out
  once Orca answers; you are told once.
- **It picks the account that will last.** The next account is one the plugin has numbers for,
  with enough room to last at least half an hour at its pace (counting the sessions already
  running on it). Among those it prefers your own order if you set one, then quota that is about
  to expire, then the account whose week resets sooner, then the one with the most room.
- **It uses quota before it expires.** If an account still has plenty of its weekly quota left
  and that week ends within two days, idle sessions and new sessions go there first, because
  unused quota is lost at the reset.
- **It does not bounce back and forth.** An account it left because it was running low is not
  gone back to by an early or idle move, nor selected again for new sessions, until that
  account's 5-hour window has reset (or a fresh reading shows it has started again). Only a
  session stopped by a real limit may still be moved there, when no other account with known
  room would last.
- **It waits when waiting is cheaper.** A session that is moved has to re-read its whole
  conversation on the new account. If the account it is on resets within 5 minutes, the session
  simply waits and carries on there.
- **It tells you why.** Every move has a one-line reason in the panel's History and in the
  notification, for example: "work had about 8 min left at this pace (5h 94 %); moved to personal
  (5h 12 %, weekly resets in 9 h)".
- **It stays inside one service.** A Claude session only ever moves to another Claude account,
  a Codex session to another Codex account.
- **Off means off.** The *Automatic hand-off* toggle (pause) and the per-service switches stop
  every automatic action.

**The four settings**

| Setting | Choices (default first) | What it means |
|---|---|---|
| **Auto-switch** (`mode`) | `auto`, `smart`, `my-order`, `manual`, `custom` | `smart`: as described above. `my-order`: follow your *Account order*, and go back to an earlier account when it is free again; it also leaves an account shortly before it runs out. `manual`: never switch by itself. `custom`: use the *Advanced* settings exactly as set (see below). `auto` picks for you: Smart, unless you changed the advanced settings in an earlier version |
| **Switch early** (`switch_early`) | `just-before`, `earlier`, `at-limit` | How soon to leave an account that is running out: about 10 minutes before the limit; about 25 minutes before; or only once the limit is reached |
| **Running sessions** (`running_sessions`) | `move`, `limit`, `launches` | `move`: sessions move between turns or when idle. `limit`: a session moves only when it actually hits a limit. `launches`: running sessions are never moved; only new sessions start on another account |
| **When everything is used up** (`when_all_used`) | `wait`, `stop` | `wait`: the session waits for the first account to reset and resumes by itself. `stop`: it stops and you are told |

When the pace of an account is not known yet (it needs a few minutes of readings), "about to run
out" means 97 % of the 5-hour window or 99 % of the week (`earlier`: 90 % and 97 %).

**Why Orca may ask you to restart sessions**

Orca has one selected account per service, and new sessions start on it. Whenever that selection
changes, Orca itself shows a prompt like "2 Claude sessions are still running on *work*.
Restarting continues the conversation on *personal*. … [Restart 2 sessions]". Auto Hand-off cannot
turn this prompt off, and it also appears when the plugin changes the selection.

**You do not need to press Restart.** Your running sessions keep working on the account they are
on, and the plugin moves each one by itself at a safe moment. Pressing Restart would stop busy
sessions in the middle of their work. The plugin's own notification says why it changed the
account, and it changes the selection alone (without moving a session) at most once every
5 minutes, and only when a session is in the middle of a turn (working, or waiting for you to
answer a permission question) on an account that is running out, or when another account has quota about to expire.

**Coming from an earlier version?** With *Auto-switch* on `auto`, your earlier settings decide:

| Your earlier settings | Mode |
|---|---|
| Nothing changed | Smart |
| An account order (`chain`) with strategy `drain` or `priority` | Follow my order |
| Strategy `manual` | Manual |
| Anything else changed (another strategy, switch-back off, a different cooldown or gap, …) | Custom: everything works exactly as before, and the panel says so once |

A threshold below 100 % is kept as a hard cap in Smart and Follow my order, and selects
*Switch early: earlier*.

**Model limits.** When a session hits the limit of one model (for example the weekly Fable
limit), Smart first looks for another account that is known to have room for that model. If there
is none, it switches to the next model from *Model fallback* on the same account. If there is
none of those either, it moves to the next account that is not known to be full for that model
(Orca seldom reports that number for an account not in use, and the limit's own reset can be days
away). An account that then shows the same limit is set aside in turn, so each is tried at most
once. Only when every other account is known to be full for that model, or is cooling down, does
the session wait, until one of them is free or the limit resets.

## What it does

The table below lists every trigger. Rows that mention thresholds, strategies or switch-back describe the *Advanced* settings, which apply as set in `custom` mode; Smart and Follow my order set them for you (see [Settings](#settings)).

| Trigger | Action |
|---|---|
| Rate-limit banner in the pane's latest output | Cooldown that seat until the parsed reset time (else Orca's `resetsAt`, else *Default cooldown*), switch, resume. The next account is one with known room if there is one, else one presumed reset, else one without numbers |
| Banner with no reset time on an account without usage numbers | A *strike*: the cooldown is *Default cooldown* × 2 per strike (60, 120, 240 min …), at most 5 h. Strikes count for 24 h |
| Model-specific cap (e.g. Claude Fable weekly) | Smart and Follow my order: an account known to have room for that model, then `/model <next>` from *Model fallback* in place, then an account not known to be full for that model, then wait. Custom: `/model <next>` first; switch accounts only when the list runs out. `/model` is never typed into a pane whose input box holds unsent text (you are told instead), nor into a turn you started meanwhile (its end is handled as a new event) |
| API error (529, overloaded, stream disconnected) | Type the first message again after a Fibonacci backoff (5 s … 120 s), up to *Maximum API error retries*. Only while the pane is still between turns and the error is still its latest output (if you went on meanwhile, what the pane shows now is handled instead), and never into an input box that holds unsent text; you are told instead |
| Auth failure | 12 h cooldown on that seat, switch |
| A turn ends while the seat is over a threshold (Claude) | Switch to an account with known room (thresholds default to 100 %, so this is reactive only); the seat left stays out of rotation until that window resets. An account without numbers is taken only when the current one is known to be at 100 % and no known account is left |
| Every seat limited | Park; wake when the earliest seat frees up (*Wait for reset*). Carry on in the parked pane yourself and the wait ends. Close the parked pane yourself and the wait is dropped when it comes due: the session is not resumed, and History notes it in one line (`closed`), without a notification |
| A limit, or the wake of a parked session, finds unsent text in the pane's input box | The pane is not closed. The limited account is still set aside, History notes the wait once, and you are told once: "Claude hit its limit on *account*. Send or clear the text you were typing and the session moves to *target*." The plugin looks again at every status event and timer tick and carries out the move once the text is gone; the panel lists the session under *Waiting*, where *Cancel* drops the move. Send the text instead and that turn is handled like any other |
| A higher-priority account is healthy again | **Switch back:** select it for new launches; sessions on lower accounts move back when they finish a turn or sit idle. Running sessions move only to an account that is known or presumed reset |
| A session idles on an over-threshold account (Claude) | Move it after *Move idle sessions after* seconds (900 by default; 0 = off), under the same rule as a threshold move |
| The plugin just moved onto an account without numbers | *Probation* for max(10 min, 2 × the selection cooldown): no threshold, idle or switch-back move for that service, and a banner on that account is a strike |
| `orca account select` fails for an account | Skip that account for 10 minutes, take the next |

Detection runs when a pane turns `done` or `waiting`. A banner only counts when all of these hold:

- it is among the last five meaningful lines, because an agent that stopped on a limit stops there;
- it has the shape of a CLI status line: Claude `⎿` or unindented system lines, or the error
  markers other CLIs use (`■`, `⚠`, `error:`, …);
- it is not an input line (`❯`, `›`, `>`), TUI frame or footer, a row of the plugin's own console
  status line, or one of Claude's own `⏺` replies.

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

**`auto_resume` off** (`custom` mode), or **Running sessions: `launches`:** the plugin only
switches the account for new launches and tells you. The limited pane stays as it is for you to
resume. The notification names the setting that keeps it there ("… because Running sessions is set
to new launches only", or "… because Resume the session after a switch is off").

**Auto-switch `manual`:** a limit is noted in History and you are told ("Claude hit a limit on
*account*. Auto-switch is set to manual, so nothing was switched."); nothing is selected, closed
or resumed.

**On/off per service.** Each service has its own switch: on its card in the panel, or as
*Auto hand-off Claude/Codex/Antigravity/OpenCode/Devin accounts* in Settings. All are on by default.
For a service that is off, the plugin never closes, switches or resumes its panes, and its parked
sessions stay parked. Manual switching from the panel or the commands still works. The status bar
shows it as `Codex off`. The *Automatic hand-off* toggle at the top pauses every service at once.

Strategies (`custom` mode): **drain** (next account in chain order; the default there), **balanced** (most room),
**priority** (always the first healthy account in the chain), **soonest-reset** (the account whose
weekly window resets first, so expiring usage is spent first), **manual** (never automatic).
A strategy orders accounts with the same amount of information; an account with known room always
comes before one without numbers (see [Usage of accounts not in use](#usage-of-accounts-not-in-use)).

**Switch back** (on by default; drain and priority, where the chain is a priority order): once an
account earlier in the chain is out of cooldown and under its thresholds, the plugin selects it
again so new launches use it, and moves sessions that are still on lower accounts back to it when
they finish a turn, or once they have been idle for *Move idle sessions after* seconds. The same
close → resume as any other swap, without the first message: the session had finished its turn,
so it is left ready. Only sessions that resume by session id (Claude) move back; for the other
services only the selection for new launches does. A running session moves back only to an account
with known room, or one presumed reset. The selection for new launches also moves to an account
without numbers, as long as it has no strikes.

**Unsent text** is a guard on every automatic move, a hard limit and the wake of a parked session
included: a pane whose input box holds unsent text is never closed. An advisory move is dropped
and considered again at the next turn end or idle check; a limit move stays pending until the
text is sent or cleared (see the table above). The *Move this workspace's agent to another
account* command leaves such a pane alone as well, and says so. The panel's *Hand off to this
account* asks instead: after *Yes, hand off* it changes nothing and shows a second confirmation in
the same block, "This session shows unsent text: “…”. Hand off anyway? The text will be cleared.",
with the text (the first 80 characters). *Cancel* leaves everything as it was: no account is
selected and the session stays. Only *Hand off anyway* moves the session, and the text is lost with
the closed pane. The answer covers only the session and the text that were shown: if the text
changed meanwhile, the panel asks again with what is there now. No automatic move ever gives text up this
way, and the answer lifts no other guard: like every other move, these never close a pane that
is in the middle of a turn, and a limited account is still refused. The plugin asks Orca for
that text (`orca terminal read --json`, field `draft`) and also looks at the input line on
screen. If Orca cannot be asked (the command fails, times out or gives no usable answer), the
pane counts as possibly holding unsent text, because the screen leaves that text out: an
advisory move is skipped, a limit move waits ("Orca could not be asked whether the session is
between turns with an empty input box, so it was not moved. It moves to *target* once that can be
checked."), nothing is typed, and *Hand off to this account* and the move command say that they
could not check the session and move nothing. The same holds when Orca cannot list the agents:
the pane counts as possibly in the middle of a turn. Orca reports Claude Code's own grey
texts in the same field. "Press up to edit queued messages" counts as unsent input on purpose:
it means messages you queued are waiting to be sent, and closing the pane would lose them. A grey prompt suggestion ("keep going") cannot be told from typing and counts as
unsent text (see *Known limitations*). The same holds for the first message after a move: if
you are already typing in the resumed pane, or have sent something there, it is not typed, and
the notification says the session is left for you to continue. A first message that cannot be
typed at all (the new pane is gone, or the CLI fails) is said the same way; the move itself
stands, and the account moved to is not set aside. A session that waited for its own account to
reset (the short wait) is likewise not typed into when you started a turn there meanwhile.

**Guards on advisory moves** (threshold, idle, switch-back; hard limits ignore these two, and so
does a move you ask for yourself from the panel or the command). Advisory moves of a running
session apply only to a session that resumes by session id (Claude, with a session id from
Orca); for a handoff-only service they change at most the selection for new launches:

- the target needs at least *Minimum headroom gap* (10 %) more room than the current account when
  both are known, and an exhausted account may always leave; a target without numbers never counts
  as having more room. When Smart or Follow my order leaves an account because it is about to run
  out, that account counts as having no room left: the target then needs at least that much room
  (10 %) in its fullest window;
- one provider's selection changes automatically at most once per *Minimum minutes between
  automatic selection changes* (5), so two accounts near the line never ping-pong. Moving a pane
  onto the account that is already selected is not a selection change.

**Never switch to:** accounts listed in `exclude` (same tokens as `chain`) are kept out of
automatic rotation and switch-back; picking them from the panel still works.

## Settings

**The four settings** (see [Smart](#smart-the-default)): *Auto-switch* (`mode`), *Switch early*
(`switch_early`), *Running sessions* (`running_sessions`), *When everything is used up*
(`when_all_used`).

**Always apply**

| Setting | Default | Meaning |
|---|---|---|
| `service_claude`, `service_codex`, `service_antigravity`, `service_opencode`, `service_devin` | on | Automatic hand-off per service |
| `chain` (*Account order*) | empty | Your own order of accounts. Empty = Orca's order |
| `exclude` (*Never switch to*) | empty | Accounts automatic hand-off never picks |
| `auto_message` | `Continue.` | First message typed after a move that a limit or API error caused, or when a waiting session wakes. Not typed after an early, idle, expiring-quota, switch-back or manual move. Empty = resume silently |
| `model_fallback` | empty | Models to try on the same account when one model's limit is hit, e.g. `claude=sonnet,haiku` |
| `retry_on_api_error`, `max_api_retries` | on, 6 | Retry in place on API errors |
| `default_cooldown_minutes` | 60 | Used when nothing says when a limit resets |
| `poll_interval_seconds` | 60 | How often usage is read from Orca |
| `usage_cache_max_age_hours` | 168 | How long the last reading of an account not in use is remembered |
| `handoff_max_chars` | 6000 | Size limit of the handoff prompt |
| `orca_cli_path` | empty | Empty = detect |
| `console_statusline_format`, `console_statusline_bar_width` | empty, 8 | The console status line |

**Advanced** (titles start with "Advanced:"). These are the settings of earlier versions. They are
read **only when *Auto-switch* is `custom`**; in every other mode the four settings above decide
and these are ignored.

| Setting | Default | In Smart / Follow my order |
|---|---|---|
| `strategy` | `drain` | Smart ranks by itself; Follow my order uses `drain` (or `priority` if that was set) |
| `switch_back` | on | Off in Smart, on in Follow my order |
| `switch_cooldown_minutes` | 5 | 5 |
| `min_headroom_gap` | 10 | 10 |
| `auto_swap_idle_after_seconds` | 900 | 900, or off unless *Running sessions* is `move` |
| `auto_switch_on_rate_limit` | on | on |
| `auto_switch_on_threshold` | on | on only when *Running sessions* is `move` |
| `thresholds_five_hour`, `thresholds_seven_day` | 100 | 100; with `auto`, a stored value below 100 stays as a hard cap |
| `auto_resume` | on | on, unless *Running sessions* is `launches` |
| `wait_for_reset` | on | *When everything is used up* |

## UI

- **Status bar:** `Claude 2/3 · 7%·18% | Codex 1/3 · 0%`. The tone turns to warning at 80 % and to
  danger while a session is parked. Click it to move Claude to the next account. A selection
  made this way (or with the commands) is not changed again by advice (switch-back, a Low
  account, expiring quota) until the switch cooldown has passed; a limit is still handled at
  once. With switch-back on, the plugin then returns to the earlier account in your order: use
  the panel's *Hand off to this account* for a choice that stays.
- **Panel** (gauge icon, right sidebar), laid out after Orca's own style guide (quiet and
  monochrome, colour only for state):
  - one section per service, in Orca's order except that the service of the agent in the current
    terminal tab comes first, marked *this terminal* (switching tabs raises no event, so while it
    is open the panel asks again 3 seconds after each answer, and less often, up to every 15
    seconds, while the tab stays the same; one check runs at a time); each sits on a band
    washed in the tone nearest its brand with a brand-coloured rule under its name, a status
    light, "n of m ready" and, when it has more than one account, that service's auto hand-off
    toggle; the Claude section also has a
    *Status line* switch that installs or removes the console status line in the focused
    workspace (the same as the install and remove commands); it follows the focused workspace as
    you change it, and where the line cannot be installed (no focused workspace, or one that is
    not on this computer) the switch is disabled and one muted line says why;
  - each account, the one in use first, then the usable ones with the most headroom first, then
    the drained and limited ones; each with a status light (solid green in use, hollow green
    ready, amber low, red limited or drained, grey idle), its 5-hour, weekly and model windows as
    "% left" plus the reset time on the same bar Orca's account switcher draws (green, yellow
    from 80 % used, red from 90 %), and *Clear* on a cooldown;
  - on each standby account, *Hand off to this account*, which asks first: new sessions of that
    service start on it, and the session in the current tab moves there too when it is between
    turns, whatever the headroom of the account you chose. A pane that is working keeps its
    account, and the panel says so; it is not moved later. When the session shows unsent text,
    nothing is switched yet and the block asks once more, showing the text: *Cancel* changes
    nothing, *Hand off anyway* moves the session and the text is cleared. This move is yours, so it also happens with *Running sessions*
    on `launches` or `auto_resume` off. Automatic hand-off for that service turns off as soon as the
    account is selected, so
    the plugin never undoes a choice you made by hand: no switch-back, no threshold or limit
    handling, until you turn *Auto hand-off* for the service on again. The block says so while it
    is off, and a desktop notification reminds you at the time. A limited standby cannot be
    chosen until its cooldown is cleared. The panel then says what the switch did; if only the
    re-read of the list afterwards fails, it says so apart from that ("Couldn't refresh the
    list; it updates shortly."), never as a failed switch. Otherwise the panel only
    displays: other selection changes come from the plugin, the status-bar click or the commands;
  - the automatic-switching toggle and when usage was last read;
  - parked sessions;
  - under an account's bars, "About 8 min left at this pace" when its last readings show a pace
    (see [Pace of use](#pace-of-use)); amber at 30 minutes or less, red at 10;
  - swap history: the last 7 days, older entries are cleaned up automatically (at most 1,000 kept).
    What the plugin remembers per pane (its account, handled banners, retry counts) is dropped
    once Orca has not listed the pane for 30 minutes, checked at most every 10 minutes while the
    focused project is on this computer, and each such list keeps at most 500 entries.
    Each move, wait and selection change says why in one line, for example "work is over its
    usage threshold (used 97 % of 5h, 40 % of the week); moved to personal (used 12 % of 5h)".
- **Commands:** switch Claude or Codex to the next account, move this workspace's agent to
  another account, pause or resume, refresh usage, install or remove the console status line. With several agents in the
  workspace, the move command takes the one in the terminal tab in front.
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
`.claude/settings.local.json` (project settings win over the user settings Orca manages). Only for
a workspace on this computer: one on an SSH target or a paired Orca server is left alone: the
command says so, and the panel switch is unavailable there. The wrapper still forwards every payload to Orca's hook, then prints one row per account of the pane's
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
`⏸1h20m` at the end of a row is a cooldown. Rows are in the panel's order: the account in use
first, then the usable ones by headroom. The
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
which macOS ships; a sed fallback covers machines without it). It also leaves the pane's own usage
numbers for the plugin (see [Usage of accounts not in use](#usage-of-accounts-not-in-use)). *Remove the console status line
from this workspace* restores whatever `statusLine` the file had before, and deletes the file when
the wrapper was all it held.

## Provider notes

- **Claude:** resumes by session id. Every Orca Claude profile's `projects/` is a symlink to
  `~/.claude/projects`, so the transcript is visible from every account. Usage for an inactive
  account can be unknown until it runs; such an account is a last resort, not an equal choice.
  With the console status line installed, every account that runs in a pane reports its own usage.
- **Codex:** each Orca Codex account keeps its own `sessions/`, so a session may not exist on the
  next account. Codex moves by handoff until cross-account resume is verified. A Codex profile that
  routes to another backend (such as Ollama Cloud) reports billing limits as
  `stream disconnected … Add usage credits`, which the plugin treats as a rate limit.
- **Antigravity, OpenCode, Devin:** move by handoff. OpenCode and Devin report no usage, so only
  rate limits trigger a switch for them, and their accounts are always "without numbers". Antigravity's own host login shows in the panel with its
  usage even when no managed account exists, so you can watch it; with one account there is
  nothing to switch to.

## Verified live (Orca 1.4.261)

A scratch Claude agent printed a `5-hour limit reached ∙ resets 3pm` line. The plugin then:

- cooled the account down until 3pm,
- ran `orca account select` for the next account,
- closed the pane,
- `agent.resume`d the same session on the new account,
- typed "Continue.", which the agent answered.

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
- **Unsent text (Orca 1.4.263):** `terminal.read` gives the rendered screen with the text typed in
  an agent's input box taken out (the box reads as empty); `orca terminal read --json` reports
  that text apart, as `draft`. The plugin therefore asks the CLI before every move or typed
  message. The same field carries Claude Code's grey prompt suggestion (seen live: "keep going",
  "push it") and its fixed hints, with nothing that marks them as not typed.
- **Console status line rows (Orca 1.4.263):** the screen read includes the rows the console status
  line prints under the input box. They are skipped like the rest of the footer, so they neither
  hide a banner above them nor an unsent line.

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

## Usage of accounts not in use

Orca checks usage of the account *in use* about every 5 minutes, while its window is open. It
fetches the other accounts only when its usage view opens or right after an account switch. An
inactive Claude account whose sign-in token has expired reports nothing until Claude runs on it
again; Orca deliberately does not refresh that token itself.

So the plugin remembers the last reading Orca gave for every account (setting *Remember usage of
accounts not in use*, default 7 days) and shows it with its age:

- in the panel, "Last reading 2h ago";
- in the status bar, `~` in front of the numbers.

A window whose reset time has passed shows as 0 %, "reset since". These remembered numbers also
count when the plugin chooses the next account, so an exhausted account that is not in use is no
longer mistaken for a free one.

**Numbers from the panes themselves.** Claude Code gives every pane's status line the limits of the
account that pane runs on. With the [console status line](#console-status-line) installed, the
wrapper leaves them in `~/.orca/account-rotator/live/claude-<profile id>.tsv` (`claude-system.tsv`
for Claude's own login): one line with the time of writing, the 5-hour and 7-day percent used and
their reset times. Numbers only: no name, email, path or token. The worker reads these files on
every usage read, so a Claude account that runs in a pane but is not the selected one has current
numbers too:

- the newer of Orca's reading and the pane's is used; a pane reading at most 10 minutes old counts
  as live, an older one as a remembered reading;
- the model window (`fable`, …) still comes only from Orca;
- several panes of one account each report the limits of their own last answer, so within one
  window (the same reset time) usage never goes down, and a pane that only knows a window that has
  ended does not undo the current one;
- the wrapper writes at most once a minute while the numbers are unchanged, never for a background
  job (`CLAUDE_JOB_DIR`) or a config dir that is no Orca profile, and a failed write never touches
  the line;
- reading is passive: it also happens while hand-off is paused or the service is off, and it
  switches nothing by itself. Accounts on a paired Orca server are not covered.

### Pace of use

Every usage read also adds a sample to a short history per account (this computer's accounts):
the percent used of each window, its reset time, and whether Orca or a pane took the reading. A
sample is kept when a number changes, or every 5 minutes otherwise; the last 48 samples (about
4 hours) and 14 daily weekly levels are kept, about 4 KB per account, under the plugin's own
storage key `usage-samples`. When a window's reset time changes, that window's samples are dropped.

From it the plugin works out a **rate** per window (the rise over the last 30 minutes; it needs two
samples at least 3 minutes apart and a rise of a point) and a **runway**: how long until the first
window is used up at that rate. A window that resets before it would run out, or that has reset since the last reading, does not
count, and a
reading more than 10 minutes old gives no runway. The panel shows it as "About N min left at this
pace". Smart and Follow my order act on it: see [Smart](#smart-the-default).

When there is no reading at all, the panel says why, in Orca's terms: "Updates the next time this
account runs", "Sign in to this account again in Orca", "Usage check is throttled for now; the
account itself may be fine", or Orca's own
message.

### When there are no numbers

Without numbers the plugin cannot tell a free account from an exhausted one. It does not pretend
to. It sorts the accounts it could switch to by what it knows:

- **Known:** Orca's numbers, or a remembered reading, show room.
- **Presumed reset:** no numbers, but the account's last cooldown ended at a real reset time (from
  the banner or from Orca) and it has had no strike since.
- **Unknown:** no numbers at all.

What each decision does with that:

| Decision | Rule |
|---|---|
| A limit was hit | Known first, then presumed reset, then unknown with the fewest strikes. The strategy only orders accounts of the same kind, so drain and priority can leave chain order here; switch-back restores it. The session parks only when nothing is left |
| Threshold or idle move | Only to a known account. To a presumed-reset or unknown one only when the current account is known to be at 100 % and no known account is left |
| Balanced, soonest-reset | An unknown account no longer competes as "50 % used"; it comes after every known one |
| Switch back, running session | Only to a known or presumed-reset account |
| Switch back, new launches | Also to an unknown account without strikes. Only the selection moves, which is also what makes Orca fetch that account |
| Manual (panel, commands) | Unchanged: any account that is not cooling down or over a threshold |

The cost of a wrong guess is real: a session moved onto an unknown account that turns out to be
exhausted fails one turn, shows a limit banner, and is moved again. The plugin limits how often
that happens:

- **Strikes.** A banner without a reset time on an account without numbers is a strike, and so is
  any banner on the account under probation. With no reset time to go by, each strike doubles the
  cooldown: *Default cooldown* × 1, 2, 4 …, at most 5 h. Strikes outlast the cooldown and count
  for 24 h; struck accounts are tried last, and are not selected again by switch-back. A current
  reading that shows room, or a turn that finishes without a banner on that account, clears them.
- **Probation.** After an automatic move onto an account without numbers, the plugin makes no
  threshold, idle or switch-back move for that service for max(10 min, 2 × *Minimum minutes
  between automatic selection changes*). A real limit still moves the session on.

Limits of this: a strike is a guess about an account, drawn from one failed turn. An unknown
account that works is still unknown until Orca reports numbers for it. For OpenCode and Devin that
never happens, so their rotation is always reactive. Pausing, or switching a service off, stops
all of the above.

The plugin reads Orca's numbers every *Read usage from Orca every (seconds)*: default 60,
range 15–3600. A change applies immediately. Concurrent refreshes share one `orca account list`
call. After each switch the plugin makes, it reads again at about 8 and 70 seconds, because a
switch is what makes Orca fetch the accounts not in use. The plugin never reads tokens or
keychains. It does not force a usage refresh: on this computer it runs `orca account list`, and
for a project on a paired server it calls that server's `accounts.list` with
`refreshUsage: false, refreshStaleUsage: true`, which lets that Orca refresh readings it
considers stale itself, on its own schedule.

## Known limitations

These are known and not fixed. None of them loses typed text, interrupts a turn or crosses
services; most are rare. Read the first seven before you rely on the plugin.

- **Closing a pane also stops its background processes.** A move closes the session's terminal
  pane and resumes the session in a new one. Anything the agent left running in the old pane (a
  dev server, a watcher, a background shell job) ends with it.
- **A resume that fails after the close leaves the session closed.** Claude's pane is closed
  first, because Orca refuses to resume a session that still runs. If the resume then fails, the
  pane is gone; you are notified ("Swap to *account* failed: …"), History notes it, and you can
  reopen the session from Orca yourself. The conversation is not lost.
- **The move command picks the first idle agent when a plain shell tab is in front.** *Move this
  workspace's agent to another account* moves the agent in the terminal tab in front. If that tab
  is a plain shell, it takes the first agent of the workspace that is between turns, which may
  not be the one you meant.
- **The status bar click switches the Claude account at once.** It selects the next Claude
  account for new launches without asking, and Orca may then show its own "Restart sessions"
  prompt. You do not need to press Restart.
- ***Hand off to this account* turns automatic hand-off off for that service,** so the rotator
  does not undo your choice. The panel says so; turn the service's switch on again to resume.
- **The console status line needs `sh`.** It is a POSIX shell script, so it does not work on
  Windows (outside WSL).
- **Installing the console status line writes `.claude/settings.local.json` in the workspace's
  folder,** i.e. inside your repository. It is a personal settings file: make sure it is ignored
  by git there. Uninstall restores what was there.
- **A handoff starts a new session.** For Codex, Antigravity, OpenCode and Devin the next account
  gets a new session with a summary (up to *Handoff prompt size limit* characters), not the
  conversation. This happens only at a real limit or when you move the session by hand.
- **While Orca cannot be asked, nothing moves.** If `orca terminal read` keeps failing for a pane
  (or Orca cannot list its agents), a session stopped at a limit waits there until Orca answers
  again; the panel lists it under *Waiting*, where *Cancel* drops the move.

- **Claude's greyed prompt suggestion counts as unsent text.** After a turn, Claude Code can show
  a suggested next prompt in grey in the input box. Orca (1.4.263) reports it to plugins the same
  way as text you typed, so the plugin cannot tell the two apart and plays safe. A suggestion
  therefore still holds back automatic early moves: an early, idle, switch-back or
  expiring-quota move of that pane is skipped, and the move command says the pane "has unsent
  text" and leaves it. The panel's *Hand off to this account* asks instead: it shows the text and
  moves the session only after *Hand off anyway*. A real limit is not affected as far as known:
  Claude is not known to show a suggestion after a turn that failed on a limit. To get the
  automatic moves, turn *Prompt suggestions* off in Claude Code (`/config`).
- **No Claude hint is ignored yet.** Any fixed line Claude Code shows in an empty input box is
  treated as unsent text, like a suggestion, until a wording is confirmed harmless. "Press up to
  edit queued messages" is never ignored, because it means queued messages are waiting.
- **With unsent text showing, the panel cannot select an account for new launches only.**
  *Hand off to this account* then either moves the session in the tab (*Hand off anyway*) or changes
  nothing (*Cancel*). Change tabs, or use Orca's own account switcher, to select the account
  without moving that session.
- **Banner wordings are not all confirmed.** Only some limit messages were captured from the real
  CLIs; the others follow each CLI's known wording. If a CLI changes its message, that limit is
  not seen until the rules are updated. Many extra rows under the input box (for example a long
  list of running sub-agents) can also push a banner out of the last five lines that are read.
- **A model limit sets the whole account aside.** When one model's limit is hit on an account, or
  one model's weekly window is about to run out, the account as a whole cools down or counts as
  Low, also for sessions that use another model.
- **Events of a pane that is being handled are dropped.** While the plugin works on a pane (a
  move, or the wait before an API-error retry), further status events of that pane are ignored. A
  limit that shows up just then is picked up at the pane's next turn end.
- **A new session's account is taken from the project in focus.** The launch hook notes the
  account selected for the project you are looking at. A session started at that moment in a
  project on another Orca server can be noted on the wrong account until its first move or limit.
- **Two shortcuts on paired servers.** History entries do not say which server they belong to,
  so the guess "this unknown pane is still on the account just left" can use a move made on
  another server. And if you change to a project on another server while the idle check runs,
  that one check can look at the wrong server's accounts; the next check is right again.
- **Split terminal groups.** Orca does not tell plugins which pane has the keyboard. With two
  groups side by side, "the session in this tab" can be the agent of the same service shown in
  the other group.
- **At 1,000 history entries** (the most kept), the move command and *Hand off to this account* can
  answer "nothing to do" or "keeps its account" after a move that did happen. The move and the
  History list are right.
- **`custom` mode with `auto_resume` off and a threshold below 100:** you are told "new launches
  now use …" again at every turn end of a session that stays on the account over the threshold.
  The selection itself changes only once.
- **Pressing Restart in Orca's own prompt** has not been tested. The plugin may then still take
  those sessions to be on the old account until their next move or limit.

## Permissions

Orca asks you to approve the plugin's access. Beyond the host API, the worker runs the `orca` CLI
(`account select`, `account list`, `terminal close`, `terminal send`, `terminal read`, `terminal list`) and `git status` and
`git diff --stat`. It always uses an argument list, never a shell. The CLI is used because the host
API cannot select accounts, refuses to close or type into panes outside the focused workspace,
does not say whether a pane's input box holds unsent text (`terminal read` does; only its `draft`
field is used, and that text is only shown to you in the panel's second confirmation, never
stored or logged), and does not say which terminal tab is in front (`terminal list
--include-visual-layouts` does; read-only, for the panel's *this terminal* mark and for the pane
*Hand off to this account* moves).

For a project on a paired Orca server the worker loads two of Orca's own modules from the app
bundle: the runtime client (`app.asar.unpacked/out/cli/runtime/client.js`) and, before it, the
store helper it needs to run inside a plugin worker
(`app.asar.unpacked/out/shared/remote-runtime/host-store/runtime-environment-store-execution.js`,
of which it calls `environmentStoreRunsInline` and `useInlineEnvironmentStoreForCli`). It calls that server's `accounts.*` RPCs
(`accounts.list`, `accounts.selectClaude`, …) over the pairing saved on this computer, because the
CLI's account commands only answer for this computer. When the host API does not say which Orca a
workspace runs on, the same client is asked, read-only, for this computer's catalog of paired
projects and hosts (`mobileRelay.projectSections`, `mobileRelay.hosts.list`,
`mobileRelay.hosts.worktrees`, `ui.get`). Those modules are Orca internals, not a
published API: an Orca update can break the server path, in which case the panel shows the error
and this computer's accounts keep working.

The worker writes `status.tsv` and the wrapper script under `~/.orca/account-rotator/` and reads
the `live/` files the wrapper leaves there; the wrapper is the only writer of `live/`. `status.tsv`
holds your account names (emails), so it and the `live/` files are written readable by you only
(mode 0600, the folder 0700).

A handoff prompt (for services that cannot resume by session id) includes up to 40 lines of the
previous agent's output, so treat it like any pasted terminal output.

## License

MIT; see [LICENSE](LICENSE).

## Develop

```sh
orca plugin test . --json        # 272 tests: adapters (real captured banners), selector, usage cache, live usage, usage history, status line wrapper under sh, worker end to end, panel
orca plugin check . --json       # renders the panel with the real worker (reads your real accounts)
npx -p typescript tsc -p .       # type-check; src/node-shim.d.ts stands in for @types/node
orca plugin validate . --json
orca plugin dev load . --json    # needs --approve <fingerprint> the first time
orca plugin dev request . rotator.debug   # last status events, agents.list, workspace ids
```

Code layout:

- `src/adapters.ts`: per-provider banner rules and reset-time parsing.
- `src/accounts.ts`: parses `orca account list --json`.
- `src/selector.ts`: the chain, eligibility, tiers (known / presumed reset / unknown) and strategies.
- `src/engine.ts`: the swap logic, with every side effect injected.
- `src/cli.ts`: runs the `orca` CLI and `git`.
- `src/worker.ts`: wiring and the status bar.
- `src/panel.tsx`: the panel.
