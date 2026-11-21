# OAH — Orca Auto Hand-off (CLI + Thin Orca Plugin)

**Hit a rate limit? Auto-switch to your next account.** CLI-first automatic account hand-off daemon (`oah` / `oahd`) with a thin Orca sidebar panel and event bridge. When a Claude, Codex, Antigravity, OpenCode or Devin account hits a limit, OAH hands the session off to your next account and keeps working. Claude stays Claude, Codex stays Codex: a session always keeps its provider.

Product page: <https://ngoohebi.github.io/orca-auto-handoff/>

## Architecture

OAH is **CLI- and daemon-centered**:

- **`oahd` daemon** (`bin/oahd`): Owns all state, settings, usage cache, burn-rate history, and hand-off logic in `~/.orca/oah/` (`config.json`, `state.json`, `usage.json`, `samples.json`, `oahd.sock`, `0700`/`0600` permissions). Auto-starts on demand when `oah` or the Orca plugin connects.
- **`oah` CLI** (`bin/oah`): First-class command line (`--json` or human-readable) for local desktop, headless `orca serve` hosts, paired servers, scripts, and agents.
- **Thin Orca plugin** (`src/plugin/worker.ts` + `src/panel.tsx`): Zero business logic or local state — connects to `oahd.sock`, forwards `agent.status.changed` / `workspace.changed` / `agent.launch.before` events, exposes native `agent.resume` and desktop notifications to `oahd`, and renders the **OAH** panel directly from `oahd`'s live stream.

## Quick start

1. Add at least two accounts of one service in Orca (Settings → Accounts), for example two Claude
   accounts.
2. Use the **`oah` CLI** directly (requires Node.js ≥ 22.18, zero npm dependencies):

   ```sh
   ./bin/oah                    # auto-starts oahd and shows accounts, usage & cooldowns
   ./bin/oah refresh            # force Orca to refresh usage, then show status
   ./bin/oah use work@example.com
   ./bin/oah pause | ./bin/oah resume
   ./bin/oah config set timing at-limit
   ./bin/oah daemon status      # check oahd pid, uptime, socket & Orca bridge
   ./bin/oah help
   ```

   Every command accepts `--json` for machine-readable output.

3. (Recommended for desktop Orca) Load the thin **OAH** plugin so `oahd` gets instant event push, native Claude `agent.resume`, desktop notifications, and the sidebar panel:

   ```sh
   orca plugin install ngoohebi/orca-auto-handoff
   ```

   Orca lists the access it asks for and prints the same command with `--approve <fingerprint>`;
   run that to approve (see [Permissions](#permissions)). To try a local checkout instead, run
   `orca plugin dev load . --json` from its folder.
4. Open the **OAH** panel or run `oah`. The defaults (*Auto*, *Early when away*) need no settings.

## The `oah` CLI

```sh
oah [status] [--json]               # Accounts, usage, runway, cooldowns, waiting sessions
oah refresh [--json]                # Force Orca usage refresh, then status
oah history [--limit 50] [--json]   # Recent hand-off history
oah use <account> [--force]         # Select account + hand off on-screen session
oah handoff                         # Hand off focused workspace session
oah next [service]                  # Select next healthy account for new sessions
oah pause | oah resume              # Global automatic hand-off off/on
oah service <service> on|off        # Per-service automatic hand-off
oah skip <account> [on|off]         # Exclude/include account from auto-pick
oah clear <account>                 # Clear an account's cooldown
oah order up|down <account>         # Reorder custom order
oah config [get [key]]              # View settings (~/.orca/oah/config.json)
oah config set <key> <value>        # Change a setting
oah now | notnow | cancel <termId>  # Answer for a session waiting to hand off
oah statusline [status|install|remove]
oah daemon start|stop|restart|status|logs
oah debug [--json]                  # Daemon health and recent events
oah rpc <method> [jsonParams]       # Direct JSON-RPC passthrough to oahd
oah version [--json]
```

Set `OAH_HOME=/path/to/dir` to isolate daemon state, config, and socket (useful for testing or multiple profiles).

To stop it, use the *Automatic hand-off* switch at the top of the panel (pause), or the
*Automatic hand-off* switch of one service, on its own line in that service's section. To hand
off by hand, press *Hand off to this account* on an account's card. Before relying on it, read [Known limitations](#known-limitations).

Runs Orca's managed agent accounts as one pool, for every provider Orca manages: Claude, Codex, Antigravity,
OpenCode and Devin. When a session hits a rate limit, or (with *When to hand off: Early when away*,
Claude only) its account is about to run out, the plugin:

1. puts that account on cooldown until the limit resets,
2. picks the next healthy account,
3. runs `orca account select`,
4. takes a last look at the session's input box and closes its pane,
5. resumes the same session (`agent.resume`),
6. types the configured first message ("Continue." by default), when a limit interrupted the
   work. A session that had finished its turn and was handed off early is resumed and left ready,
7. puts back, unsent, any plain text you had typed in the input box and not sent yet (see
   [Unsent text](#unsent-text)).

When every account of the provider is used up the session waits and continues when the earliest
limit resets (or stops, with *When everything is used up: Stop*); if its own account resets first,
it simply continues where it is. It only ever switches between accounts of the **same service**: a Claude
session hands off to another Claude account and a Codex session to another Codex account, never across
services. Where the service cannot resume a session by id on another account (Codex, Antigravity,
OpenCode, Devin), the same agent is started on the next account with a hand-off summary: why the
previous run stopped, the session title, branch, `git status`, `git diff --stat` and the last output,
at most 4,096 characters (Orca takes no more).
That is a **new session that starts from a summary**: the earlier conversation is not carried
over. So for these services a running session hands off only when it has hit a real limit (or when
you hand it off yourself); the early, idle, expiring-quota and switch-back hand-offs described below apply
to Claude sessions only, which resume as the same session with their context.

Usage numbers come from Orca itself (`orca account list --json` → `rateLimits`). The plugin never
reads tokens or keychains.

**Projects on a paired Orca server.** Managed accounts belong to the Orca that runs the agent, so a
project on a paired server (Orca host `runtime:<server>`) has its own accounts and its own active
selection. The plugin follows the project: the panel lists that server's accounts and names the
server, and a session there is handed off, closed and resumed with that server's accounts. Each server's
accounts are cached separately, and so is what the plugin remembers about them: cooldowns, strikes,
probation, accounts left as Low and the 5-minute selection cooldown are kept per server, so a limit
or a switch on a paired server never holds back the accounts of this computer. A choice you make
by hand (*Hand off to this account*, the next-account commands) applies to the server of the project in
focus when you made it, also when you move on to another project while it is carried out. Since the `orca account` commands refuse `--environment`, the
worker reaches a paired server through Orca's own runtime client (see *Permissions*). A project on
a direct SSH target (host `ssh:<target>`) is different: its agents run with that machine's own
login and Orca manages no accounts for it, so the plugin leaves those sessions alone, notes a limit
there in History and in a notification instead of handing off, and the panel says so. When Orca
cannot say where a workspace runs, its sessions are left alone too, and asked about again at the
next check.

## How it decides

Out of the box OAH picks the next account by itself (**Auto**) and hands off **Early
when away**. While you are using Orca (and right after the plugin starts, since you are taken to
be here) a session hands off only at a real limit, so it is seldom moved under you. Once you have
been away for 10 minutes, Claude sessions hand off shortly before an account runs out, so work
does not stop at a limit. You do not have to set anything up. If you want sessions to hand off
only at a limit, also while you are away, choose **At limit**.

The badge next to the panel's title says what is happening now, with a mark in one fixed-width
slot so the text lines up:

| Badge | Colour | Meaning |
|---|---|---|
| ● Auto · Early when away · on | green | You are away: early hand-offs are on |
| ◐ Auto · Early when away · waiting | bright green ring | You are at Orca: early hand-offs wait for you to leave; the Settings tab says "Right now you are using Orca, so sessions hand off only at a limit." |
| ○ Auto · At limit | grey | Sessions hand off only at a limit |
| ■ Paused | amber | Automatic hand-off is paused |

With *Custom order* the text starts "Custom order"; it has no colour of its own. Four basic
settings, in the panel's Settings tab, change what runs:

| Setting | Choices (default first) | What it means |
|---|---|---|
| **Pick the next account** (`pick`) | `smart`, `my-order` | *Auto*: the account with the most room, judged by how fast each one is being used. *Custom order*: your ranking, set with the arrows in the Accounts tab; a session goes to the highest account in your order that has room, and goes back to a higher account once it is free again |
| **When to hand off** (`timing`) | `early`, `at-limit` | *Early when away*: once you have been away a while, Claude sessions hand off shortly before an account runs out, so work does not stop at a limit. While you are using Orca, sessions hand off only at a limit. Other services always hand off only at a limit. *At limit*: a session hands off only when it hits a limit; each account is used to the end |
| **When everything is used up** (`when_all_used`) | `wait`, `stop` | *Wait and resume*: the session waits for the first account to reset, then continues by itself. *Stop*: the session stops and you are told (also a session that was waiting on screen) |
| **Session on screen** (`active_terminal`) | `ask`, `careful`, `wait`, `now` | The session in the tab Orca is showing; you may be reading or typing in it, so it gets extra care. See [The session on screen](#the-session-on-screen) |

There is no manual or custom mode: to stop automatic hand-offs, turn off *Automatic hand-off* at
the top of the panel (every service) or a service's own *Automatic hand-off* switch. Everything
else is fine-tuning under *Advanced* (see [Settings](#settings)).

**What counts as you being here.** Sending or answering a prompt in the session on screen (a turn
the plugin did not start by typing into it within the last minute), typing in a waiting session's
input box, switching tab or workspace, using the Auto Hand-off panel, or running one of its
commands. A failed read of a pane is never taken as a sign of you.

**What it does, in plain words**

- **It hands off at the limit** (*At limit*, and *Early when away* while you are here). A
  session hands off when it hits a limit, and not before: none of the early, idle or
  expiring-quota hand-offs below happen.
- **Once you are away, it looks ahead** (*Early when away*, Claude). Early, idle and
  expiring-quota hand-offs (and changing the account for new sessions to spend expiring quota)
  start only after there has been no sign of you for *Start early hand-offs after you've been
  away* (10 minutes; 0 = always, even while you are here). The plugin then watches how fast each
  account is being used. When an account would run out within *Hand off this long before running
  out* (10 minutes) at its current pace, the session hands off *before* the limit is hit, so a
  turn does not fail halfway. While the pace is not known yet (it needs a few minutes of
  readings), "about to run out" means 97 % of the 5-hour window or 99 % of the week. *Always hand
  off below (% left)* (1 %) adds a fixed line: an account with less than that much of its 5-hour
  window left is left whatever its pace, since one big turn could use the rest (0 = by pace only).
- **It only hands off at a safe moment.** That is between two turns, or (*Early when away*) when
  the session has been idle for *Hand off idle sessions after* (15 minutes). It never interrupts a
  turn that is running. Plain text you typed and did not send goes with a Claude session and is
  put back, unsent (see [Unsent text](#unsent-text)).
- **It leaves the session on screen alone.** Every pane of the tab Orca is showing counts as the
  session on screen. It is never handed off early (unless *Session on screen* is *Move right
  away*); at a limit it is handled with care (see [The session on screen](#the-session-on-screen)).
- **It hands off one session at a time.** Only the session whose turn just ended hands off. Your
  other sessions follow when their own turn ends or when they are idle.
- **It hands off early only where nothing is lost.** Early, idle, expiring-quota and switch-back
  hand-offs apply to Claude sessions, which resume as the same session. Codex, Antigravity,
  OpenCode and Devin sessions would start over from a summary, so they hand off only at a real
  limit; for them, only the account for new sessions changes ahead of time.
- **It does not set a finished session to work.** "Continue." is typed only after a limit or
  an API error interrupted the work, or when a session that waited for a reset wakes up. A
  session that had finished its turn and was handed off early, when idle, for expiring quota or
  back to a higher account is resumed and left ready for you.
- **When it cannot check, it does not act.** If Orca cannot be asked whether a session is in the
  middle of a turn, or what its input box holds, the session is treated as busy or as holding
  unsent text: it is not closed and not typed into. A hand-off at a limit then waits and is
  carried out once Orca answers; you are told once. The same holds when Orca cannot give the
  plugin your settings, or while the upgrade from 0.2 cannot finish: nothing is handed off or
  resumed automatically, and the panel says so ("Auto Hand-off is waiting for Orca's settings",
  "Auto Hand-off is finishing the upgrade"). Both end by themselves; *Hand off to this account*
  still works.
- **It picks the account that will last.** *Auto*: the next account is one the plugin has
  numbers for, with enough room to last at least three times *Hand off this long before running
  out* (half an hour by default) at its pace, counting the sessions already running on it. Among
  those it prefers quota that is about to expire, then the account whose week resets sooner, then
  the one with the most room. *Custom order*: the highest account in your order that has room.
- **It uses quota before it expires** (Auto, Early when away, once you are away). If an account
  still has plenty of its weekly quota left (more than 15 %) and that week ends within two days,
  idle sessions and new sessions go there first, because unused quota is lost at the reset.
- **It goes back to your first choice** (Custom order). Once a higher account in your order is
  free again, new sessions start on it, and (Early when away, once you are away) Claude sessions
  on lower accounts hand off back when they finish a turn or sit idle.
- **It does not bounce back and forth.** An account it left because it was running low is not
  gone back to by an early or idle hand-off, nor selected again for new sessions, until that
  account's 5-hour window has reset (or a fresh reading shows it has started again). Only a
  session stopped by a real limit may still go there, when no other account with known room
  would last.
- **It waits when waiting is cheaper.** A session that is handed off has to re-read its whole
  conversation on the new account. If the account it is on resets within 5 minutes, the session
  simply waits and carries on there. Any waiting session whose own account has room again first
  continues where it is (all services), also when you have set that account to *Skip*.
- **It tries again when a hand-off fails.** If a hand-off at a limit fails before the session
  was closed, the next account is tried, up to three times.
- **It tells you why.** Every hand-off has a reason in words in the panel's History and in the
  notification, for example: "work had about 8 min left at this pace (5h 94 %); handed off to
  personal (5h 12 %, weekly resets in 9 h)". Notifications are kept under 1,000 characters, the
  most Orca shows.
- **It stays inside one service.** A Claude session only ever hands off to another Claude
  account, a Codex session to another Codex account.
- **Off means off.** Pausing, or a service's *Automatic hand-off* switch, stops every automatic
  action.

**Why Orca may ask you to restart sessions**

Orca has one selected account per service, and new sessions start on it. Whenever that selection
changes, Orca itself shows a prompt like "2 Claude sessions are still running on *work*.
Restarting continues the conversation on *personal*. … [Restart 2 sessions]". Auto Hand-off cannot
turn this prompt off, and it also appears when the plugin changes the selection.

**You do not need to press Restart.** Your running sessions keep working on the account they are
on, and the plugin hands each one off by itself at a safe moment. Pressing Restart would stop busy
sessions in the middle of their work. The plugin's own notification says why it changed the
account, and it changes the selection alone (without handing off a session) at most once every
*Minimum time between early hand-offs* (5 minutes), and only when a session is in the middle of a
turn (working, or waiting for you to answer a permission question) on an account that is running
out, when another account has quota about to expire (Auto, Early when away, once you are away),
or when a higher account in your order is free again (Custom order).

**Coming from 0.2?** Version 0.3.0 replaced the old modes and strategies (Auto-switch with
`auto`, `smart`, `my-order`, `manual` and `custom`; Switch early; Running sessions; the drain,
balanced, priority, soonest-reset and manual strategies; switch-back; thresholds; Switch on rate
limit; Switch at usage threshold; Resume automatically; Wait for reset; the idle time in seconds)
and removed *Retry on API errors* (now *API error retries*, 0 = never), *Minimum extra room*,
*Remember usage of other accounts* and *Status line bar width* (now fixed: 10 % extra room,
7 days, 8 cells; a bar width set in 0.2 still counts).

At the first start of 0.3.0 the plugin reads your 0.2 settings once, by name (Orca no longer
hands undeclared settings to a plugin by itself), and writes the new ones. A new setting you have
already changed is left as it is. The mapping:

| Your 0.2 setting | 0.3.0 |
|---|---|
| Auto-switch `my-order`, or an account order (`chain`) with strategy `drain` or `priority` where 0.2 used it | *Pick the next account: Custom order* |
| Switch early `at-limit`, Running sessions `limit` or `launches`, or *Switch at usage threshold* off where 0.2 used it | *When to hand off: At limit* |
| Switch early `earlier` (unless one of the above, which wins) | *When to hand off: Early when away*, with *Hand off this long before running out*: 25 |
| *Wait for reset* off where 0.2 used it | *When everything is used up: Stop* |
| *Retry on API errors* off | *API error retries*: 0 |
| Idle time in seconds, if not the default 900 | *Hand off idle sessions after* in minutes, rounded up |
| Anything else (the old default `just-before`, other strategies, thresholds, switch-back, …) | The defaults: *Auto*, *Early when away* |

"Where 0.2 used it": 0.2 applied its advanced settings only with Auto-switch `auto` or `custom`.
A setup that never handed off by itself (Auto-switch `manual`, or with `auto`/`custom` strategy
`manual`, *Switch on rate limit* off or *Resume automatically* off) has no setting for that any
more: automatic hand-off is paused once instead, with a notification; turn it on in the panel
when you want it. Until the upgrade has read and written everything, nothing is handed off or
resumed automatically and the panel says "Auto Hand-off is finishing the upgrade"; it tries again
by itself at every check.

**Model limits.** When a session hits the limit of one model (for example the weekly Fable
limit), the plugin first looks for another account that is known to have room for that model. If
there is none, it switches to the next model from *Model fallback* on the same account. If there
is none of those either, it hands off to the next account that is not known to be full for that
model (Orca seldom reports that number for an account not in use, and the limit's own reset can
be days away). An account that then shows the same limit is set aside in turn, so each is tried
at most once. Only when every other account is known to be full for that model, or is cooling
down, does the session wait, until one of them is free or the limit resets.

## The session on screen

Orca cannot tell a plugin whether you are in front of it. It does say which tab is shown in the
focused workspace, so every pane of that tab (also in split groups) is handled with care
(setting *Session on screen*):

- **It is never handed off early.** Early, idle, expiring-quota and switch-back hand-offs skip it
  (with *Move right away*, they do not). It hands off at a later chance, once it is no longer shown.
- **At a limit, with *Ask me first* (the default),** you are notified and the panel asks "Hand off
  the session on screen?" with *Hand off now* and *Not now*. *Hand off now* hands it off at once.
  *Not now* makes it wait until you switch to another tab, with no countdown. If you do not
  answer, it acts like *Wait, then count down*.
- **With *Wait, then count down*,** the plugin looks for signs of you (see [What counts as you
  being here](#how-it-decides)) within the last *Keep the session on screen waiting after your
  last activity* (300 seconds). While there are such signs, the session waits. Without them a
  countdown starts (*Countdown for the session on screen*, 60 seconds), with a notification; it
  runs out on time. A sign of you during the countdown stops it; it starts again once you have been
  away that long. When it runs out, the session hands off.
- **With *Wait for me*** there is no countdown: the session hands off once you switch to another
  tab, or when you press *Hand off now*.
- **With *Move right away*** the session is handed off like any other.
- While the session waits, the panel lists it in the *Waiting to hand off* box with *Hand off now*,
  *Not now* (wait for another tab, no countdown; not shown with *Wait for me*, which already does
  that) and *Don't hand off* (give up the hand-off). When *Hand off now* cannot hand off yet (the
  session is busy, automatic hand-off is paused or off for that service, …), the panel says why,
  and the session goes on waiting as before. Switching to another tab lets it hand off at the
  next check. With *When everything is used up: Stop*, a session waiting on screen that finds no
  account with room stops like any other.
- One reminder: when such a session has waited *Remind me when the session on screen has waited*
  (10 minutes; 0 = none), a notification says so.

When Orca cannot say which tab is shown, the session counts as shown.

## Unsent text

A pane is never closed while text is being typed into it. Before any pane is closed, its input
box is read twice, about a second apart, and once more right before closing; if it changed, the
hand-off is called off and tried again later (an early hand-off at the next turn end or idle
check, one at a limit at the next check, listed under *Waiting* meanwhile).

**Put unsent text back after a hand-off** (on by default, Claude only): plain text you typed and
did not send goes with the session. It is put back into the session's input box after the
hand-off, unsent, as one bracketed paste, so a line break in it does not send it; nothing is sent
until you press Enter. When a first message is typed after a limit, the text comes back a moment
after it, so it is not part of it. The notification quotes the text. If it could not be put back,
the notification quotes its first 300 characters, and History keeps the whole text in a box you
can copy from ("Your unsent text, not put back:").

Some text cannot go along, and keeps the session where it is until you send or clear it:

- text with placeholders for pasted content (`[Image #1]`, `[Pasted text #1 +40 lines]`), whose
  content stays in the old pane;
- text over 4,000 characters, or text holding an escape sequence;
- Claude's "Press up to edit queued messages": it means messages you queued are waiting to be
  sent, and closing the pane would lose them;
- any unsent text in a Codex, Antigravity, OpenCode or Devin session (they start a new session
  from a summary), and any unsent text at all with the setting off.

Such a session:

- is skipped by an early hand-off, which is considered again at the next turn end or idle check;
- at a limit, or when a waiting session is due, is not closed: the limited account is still set
  aside, History notes the wait once, and you are told once. The plugin looks again at every
  status event and timer tick and hands it off once the text is gone; the panel lists the session
  under *Waiting* ("… session hands off once the text typed in it is sent or cleared", or "… once
  its queued messages are sent or cleared"), where *Cancel* drops the hand-off. Send the text
  instead and that turn is handled like any other.

The *Hand off this workspace's session to another account* command leaves such a pane alone as
well, and says so. The panel's *Hand off to this account* asks instead: after *Yes, hand off* it
changes nothing and shows a second confirmation in the same block, "This session shows unsent
text that cannot go along: “…”" (or "This session has queued messages that would be lost."),
"Hand off anyway?". *Cancel* leaves everything as it was: no account is selected and the session
stays. Only *Hand off anyway* hands off the session, and the text is lost with the closed pane.
The answer covers only the session and the text that were shown: if the text changed meanwhile,
the panel asks again with what is there now. The answer lifts no other guard: like every other
hand-off, these never close a pane that is in the middle of a turn, and a limited account is
still refused.

The plugin asks Orca for that text (`orca terminal read --json`, field `draft`) and also looks at
the input line on screen. If Orca cannot be asked (the command fails, times out or gives no usable
answer), the pane counts as possibly holding text that cannot go along, because the screen leaves
that text out: an early hand-off is skipped, one at a limit waits ("… hands off once Orca can say
that it is between turns with an empty input box"), nothing is typed, and *Hand off to this
account* and the hand-off command say that they could not check the session and hand off nothing.
The same holds when Orca cannot list the agents: the pane counts as possibly in the middle of a
turn.

Orca reports Claude Code's own grey texts in the same field, and nothing tells them from typing.
A grey prompt suggestion ("keep going") is therefore handled like typed text: with *Put unsent
text back* on it goes along and may come back as real text (unsent, so nothing happens without
Enter); with the setting off it keeps the session where it is (see *Known limitations*). The same
holds for the first message after a hand-off: if you are already typing in the resumed pane, or
have sent something there, it is not typed, and the notification says the session is left for you
to continue. A first message that cannot be typed at all (the new pane is gone, or the CLI fails)
is said the same way; the hand-off itself stands, and the account handed off to is not set aside.
A session that waited for its own account to reset is likewise not typed into when you started a
turn there meanwhile.

The scroll position of the old pane is not kept: Orca does not tell plugins where a pane is
scrolled.

## What it does

The table below lists every trigger.

| Trigger | Action |
|---|---|
| Rate-limit banner in the session's latest output | Cooldown that account until the parsed reset time (else Orca's `resetsAt`, else *Cooldown when a limit gives no reset time*), hand off, resume. The next account is one with known room if there is one, else one presumed reset, else one without numbers |
| Banner with no reset time on an account without usage numbers | A *strike*: the cooldown is *Cooldown when a limit gives no reset time* × 2 per strike (60, 120, 240 min …), at most 5 h. Strikes count for 24 h |
| Model-specific cap (e.g. Claude Fable weekly) | An account known to have room for that model, then `/model <next>` from *Model fallback* in place, then an account not known to be full for that model, then wait. `/model` is never typed into a pane whose input box holds unsent text (you are told instead), nor into a turn you started meanwhile (its end is handled as a new event) |
| API error (529, overloaded, stream disconnected) | Type the first message again after a Fibonacci backoff (5 s … 120 s), up to *API error retries* (0 = never). Only while the pane is still between turns and the error is still its latest output, and never into an input box that holds unsent text; you are told instead. After the last retry you are told it is left for you |
| Sign-in failure | 12 h cooldown on that account, hand off |
| A turn ends while the account is about to run out (*Early when away*, you away, Claude) | Hand off to an account with known room; the account left stays out of rotation until that window resets. An account without numbers is taken only when the current one is known to be at 100 % and no known account is left |
| A limit hits the session on screen | Held as described in [The session on screen](#the-session-on-screen), unless that setting is *Move right away* |
| Every account limited | *Wait and resume*: wait; continue when the earliest account frees up. Carry on in the waiting pane yourself and the wait ends. Close it yourself and the wait is dropped when it comes due: the session is not resumed, and History notes it (`closed`), without a notification. *Stop*: the session stays where it is and you are told |
| A waiting session's own account has room again first | It continues where it is, on any service (History: "same account") |
| A limit, or a waiting session that is due, finds unsent text that cannot go along | The pane is not closed; the hand-off waits until the text is sent or cleared (see [Unsent text](#unsent-text)) |
| A hand-off at a limit fails before the session was closed | The next account is tried, up to three times; the panel says "… hands off in a moment, to another account" |
| A higher account in your order is healthy again (*Custom order*) | **Switch back:** select it for new sessions; with *Early when away* and you away, Claude sessions on lower accounts hand off back when they finish a turn or sit idle. Running sessions go back only to an account that is known or presumed reset |
| A session idles on an account that is about to run out, or another account's weekly quota would expire unused (*Early when away*, you away, Claude) | Hand it off after *Hand off idle sessions after* (15 min; 0 = never), under the same rules as an early hand-off |
| The plugin just handed off onto an account without numbers | *Probation* for max(10 min, 2 × *Minimum time between early hand-offs*): no early, idle or switch-back hand-off for that service, and a banner on that account is a strike |
| `orca account select` fails for an account | Skip that account for 10 minutes, take the next |

Detection runs when a pane turns `done` or `waiting`. A banner only counts when all of these hold:

- it is among the last five meaningful lines, because an agent that stopped on a limit stops there;
- it has the shape of a CLI status line: Claude `⎿` or unindented system lines, or the error
  markers other CLIs use (`■`, `⚠`, `error:`, …);
- it is not an input line (`❯`, `›`, `>`), TUI frame or footer, a row of the plugin's own console
  status line, or one of Claude's own `⏺` replies.

An agent's reply that mentions rate limits is therefore not treated as a limit. Detection is
heuristic, though; pausing and the per-service *Automatic hand-off* switches are the off switches
if it ever misfires.

Each banner is handled once *per session*, so a session that Orca restores or restarts in a new
pane, redrawing its old transcript, is not handed off again. Once a banner has scrolled away, the
same text appearing again later counts as a new limit.

**Panes the plugin did not start** (opened before it loaded, or restored by Orca) have no recorded
account. When one hits a limit while Orca reports plenty of room on the active account, the plugin
assumes the pane was on another account. It cools nothing and resumes the session on the active
account; from then on the pane's account is known.

**On/off per service.** Each service has its own *Automatic hand-off* switch, on its own line in
its section of the panel, or as *Automatic hand-off: Claude/Codex/Antigravity/OpenCode/Devin* in
Orca's Settings. All are on by default. For a service that is off, the plugin never closes,
hands off or resumes its sessions, and its waiting sessions stay waiting. *Hand off to this
account* still works. The *Automatic hand-off* switch at the top pauses every service at once.

**Switch back** (*Custom order*): once a higher account in your order is out of cooldown and has
room, the plugin selects it again so new sessions use it. With *Early when away* and you away it
also hands off sessions that are still on lower accounts back to it when they finish a turn, or
once they have been idle for *Hand off idle sessions after*; otherwise running sessions are not
handed back. The same close → resume as any other hand-off, without the first message: the
session had finished its turn, so it is left ready. Only sessions that resume by session id
(Claude) go back; for the other services only the selection for new sessions does. A running
session goes back only to an account with known room, or one presumed reset. The selection for
new sessions also goes to an account without numbers, as long as it has no strikes.

**Guards on early hand-offs** (early, idle, expiring-quota, switch-back; a hard limit ignores the
last two, and so does a hand-off you ask for yourself from the panel or the command). Early
hand-offs of a running session apply only to a session that resumes by session id (Claude, with a
session id from Orca); for a summary-only service they change at most the selection for new
sessions:

- the session on screen is never handed off early (unless *Session on screen* is *Move right
  away*);
- unsent text that cannot go along keeps the session where it is (see [Unsent text](#unsent-text));
- the target needs at least 10 % more room than the current account when both are known, and an
  exhausted account may always be left; a target without numbers never counts as having more room.
  When the plugin leaves an account because it is about to run out, that account counts as having
  no room left: the target then needs at least that much room (10 %) in its fullest window;
- one service's selection changes automatically at most once per *Minimum time between early
  hand-offs* (5 minutes), so two accounts near the line never ping-pong. Handing a session off to
  the account that is already selected is not a selection change.

**Skip:** each account card of a service with several accounts has a *Skip* switch. A skipped
account is never chosen automatically (no hand-off to it, no switch-back); *Hand off to this
account* still works, and a waiting session whose own account is skipped still continues there
once it resets. It is stored in the *Skipped accounts* setting (`exclude`): entries are an account
(`work@example.com`, every service) or one service's account (`claude:work@example.com`).

## Settings

All settings live in `~/.orca/oah/config.json` and can be changed from `oah config set <key> <value>` or the panel's **Settings** tab: the four basic ones, then a collapsed
**Advanced** section ("Fine-tuning. The defaults suit most people."). Each dropdown lists the
default choice first, marked "(Default)", for example "Auto (Default)", "Early when away
(Default)", "Wait and resume (Default)" and "Ask me first (Default)". Under each setting one line
says what the current value does; a setting that does not apply right now is greyed out and says
why (for example "Only used when When to hand off is Early when away."). A number or text is saved
when you press Enter.

**Basic**

| Setting | Key | Default | Choices |
|---|---|---|---|
| Pick the next account | `pick` | `smart` | `smart` (Auto), `my-order` (Custom order) |
| When to hand off | `timing` | `early` | `early` (Early when away), `at-limit` (At limit) |
| When everything is used up | `when_all_used` | `wait` | `wait` (Wait and resume), `stop` (Stop) |
| Session on screen | `active_terminal` | `ask` | `ask` (Ask me first), `careful` (Wait, then count down), `wait` (Wait for me), `now` (Move right away) |

See [How it decides](#how-it-decides) for what each choice does.

**Advanced**

| Setting | Key | Default | Range | What it does |
|---|---|---|---|---|
| Start early hand-offs after you've been away | `away_minutes` | 10 | 0–240 min | Early hand-offs start only once there has been no sign of you this long. 0 = always, even while you are here |
| Hand off this long before running out | `early_minutes` | 10 | 1–120 min | Hand off when an account would run out within this many minutes at its current pace |
| Always hand off below (% left) | `early_percent_left` | 1 | 0–50 % | Also hand off when less than this much of the 5-hour window is left, however slowly it is being used; an account at 99 % is left whatever its pace. 0 = by pace only |
| Hand off idle sessions after | `idle_minutes` | 15 | 0–1440 min | A session idle this long is handed off from an account that is about to run out, or to an account whose weekly quota would expire unused. 0 = never: idle sessions stay, and expiring quota is spent only by new sessions |
| Minimum time between early hand-offs | `switch_cooldown_minutes` | 5 | 0–240 min | Early hand-offs never change the account more often than this. A limit always hands off |
| Countdown for the session on screen | `active_countdown_seconds` | 60 | 10–3600 s | How long the countdown lasts before the session on screen hands off anyway |
| Keep the session on screen waiting after your last activity | `active_presence_seconds` | 300 | 10–3600 s | You count as using Orca for this long after your last activity |
| Remind me when the session on screen has waited | `active_reminder_minutes` | 10 | 0–1440 min | One reminder when the session on screen has waited this long to hand off. 0 = none |
| Put unsent text back after a hand-off | `restore_unsent_text` | on | | Claude: text typed and not sent goes back, unsent, into the session after a hand-off. Off, and for other services: the session waits until the text is sent or cleared. Pasted images or blocks, queued messages, and text over 4,000 characters always wait |
| First message after a limit | `auto_message` | `Continue.` | | Typed into a session whose work was interrupted (a limit or an API error) once it continues, and when a waiting session wakes. Empty = none after a hand-off; an API error retry then types "continue" |
| API error retries | `max_api_retries` | 6 | 0–50 | Retry a turn that failed with a passing API error (overloaded, 5xx) at most this many times in a row, with growing pauses. 0 = never retry |
| Model fallback | `model_fallback` | empty | | At a model limit, when no other account is known to have room for that model, try these models on the same account before handing off. Per service, separated by semicolons, e.g. `claude=sonnet,haiku` |
| Cooldown when a limit gives no reset time | `default_cooldown_minutes` | 60 | 1–1440 min | How long an account is set aside when its limit message gives no reset time |
| Read usage every | `poll_interval_seconds` | 60 | 15–3600 s | How often usage is read from Orca |
| Hand-off summary size | `handoff_max_chars` | 6000 | 500–50000 chars | Services that cannot resume (Codex, Antigravity, OpenCode, Devin) start the new session with a summary this long at most. Orca takes at most 4,096 characters, so a larger value changes nothing |
| Orca CLI path | `orca_cli_path` | empty | | Only if the orca command is not found by itself |

The first four apply only with *When to hand off: Early when away*; the countdown and *Keep the
session on screen waiting after your last activity* only with *Ask me first* or *Wait, then count
down*; the reminder not with *Move right away*. A number outside its range is taken as the
nearest end of it.

**Set elsewhere in the panel**

| Setting | Default | Meaning |
|---|---|---|
| `service_claude`, `service_codex`, `service_antigravity`, `service_opencode`, `service_devin` (*Automatic hand-off: Claude* …) | on | The *Automatic hand-off* switch in each service's section |
| `exclude` (*Skipped accounts*) | empty | The accounts set to *Skip* on their cards (see [Skip](#what-it-does)) |
| `chain` (*Custom order*) | empty | Your ranking, set with the arrows on the account cards (*Move up / Move down in custom order*) while *Pick the next account* is *Custom order*; Auto ignores it. Empty = Orca's order. The arrows keep entries for accounts on other Orca servers |
| `console_statusline_format` (*Status line header*) | empty | Shown under the Claude *Status line* switch while the status line is on (see [Console status line](#console-status-line)) |

`chain` lists accounts as the panel writes them (`claude:<account id>`) or by email
(`work@example.com`, `claude:work@example.com`), or every account of a service (`claude:*`),
separated by commas. It orders the accounts *within* each service; an email without a service
matches that address on every service, but each service keeps its own order. An account the order
does not name keeps its place after the named ones.

## UI

- **Panel** (gauge icon, right sidebar), laid out after Orca's own style guide (quiet and
  monochrome, colour only for state):
  - at the top: the title with the badge (see [How it decides](#how-it-decides)), *Refresh
    usage*, the *Automatic hand-off* switch (pause) and when usage was last read. While Orca
    cannot give the plugin your settings, or the upgrade from 0.2 is not finished, a callout
    says so ("Auto Hand-off is waiting for Orca's settings", "Auto Hand-off is finishing the
    upgrade") and the badge is not shown;
  - a *Waiting* box while a session waits: for a limit to reset ("… session resumes" at a time), for
    unsent text or queued messages to be sent or cleared, for another try ("… hands off in a
    moment"), or on screen ("Waiting to hand off", with its countdown). With *Ask me first* it is
    titled "Hand off the session on screen?" with *Not now* and *Hand off now* until you answer. A
    session on screen has *Hand off now*, *Not now* and *Don't hand off*; others have *Cancel*.
    While automatic hand-off is paused or off for that service, the line says it waits until you
    turn it on;
  - three tabs: *Accounts*, *History* and *Settings*.
  - **Accounts:** one section per service, in Orca's order except that the service of the agent
    on screen comes first, marked "· on screen" after the service name and outlined (switching
    tabs raises no event, so while it is open the panel asks again 3 seconds after each answer,
    and less often, up to every 15 seconds, while the tab stays the same; one check runs at a
    time). Each section sits on a band washed in the tone nearest its brand, with a small tile in
    the brand's colour before the service name; under it, on its own line, the service's
    *Automatic hand-off* switch (when it has more than one account, or is off); then a status
    light and "n of m ready" (a drained or limited account is not ready and is counted apart,
    e.g. "0 of 1 ready · 1 drained"). The Claude section also has a *Status line* switch that
    installs or removes the console status line in the focused workspace (the same as the install
    and remove commands); it follows the focused workspace as you change it, and where the line
    cannot be installed (no focused workspace, or one that is not on this computer) the switch is
    disabled and one muted line says why. While the status line is on, its *Status line header*
    setting is shown right under the switch;
  - each account, the one in use first, then the usable ones with the most headroom first, then
    the drained and limited ones (with *Custom order*: in your order, each card with *Move up in
    custom order* and *Move down in custom order* arrows); each with a status light and word
    (solid green active, hollow green ready, amber low at 20 % left or less, red drained at 10 % or
    less or limited, grey idle when there are no numbers), its 5-hour, weekly and model windows as
    "% left" plus the reset time on the same bar Orca's account switcher draws (green, yellow
    from 80 % used, red from 90 %), "About 8 min left at this pace" when its last readings show a
    pace (see [Pace of use](#pace-of-use); amber at 30 minutes or less, red at 10), a cooldown
    with its reason and *Clear*, and, in a service with several accounts, a *Skip* switch;
  - on each standby account of the service on screen (only that section offers it, since it
    hands off the session on screen), *Hand off to this account*, which asks first: "Hand off
    Claude to *account*?" New sessions of that service start on it, and the session on screen
    is handed off too when it is between turns, whatever the headroom of the account you chose; a
    busy one stays where it is, and the panel says so. Unsent text goes with it when it can;
    otherwise you are asked once more (see [Unsent text](#unsent-text)). Automatic hand-off for
    that service turns off as soon as the account is selected, so the plugin never undoes a
    choice you made by hand: no switch-back, no early or limit handling, until you turn the
    service's *Automatic hand-off* on again. The section says so while it is off, and a desktop
    notification reminds you at the time. A limited standby cannot be chosen until its cooldown is
    cleared. The panel then says what the hand-off did; if only the re-read of the list afterwards
    fails, it says so apart from that ("Couldn't refresh the list; it updates shortly."), never as
    a failed hand-off;
  - **History:** the last 7 days, older entries are cleaned up automatically (at most 1,000
    kept), headed "Last 7 days · n entries". Each entry names the service and the reason in words
    (*Limit reached*, *Running low*, *Back to preferred*, *Model limit*, *Expiring quota*, *Idle*,
    *By hand*, *Account free again*, *API error*, *Sign-in needed*), a badge with the outcome
    (*resumed*, *new session*, *new sessions only*, *waiting*, *failed*, *model changed*,
    *retried*, *same account*, *closed*), the accounts, and one line saying why; times in it, and in
    notifications, read as a local clock ("3:00 pm", "Thu 3:00 pm"). Unsent text that could not be put back is shown whole,
    to copy. What the plugin remembers per pane (its account, handled banners, retry counts) is
    dropped once Orca has not listed the pane for 30 minutes, checked at most every 10 minutes
    while the focused project is on this computer, and each such list keeps at most 500 entries;
  - **Settings:** see [Settings](#settings).
- **Commands** (each counts as a sign that you are here): *Start new Claude sessions on the next
  account*, *Start new Codex sessions on the next account*, *Hand off this workspace's session to
  another account*, *Pause or resume automatic hand-off*, *Refresh usage*, *Install the console
  status line in this workspace* and *Remove the console status line from this workspace*. With
  several agents in the workspace, the hand-off command takes the one on screen. A selection made
  with a next-account command is not changed again by advice (switch-back, a Low account, expiring
  quota) until the switch cooldown has passed; a limit is still handled at once. With *Custom
  order* the plugin then returns to the higher account in your order: use the panel's *Hand off to
  this account* for a choice that stays.
- **Console status line** (Claude panes): see below.
- There is no status bar item.

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
account this pane runs on (from `CLAUDE_CONFIG_DIR`); every other account gets a dim `·`, because
Claude trims leading spaces off a row. Every row, the pane's own included, shows the same numbers
as the panel: the plugin has already merged each pane's own reading into them, so the numbers
Claude hands this pane only fill a window the plugin has no number for.
`⏸1h20m` at the end of a row is a cooldown. Rows are in the panel's order: the account in use
first, then the usable ones by headroom. The
name column shows the account email (or `system (email)` for the provider's own login); when every
account of the service shares one domain the domain is dropped, otherwise the full address shows.
The column is as wide as the longest name up to 15 characters; a longer name keeps its first 14
and an `…`, so the start of the local part, which tells accounts apart, stays.

The wrapper is installed with Claude's `refreshInterval: 10`, so a pane that sits idle still
picks up new numbers every 10 seconds (Claude Code 2.1 and later; older versions ignore it). A
wrapper installed by an earlier version without it is upgraded when the panel next reads the
status line state.

Settings: *Status line header* is an optional line above the rows (empty by default), with
`{model}`, `{ctxbar}` (context-left gauge), `{ctx}` (context left %), `{5h}` and `{7d}` (this pane,
% left), `{reset}` (time until the 5-hour window resets) and `{best}` (the best model's name); it
ends with `⏸ automatic hand-off paused` while automatic hand-off is paused. It is set under the panel's
*Status line* switch while the line is on. Each gauge is 8 cells wide (a width set in an older
version still counts). The worker rewrites `~/.orca/account-rotator/status.tsv` whenever a
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
  next account. Codex hands off with a summary until cross-account resume is verified. A Codex profile that
  routes to another backend (such as Ollama Cloud) reports billing limits as
  `stream disconnected … Add usage credits`, which the plugin treats as a rate limit.
- **Antigravity, OpenCode, Devin:** hand off with a summary. OpenCode and Devin report no usage, so
  only rate limits hand them off, and their accounts are always "without numbers". Antigravity's own host login shows in the panel with its
  usage even when no managed account exists, so you can watch it; with one account there is
  nothing to switch to.

## Verified live (Orca 1.4.261)

A scratch Claude agent printed a `5-hour limit reached ∙ resets 3pm` line. The plugin then:

- cooled the account down until 3pm,
- ran `orca account select` for the next account,
- closed the pane,
- `agent.resume`d the same session on the new account,
- typed "Continue.", which the agent answered.

There was exactly one hand-off and no cascade. Behaviour learned on the way, all covered by
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
  plugin only hands off the session that hit the limit.
- **Unsent text (Orca 1.4.263):** `terminal.read` gives the rendered screen with the text typed in
  an agent's input box taken out (the box reads as empty); `orca terminal read --json` reports
  that text apart, as `draft`. The plugin therefore asks the CLI before every hand-off or typed
  message. The same field carries Claude Code's grey prompt suggestion (seen live: "keep going",
  "push it") and its fixed hints, with nothing that marks them as not typed.
- **Console status line rows (Orca 1.4.263):** the screen read includes the rows the console status
  line prints under the input box. They are skipped like the rest of the footer, so they neither
  hide a banner above them nor an unsent line.

## Borrowed from elsewhere

- Switch back to an earlier account in your order when its window resets: Orca issue
  [#33193](https://github.com/stablyai/orca/issues/33193), tokenmaxx's return-to-primary, cswap's
  `priority-consume-first`.
- Headroom gap and selection cooldown: Orca PR [#28044](https://github.com/stablyai/orca/pull/28044),
  cswap's hysteresis.
- Skipping an account that fails to switch, per-account exclusion: Orca PR
  [#43578](https://github.com/stablyai/orca/pull/43578), cswap `disable`, AgentsRoom "never used as
  backup".
- Spending weekly quota that resets soonest first: Orca PR [#42856](https://github.com/stablyai/orca/pull/42856), cswap `weekly-first`.
- Leaving a pane with unsent text alone: Orca issue [#41488](https://github.com/stablyai/orca/issues/41488).

## Usage of accounts not in use

Orca checks usage of the account *in use* about every 5 minutes, while its window is open. It
fetches the other accounts only when its usage view opens or right after an account switch. An
inactive Claude account whose sign-in token has expired reports nothing until Claude runs on it
again; Orca deliberately does not refresh that token itself.

So the plugin remembers the last reading Orca gave for every account (for 7 days) and shows it
with its age:

- in the panel, "Last reading 2h ago".

A window whose reset time has passed shows as 0 %, "reset since". These remembered numbers also
count when the plugin chooses the next account, so an exhausted account that is not in use is no
longer mistaken for a free one.

**Numbers from the panes themselves.** Claude Code gives every pane's status line the limits of the
account that pane runs on. With the [console status line](#console-status-line) installed, the
wrapper leaves them in `~/.orca/account-rotator/live/claude-<profile id>.tsv` (`claude-system.tsv`
for Claude's own login): one line with the time of writing, the 5-hour and 7-day percent used and
their reset times. Numbers only: no name, email, path or token. The worker watches `live/` and
re-reads these files on turn ends and periodic ticks (without spawning Orca), so a Claude account
that runs in a pane but is not the selected one updates right away:

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
pace". *When to hand off: Early when away* acts on it once you are away: see [How it decides](#how-it-decides).

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
| A limit was hit | Known first, then presumed reset, then unknown with the fewest strikes. Auto and Custom order only order accounts of the same kind, so Custom order can leave your order here; switch-back restores it. The session waits only when nothing is left |
| Early or idle hand-off (*Early when away*) | Only to a known account. To a presumed-reset or unknown one only when the current account is known to be at 100 % and no known account is left |
| Ranking by room or by weekly reset (Auto) | An unknown account does not compete as "50 % used"; it comes after every known one |
| Switch back, running session | Only to a known or presumed-reset account |
| Switch back, new sessions | Also to an unknown account without strikes. Only the selection changes, which is also what makes Orca fetch that account |
| By hand (panel, commands) | Any account that is not cooling down |

The cost of a wrong guess is real: a session handed off to an unknown account that turns out to
be exhausted fails one turn, shows a limit banner, and is handed off again. The plugin limits how often
that happens:

- **Strikes.** A banner without a reset time on an account without numbers is a strike, and so is
  any banner on the account under probation. With no reset time to go by, each strike doubles the
  cooldown: *Cooldown when a limit gives no reset time* × 1, 2, 4 …, at most 5 h. Strikes outlast the cooldown and count
  for 24 h; struck accounts are tried last, and are not selected again by switch-back. A current
  reading that shows room, or a turn that finishes without a banner on that account, clears them.
- **Probation.** After an automatic hand-off to an account without numbers, the plugin makes no
  early, idle or switch-back hand-off for that service for max(10 min, 2 × *Minimum time between
  early hand-offs*). A real limit still hands the session off.

Limits of this: a strike is a guess about an account, drawn from one failed turn. An unknown
account that works is still unknown until Orca reports numbers for it. For OpenCode and Devin that
never happens, so their rotation is always reactive. Pausing, or switching a service off, stops
all of the above.

The plugin reads Orca's numbers every *Read usage every*: default 60 seconds,
range 15–3600. A change applies immediately. Concurrent background reads share one `accounts.list`
call. After each account change the plugin makes, it reads again at about 8 and 70 seconds,
because a change is what makes Orca fetch the accounts not in use. The plugin never reads tokens or
keychains. Background reads call Orca's runtime `accounts.list` with `refreshUsage: false,
refreshStaleUsage: true` (falling back to `orca account list` when needed), letting Orca refresh
readings it considers stale on its own schedule; an explicit *Refresh usage* from the panel or
command passes `refreshUsage: true` so Orca refreshes active usage immediately (inactive accounts
still follow Orca's 60-second cooldown, `Retry-After` throttles and token rules).

## Known limitations

These are known and not fixed. None of them loses typed text, interrupts a turn or crosses
services; most are rare. Read the first seven before you rely on
the plugin.

- **Closing a pane also stops its background processes.** A hand-off closes the session's terminal
  pane and resumes the session in a new one. Anything the agent left running in the old pane (a
  dev server, a watcher, a background shell job) ends with it.
- **A resume that fails after the close leaves the session closed.** Claude's pane is closed
  first, because Orca refuses to resume a session that still runs. If the resume then fails, the
  pane is gone; you are notified ("Claude: hand-off to *account* failed: …"), History notes it, and you can
  reopen the session from Orca yourself. The conversation is not lost.
- **The hand-off command picks the first idle agent when a plain shell tab is in front.** *Hand
  off this workspace's session to another account* hands off the agent on screen. If that tab
  is a plain shell, it takes the first agent of the workspace that is between turns, which may
  not be the one you meant.
- **The next-account commands change the account at once.** *Start new Claude (or Codex)
  sessions on the next account* selects it for new sessions without asking, and Orca may then show its own "Restart sessions"
  prompt. You do not need to press Restart.
- ***Hand off to this account* turns automatic hand-off off for that service,** so the rotator
  does not undo your choice. The panel says so; turn the service's *Automatic hand-off* switch on
  again to resume.
- **The console status line needs `sh`.** It is a POSIX shell script, so it does not work on
  Windows (outside WSL).
- **Installing the console status line writes `.claude/settings.local.json` in the workspace's
  folder,** i.e. inside your repository. It is a personal settings file: make sure it is ignored
  by git there. Uninstall restores what was there.
- **A hand-off with a summary starts a new session.** For Codex, Antigravity, OpenCode and Devin the next account
  gets a new session with a summary (up to *Hand-off summary size*, at most 4,096 characters), not
  the conversation. This happens only at a real limit or when you hand the session off by hand.
- **While Orca cannot be asked, nothing is handed off.** If `orca terminal read` keeps failing for a pane
  (or Orca cannot list its agents), a session stopped at a limit waits there until Orca answers
  again; the panel lists it under *Waiting*, where *Cancel* drops the hand-off.
- **The session on screen is a guess.** Orca cannot say whether you are in front of it, only
  which tab is shown in the focused workspace. With *Ask me first* left unanswered, or *Wait, then
  count down*, a session there that hits a limit while you seem away hands off after the
  countdown; one you are reading without typing may hand off too. With *Wait for me*, or after *Not now*, it can
  wait for a long time if you never switch tabs (one reminder, then *Hand off now* in the panel).
- **Claude's greyed prompt suggestion counts as unsent text.** After a turn, Claude Code can show
  a suggested next prompt in grey in the input box. Orca (1.4.263) reports it to plugins the same
  way as text you typed, so the plugin cannot tell the two apart. With *Put unsent text back*
  on (the default), the suggestion goes along with a Claude session that is handed off and comes
  back in its input box as real text: unsent, so nothing happens until you press Enter; clear it if
  you do not want it. With the setting off it holds back early hand-offs: an early, idle,
  switch-back or expiring-quota hand-off of that session is skipped, the hand-off command says the
  session has unsent text that cannot go along and leaves it, and the panel's *Hand off to this
  account* shows the text and hands off only after *Hand off anyway*. To avoid all this, turn *Prompt suggestions* off in
  Claude Code (`/config`).
- **No Claude hint is ignored yet.** Any fixed line Claude Code shows in an empty input box is
  treated as unsent text, like a suggestion, until a wording is confirmed harmless. "Press up to
  edit queued messages" is never ignored and never carried: it means queued messages are waiting,
  so it always keeps the session where it is, also with *Put unsent text back* on.
- **The scroll position is not kept.** A session that is handed off starts at the bottom of a new pane; Orca
  does not tell plugins where a pane was scrolled.
- **A handed-off session opens in a new tab and briefly focuses it on the host.** Orca starts resumed
  (`agent.resume`) and launched (`agent.launch`) plugin sessions in the background outside any real
  tab group, which can leave a paired Orca client showing a black pane for the closed tab. To place
  the new session in a real tab, the plugin runs `orca terminal switch` on it and then switches focus
  back to the terminal that was in front on the host. The new tab does not keep the old tab's exact
  position or split layout (Orca offers plugins no way to place a tab without focusing it), and if
  the host was showing a non-terminal tab (an editor or browser tab), focus stays on the new session's
  tab. On a paired client, Orca's own tab mirroring still decides whether the new tab appears without
  a reload.
- **With unsent text that cannot go along, the panel cannot select an account for new sessions
  only.** *Hand off to this account* then either hands off the session on screen (*Hand off
  anyway*) or changes nothing (*Cancel*). Change tabs, or use Orca's own account switcher, to
  select the account without handing off that session.
- **Banner wordings are not all confirmed.** Only some limit messages were captured from the real
  CLIs; the others follow each CLI's known wording. If a CLI changes its message, that limit is
  not seen until the rules are updated. Many extra rows under the input box (for example a long
  list of running sub-agents) can also push a banner out of the last five lines that are read.
- **A model limit sets the whole account aside.** When one model's limit is hit on an account, or
  one model's weekly window is about to run out, the account as a whole cools down or counts as
  Low, also for sessions that use another model.
- **Events of a pane that is being handled are dropped.** While the plugin works on a pane (a
  hand-off, or the wait before an API-error retry), further status events of that pane are ignored. A
  limit that shows up just then is picked up at the pane's next turn end.
- **A new session's account is taken from the project in focus.** The launch hook notes the
  account selected for the project you are looking at. A session started at that moment in a
  project on another Orca server can be noted on the wrong account until its first hand-off or limit.
- **Two shortcuts on paired servers.** History entries do not say which server they belong to,
  so the guess "this unknown pane is still on the account just left" can use a hand-off made on
  another server. And if you change to a project on another server while the idle check runs,
  that one check can look at the wrong server's accounts; the next check is right again.
- **Split terminal groups.** Orca does not tell plugins which pane has the keyboard. With two
  groups side by side, every pane of the shown tab counts as on screen, and *Hand off to this
  account* can take the agent of the same service shown in the other group.
- **At 1,000 history entries** (the most kept), the hand-off command and *Hand off to this account*
  can answer "nothing to do" or "keeps its account" after a hand-off that did happen. The hand-off
  and the History list are right.
- **Pressing Restart in Orca's own prompt** has not been tested. The plugin may then still take
  those sessions to be on the old account until their next hand-off or limit.

## Permissions

Orca asks you to approve the plugin's access. Beyond the host API, the worker runs the `orca` CLI
(`account select`, `account list`, `terminal close`, `terminal switch`, `terminal send`, `terminal read`, `terminal list`) and `git status` and
`git diff --stat`. It always uses an argument list, never a shell. The CLI is used because the host
API cannot select accounts, refuses to close or type into panes outside the focused workspace,
starts resumed and launched sessions in the background without a real tab (and `terminal.focus` in
the host API would require `workspace:write`, which the plugin does not ask for, so `terminal switch`
places the new pane into a real tab and returns focus to the terminal that was in front),
does not say whether a pane's input box holds unsent text (`terminal read` does; only its `draft`
field is used; that text is shown to you in the panel's second confirmation, put back into the
session after a hand-off and quoted in the hand-off notification; it is never logged, and only
text that could not be put back is kept, in History, for you to copy), and does not say which
terminal tab is in front (`terminal list --include-visual-layouts` does; read-only, for the
panel's "· on screen" mark and for the session *Hand off to this account* hands off).

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

The daemon stores its config (`config.json`), state (`state.json`), usage cache (`usage.json`),
burn-rate samples (`samples.json`), Unix socket (`oahd.sock`), `status.tsv` and the status-line
wrapper script under `~/.orca/oah/`, and reads the `live/` files the wrapper leaves there; the
wrapper is the only writer of `live/`. Everything under `~/.orca/oah/` is written readable by you
only (mode 0600, folder mode 0700).

A hand-off summary (for services that cannot resume by session id) includes up to 40 lines of the
previous agent's output, so treat it like any pasted terminal output.

## License

MIT; see [LICENSE](LICENSE).

## Develop

```sh
npm run test:cli                 # standalone Node tests for oahd daemon, oah CLI, and thin plugin bridge
npm run test:plugin              # full suite (410 tests) via orca plugin test
npm run typecheck                # strict TypeScript check (zero npm dependencies; src/node-shim.d.ts)
npm run validate                 # validates orca-plugin.json
orca plugin check . --json       # renders the panel with the real worker
orca plugin dev load . --json    # needs --approve <fingerprint> the first time
./bin/oah debug --json           # daemon status, bridge state, and recent events
```

Code layout:

- `bin/oah`, `bin/oahd`: zero-dependency Node.js executables.
- `src/core/`: pure domain logic (`engine.ts`, `adapters.ts`, `accounts.ts`, `smart.ts`, `selector.ts`, `usage-cache.ts`, `usage-history.ts`, `live-usage.ts`, `settings.ts`, `statusline.ts`, `statusline-files.ts`, `labels.ts`, `cli.ts`, `types.ts`, `version.ts`).
- `src/daemon/`: standalone `oahd` daemon (`server.ts`, `store.ts`, `ipc.ts`, `orca-transport.ts`, `main.ts`).
- `src/cli/`: `oah` CLI (`client.ts`, `commands.ts`, `format.ts`, `main.ts`).
- `src/plugin/`: thin Orca plugin bridge (`worker.ts`, `worker.test.ts`).
- `src/panel.tsx`, `src/protocol.ts`: Orca sidebar panel UI and panel IPC contract.
