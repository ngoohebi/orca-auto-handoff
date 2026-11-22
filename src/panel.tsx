// Auto Hand-off panel: every account's usage, cooldowns, waiting sessions, the hand-off history
// and the settings.
//
// What it changes goes through the worker: automatic hand-off on or off (all, or per service),
// "Hand off to this account", Skip, the custom order's arrows, clearing a cooldown, answering
// for the session on screen (Hand off now, Not now, Don't hand off), and the Settings tab.
//
// Follows Orca's style guide (docs/STYLEGUIDE.md): monochrome and quiet, colour only for state
// (limited, paused, low headroom), hairline borders, no cards in cards, labelled controls without
// tooltips, a quiet back-out path, and copy that states what is known.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Code,
  Collapsible,
  EmptyState,
  Heading,
  IconButton,
  Image,
  Input,
  plugin,
  read,
  RelativeTime,
  Row,
  Select,
  Separator,
  set,
  Skeleton,
  Stack,
  Switch,
  Tab,
  Tabs,
  Text,
  type OrcaNode,
  type PanelContext,
  type Tone
} from 'orca'
import { HELD_WORDS, minLeft, percentLeft, PROVIDER_NAME, REASON_WORDS, resultWords, runwayWords, seatOrder } from './core/labels.ts'
import type { ConsoleLineState, SettingValues, Snapshot, UnsentDraft } from './protocol'
import { ADVANCED_SETTINGS, applies, BASIC_SETTINGS, checked, STATUS_LINE_SETTINGS, type SettingSpec } from './core/settings.ts'
import { PROVIDERS, type Provider } from './core/types.ts'

const snapshot = atom<Snapshot | null>(null)
/** The actions on their way, by key. Each control waits only for its own action (and a hand-off
 *  for another hand-off), so one slow request never greys out the whole panel. */
const busy = atom<readonly string[]>([])
const isBusy = (key: string): boolean => read(busy).includes(key)
const busyWith = (prefix: string): boolean => read(busy).some((k) => k.startsWith(prefix))
/** A hand-off, or an answer about a session that would move, is on its way: the other hand-off
 *  controls wait for it, since two at once would race for the same session. */
const MOVING = /^(switch|now|decline|cancel):/
const moving = (): boolean => read(busy).some((k) => MOVING.test(k))
/** What the last action did. `at` is where it is said: under the setting or switch that was
 *  changed, so it is seen where the change was made; without it, at the top of the panel. */
type Note = { text: string; tone: Tone; at?: string }
const message = atom<Note | null>(null)
/** The tabs there are. Any other stored tab opens Accounts. */
const TABS = ['accounts', 'proxy', 'history', 'settings'] as const
const tab = atom('tab', 'accounts', { persist: 'plugin' })
/** The Claude console status line in the focused workspace: undefined until asked, null when it
 *  could not be read. */
const consoleLine = atom<ConsoleLineState | null | undefined>(undefined)
/** The Settings tab's values, as the worker last gave them. */
const settings = atom<SettingValues | null>(null)
/** The standby account whose *Hand off to this account* is waiting for confirmation. */
const confirming = atom<string | null>(null)
/** *Yes, hand off* found unsent text in the session that cannot go along with it (a pasted image or
 *  block, queued messages): the account it was for and the text, shown in a second confirmation.
 *  Only its *Hand off anyway* gives the text up. Plain text goes along and is not asked about. */
const draftAsk = atom<{ seatKey: string; draft: UnsentDraft } | null>(null)
/** Takes a new snapshot. A project on another server lists other accounts under the same keys,
 *  and has another session in front: a question about unsent text asked before is dropped. */
function show(next: Snapshot): void {
  if ((next.server ?? '') !== (read(snapshot)?.server ?? '')) set(draftAsk, null)
  set(snapshot, whole(next))
  // The Settings tab has nothing to show yet (Orca could not be asked when the panel opened):
  // the worker's pushes are the sign to ask again.
  if (read(settings) === null) askSettings()
}

/** Reads the Settings tab's values, one request at a time. A failure leaves what is shown. */
let askingSettings = false
function askSettings(): void {
  if (askingSettings) return
  askingSettings = true
  void plugin
    .request('rotator.settings', {})
    .then((values) => set(settings, values), () => undefined)
    .finally(() => {
      askingSettings = false
    })
}

/** A snapshot with every part the panel draws from. The worker always sends them all; one from a
 *  worker of another version (the panel and the worker restart apart during an update) may not,
 *  and a missing list must not leave the panel blank. */
function whole(next: Snapshot): Snapshot {
  const list = <T,>(value: T[] | undefined): T[] => (Array.isArray(value) ? value.filter((x) => x && typeof x === 'object') : [])
  return {
    ...next,
    seats: list(next.seats).filter((s) => s.usage && typeof s.usage === 'object'),
    waiting: list(next.waiting),
    history: list(next.history),
    services: next.services ?? ({} as Snapshot['services'])
  }
}

/** How much of the unsent text the second confirmation shows. */
const DRAFT_SHOWN = 80

/** The unsent text on one line, cut to what fits the confirmation. */
function shownDraft(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > DRAFT_SHOWN ? `${line.slice(0, DRAFT_SHOWN)}…` : line
}

/** Asks the worker to switch. When the session that would move shows unsent text nothing is
 *  switched and the second confirmation opens instead; `accepted` is the text its *Hand off anyway*
 *  gives up, and nothing else passes it. */
function switchTo(seatKey: string, accepted?: UnsentDraft): Promise<void> {
  let asked = false
  return act(
    `switch:${seatKey}`,
    async () => {
      const result = await plugin.request('rotator.switchTo', accepted ? { seatKey, acceptDraft: true, draft: accepted } : { seatKey }, { timeoutMs: SWITCH_TIMEOUT_MS })
      if (!result.draft) return result.message
      // Nothing changed yet (also when the text changed since it was shown): ask.
      asked = true
      set(draftAsk, { seatKey, draft: result.draft })
      set(message, null)
    },
    // Nothing to read again when nothing was switched.
    async () => {
      if (!asked) await load()
    }
  )
}

/** Counts the panel's openings and closings. A read takes a while (the retry below waits), and
 *  what it brings back after its panel closed is dropped: it is the answer to a question nobody
 *  is asking any more, and a panel opened since has asked for its own. */
let opening = 0

/** The console line state; one retry, since the first request after a reload can race the
 *  worker's restart and the row would otherwise stay hidden until the next refresh. Not asked
 *  again once the panel that asked (`mine`) has closed. */
async function readConsoleLine(mine: number): Promise<ConsoleLineState | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await plugin.request('rotator.consoleLine', {})
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      if (mine !== opening) return null
    }
  }
  return null
}

/** Reads the Status line switch's state and shows it, unless the panel closed meanwhile. */
async function showConsoleLine(): Promise<void> {
  const mine = opening
  const state = await readConsoleLine(mine)
  if (mine === opening) set(consoleLine, state)
}

async function load(refresh = false, directQuota = false): Promise<void> {
  const mine = opening
  const next = await plugin.request('rotator.snapshot', { refresh, ...(directQuota ? { directQuota } : {}) })
  if (mine !== opening) return
  show(next)
  await showConsoleLine()
}

/** How long *Yes, hand off* may take. The worker answers only once the pane in the tab has moved:
 *  it closes the pane and waits for the resumed session (over a minute at worst), and a request
 *  gets 30 s by default, after which a switch that worked would read as failed. */
const SWITCH_TIMEOUT_MS = 120_000

/** Said after an action that worked when the list could not be read again afterwards. */
const NOT_REFRESHED = "Couldn't refresh the list; it updates shortly."

/** Runs one action and says what it did. `reload` reads the panel again afterwards: when only
 *  that fails the action still worked, so its own result is said, with the reload problem apart
 *  from it (the worker's next push brings the list up to date). `at` says the result next to the
 *  control that asked (see `Note`). The same action twice at once runs once. */
async function act(key: string, fn: () => Promise<string | void>, reload?: () => Promise<void>, at?: string): Promise<void> {
  if (isBusy(key)) return
  set(busy, [...read(busy), key])
  const say = (text: string, tone: Tone = 'neutral') => set(message, at ? { text, tone, at } : { text, tone })
  try {
    let text: string | void
    try {
      text = await fn()
    } catch (error) {
      say(`Failed: ${String((error as Error)?.message ?? error)}`, 'danger')
      return
    }
    let refreshed = true
    if (reload) {
      try {
        await reload()
      } catch {
        refreshed = false
      }
    }
    if (!refreshed) say(`${text ? text.replace(/[.\s]+$/, '') : 'Done'}. ${NOT_REFRESHED}`)
    else if (text) say(text)
  } finally {
    set(busy, read(busy).filter((k) => k !== key))
  }
}

/** The result of an action said next to the control it came from (`at`), with a way to dismiss it. */
function NoteLine({ at }: { at?: string }) {
  const note = read(message)
  if (!note || note.at !== at) return null
  return (
    <Row justify="between" align="center" gap="sm">
      <Text size="xs" tone={note.tone} muted={note.tone === 'neutral'}>
        {note.text}
      </Text>
      <IconButton icon="close" label="Dismiss" variant="ghost" size="xs" onPress={() => set(message, null)} />
    </Row>
  )
}

/** Switching terminal tabs raises no event, so while the panel is open it asks which service the
 *  current terminal's agent belongs to. Each answer costs the worker a CLI process, so the next
 *  question is asked only after the answer, and less often while the tab stays the same (a
 *  workspace or agent change is pushed by the worker anyway). */
const FOCUS_POLL_MS = 3_000
const FOCUS_POLL_MAX_MS = 15_000

export function setup(ctx: PanelContext): void {
  opening++
  ctx.subscriptions.push(plugin.on('rotator.changed', (payload) => show(payload)))
  // The Status line switch is per workspace: the worker says when the focused one changes.
  ctx.subscriptions.push(plugin.on('rotator.consoleLine', (payload) => set(consoleLine, payload)))
  // Settings changed here or on Orca's Settings page.
  ctx.subscriptions.push(plugin.on('rotator.settings', (payload) => set(settings, payload)))
  askSettings()
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const poll = (wait: number): void => {
    timer = setTimeout(async () => {
      let moved = false
      try {
        const { focused } = await plugin.request('rotator.focus', {})
        const current = read(snapshot)
        if (!closed && current && current.focused !== focused) {
          moved = true
          show({ ...current, focused })
        }
      } catch {
        // The worker may be restarting; ask again later.
      }
      if (!closed) poll(moved ? FOCUS_POLL_MS : Math.min(wait * 2, FOCUS_POLL_MAX_MS))
    }, wait)
    // Never keep a Node host (the test runner) alive for the poll.
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }
  poll(FOCUS_POLL_MS)
  ctx.subscriptions.push({
    dispose: () => {
      closed = true
      opening++
      if (timer) clearTimeout(timer)
    }
  })
  // The first read can race the worker's restart: the worker's next push then fills the list,
  // and the Status line switch is still read.
  void load().catch(() => showConsoleLine())
}

// ---- wording ------------------------------------------------------------------------------

/** Brand colours cannot be given to Orca's components (only theme tones), so each service's
 *  colour ships as a small image in assets/brand: a rounded tile before its name, like an app
 *  icon, so nothing in the block but the usage bars is a bar. Claude is Anthropic's terracotta,
 *  Codex OpenAI's green, Antigravity Google's blue, Devin Cognition's blue; OpenCode's mark is
 *  near-black, so a light neutral stands in. */
const brandMark = (p: Provider) => `assets/brand/${p}-mark.png`
/** The title badge's marks: geometric shapes of one width, ● early hand-offs on, ○ only at a
 *  limit, ■ paused, and ◐ (Early when away, the user is here), which is drawn so it can be a
 *  brighter, lighter green than Orca's one green for text. */
const BADGE_SYMBOL = { away: '●', here: '◐', limit: '○', paused: '■' } as const

/** What automatic hand-off is doing right now, in the title badge: the state only, in words that
 *  need no legend (how accounts are picked is on the Settings tab). */
function badgeState(snap: Snapshot): { mark: keyof typeof BADGE_SYMBOL; label: string; tone: Tone; plain: boolean } {
  if (snap.paused) return { mark: 'paused', label: 'Paused', tone: 'warning', plain: false }
  if (snap.atLimitOnly) return { mark: 'limit', label: 'At limit only', tone: 'neutral', plain: true }
  // Early when away, the user is here: green, without the solid border of early hand-offs on.
  if (snap.userHere) return { mark: 'here', label: 'Early once you step away', tone: 'success', plain: true }
  return { mark: 'away', label: 'Early hand-offs on', tone: 'success', plain: false }
}

/** Why Orca has no live numbers for this account, in plain words. */
function reasonText(seat: { usage: Snapshot['seats'][number]['usage']; active: boolean }): string | undefined {
  switch (seat.usage.reason) {
    case 'stale-token':
      return 'Updates the next time this account runs.'
    case 'sign-in':
      return 'Sign in to this account again in Orca.'
    case 'rate-limited':
      return 'Usage check is throttled for now; the account itself may be fine.'
    case 'fetching':
      return 'Orca is fetching usage.'
    case 'no-usage-api':
      return 'This service reports no usage; only a limit hands it off.'
    case 'not-reported':
      return seat.active ? 'Orca has not reported usage yet.' : 'Orca reports usage for this account only while it is in use.'
    case 'error':
      return seat.usage.detail ?? 'Orca could not read usage.'
    default:
      return undefined
  }
}

/** Why an account is cooling down, in words: the stored reason starts with a code
 *  (`rate_limit: <banner>`, `threshold: …`, `hand-off failed: …`). */
function cooldownWords(reason: string | undefined): string {
  if (!reason) return 'Limited'
  if (/^threshold\b/.test(reason)) return 'Used up'
  const m = reason.match(/^(\w+)(?:: ([\s\S]*))?$/)
  const code = m?.[1] as keyof typeof REASON_WORDS | undefined
  if (m && code && code in REASON_WORDS) return m[2] ? `${REASON_WORDS[code]}: ${m[2]}` : REASON_WORDS[code]
  return capital(reason)
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Headroom is state: little left reads as a warning, none as danger; the rest stays neutral. */
function headroomTone(left: number | undefined): Tone {
  if (left === undefined) return 'neutral'
  if (left <= 10) return 'danger'
  if (left <= 20) return 'warning'
  return 'neutral'
}

/** Only outcomes that need attention get colour. */
const RESULT_TONE: Partial<Record<Snapshot['history'][number]['result'], Tone>> = {
  waiting: 'warning',
  failed: 'danger'
}

// ---- accounts -----------------------------------------------------------------------------

type SeatRow = Snapshot['seats'][number]
type Window = NonNullable<SeatRow['usage']['session']>

/** One light and one word, as the worktree sidebar shows an agent's state. The account in use
 *  is a bright filled green dot, as the worktree sidebar marks a running agent; a healthy standby is
 *  a dimmer hollow green ring, so the two never read alike. Trouble is always a filled dot in warning or danger. */
type SeatStatus = { tone: Tone; word: string; filled: boolean; dim?: boolean }
function seatStatus(seat: SeatRow, now: number): SeatStatus {
  if (seat.cooldownUntil && seat.cooldownUntil > now) return { tone: 'danger', word: 'limited', filled: true }
  const left = minLeft(seat)
  if (left !== undefined && left <= 10) return { tone: 'danger', word: 'drained', filled: true }
  if (left !== undefined && left <= 20) return { tone: 'warning', word: 'low', filled: true }
  if (seat.active) return { tone: 'success', word: 'active', filled: true }
  if (!seat.usage.known) return { tone: 'neutral', word: 'no data', filled: false, dim: true }
  return { tone: 'success', word: 'ready', filled: false }
}

/** The status light: a filled circle for the account in use, the same circle hollow for a
 *  standby in the same colour, muted when there is nothing to say. */
function StatusDot({ tone, filled, dim }: { tone: Tone; filled: boolean; dim?: boolean }) {
  return (
    <Text size="xs" tone={tone} muted={!!dim}>
      {filled ? '●' : '○'}
    </Text>
  )
}

/** One usage window on one line: its name, the bar, then headroom and reset. The bar is drawn
 *  as Orca's account switcher draws it: a thin rounded track, filled with what is left, green
 *  while healthy, yellow from 80 % used and red from 90 % used. */
function UsageBar({ name, window }: { name: string; window: Window | undefined }) {
  const left = percentLeft(window?.usedPercent)
  const tone = headroomTone(left)
  const reading = left === undefined ? '–' : `${left}% left`
  // Orca paints the fill solid. Components only tint a background but paint a border solid, so
  // the fill is two 2 px strips that are all border: one solid 4 px bar in the tone.
  const fill: Tone = tone === 'neutral' ? 'success' : tone
  return (
    <Box direction="row" align="center" gap="sm">
      <Box width={40} shrink={false}>
        <Text size="xs" muted truncate>
          {name}
        </Text>
      </Box>
      <Box grow height={4} radius="full" background="muted">
        {left ? (
          <Box width={`${left}%`} gap="none" radius="full">
            <Box height={2} radius="full" border={fill} />
            <Box height={2} radius="full" border={fill} />
          </Box>
        ) : null}
      </Box>
      <Box width={104} shrink={false} direction="row" justify="end" gap="xs">
        <Text size="xs" tone={tone} muted={tone === 'neutral'}>
          {reading}
        </Text>
        {window?.resetsAt ? (
          <Text size="xs" muted>
            · <RelativeTime at={window.resetsAt} format="duration" muted />
          </Text>
        ) : null}
      </Box>
    </Box>
  )
}

/** Where the numbers come from, on one muted line, when it is worth saying. */
function SourceLine({ seat }: { seat: SeatRow }) {
  const { usage } = seat
  if (!usage.known) return null
  if (usage.source === 'live' && usage.origin && usage.origin !== 'pane') {
    return (
      <Text muted size="xs">
        Checked with {PROVIDER_NAME[seat.provider]} {usage.asOf ? <RelativeTime at={usage.asOf} muted /> : null}
      </Text>
    )
  }
  if (usage.source === 'cached' || usage.source === 'projected') {
    return (
      <Text muted size="xs">
        Last reading {usage.asOf ? <RelativeTime at={usage.asOf} muted /> : null}
        {usage.source === 'projected' ? ' · a window has reset since' : ''}
        {reasonText(seat) ? ` · ${reasonText(seat)}` : ''}
      </Text>
    )
  }
  return null
}

function SeatCard({ seat, now, switchable, place, skippable }: { seat: SeatRow; now: number; switchable: boolean; place?: { first: boolean; last: boolean }; skippable?: boolean }) {
  const cooling = !!seat.cooldownUntil && seat.cooldownUntil > now
  const status = seatStatus(seat, now)
  const name = PROVIDER_NAME[seat.provider]
  // "Skip": never chosen automatically (a hand-off by hand still can). Always first on the last
  // row, so it never moves while a question is open.
  const skip = skippable ? (
    <Switch
      label="Skip"
      checked={!!seat.excluded}
      disabled={isBusy(`exclude:${seat.key}`)}
      onChange={(excluded: boolean) =>
        act(`exclude:${seat.key}`, async () => {
          await plugin.request('rotator.setExcluded', { seatKey: seat.key, excluded })
          return excluded ? `${seat.label}: skipped by automatic hand-off` : `${seat.label}: no longer skipped`
        })
      }
    />
  ) : null
  const handOff = switchable && !seat.active && !cooling
  const draft = read(draftAsk)?.seatKey === seat.key ? read(draftAsk)!.draft : undefined
  const confirm = !draft && read(confirming) === seat.key
  const asking = !!draft || confirm
  return (
    <Box gap="xs" paddingY="xs">
      {/* Who: the account on its own line, then its usage right under it. */}
      <Box direction="row" justify="between" align="center" gap="sm">
        <Row gap="xs" align="center">
          <StatusDot tone={status.tone} filled={status.filled} dim={status.dim} />
          <Text truncate>{seat.label}</Text>
        </Row>
        <Row gap="xs" align="center">
          <Text size="xs" tone={status.tone} muted={!!status.dim}>
            {status.word}
          </Text>
          {/* Custom order: the account's place in its service's ranking. */}
          {place ? (
            <>
              <IconButton icon="collapse" label="Move up in custom order" variant="ghost" size="xs" disabled={place.first || busyWith('move:')} onPress={() => moveSeat(seat.key, -1)} />
              <IconButton icon="expand" label="Move down in custom order" variant="ghost" size="xs" disabled={place.last || busyWith('move:')} onPress={() => moveSeat(seat.key, 1)} />
            </>
          ) : null}
        </Row>
      </Box>
      {seat.usage.known ? (
        <Stack gap="xs">
          <UsageBar name={seat.provider === 'devin' ? 'Day' : '5h'} window={seat.usage.session} />
          <UsageBar name="Week" window={seat.usage.weekly} />
          {seat.usage.monthly ? <UsageBar name="Month" window={seat.usage.monthly} /> : null}
          {seat.usage.model ? <UsageBar name={capital(seat.usage.model.name)} window={seat.usage.model} /> : null}
          {/* The pace of use, when the last readings show one; half an hour or less takes a colour. */}
          {seat.runwayMs !== undefined ? (
            <Text size="xs" tone={seat.runwayMs <= 10 * 60_000 ? 'danger' : seat.runwayMs <= 30 * 60_000 ? 'warning' : 'neutral'} muted={seat.runwayMs > 30 * 60_000}>
              {capital(runwayWords(seat.runwayMs))}
            </Text>
          ) : null}
        </Stack>
      ) : (
        <Text muted size="xs">
          {reasonText(seat) ?? 'No usage yet: Orca reports it once this account runs.'}
        </Text>
      )}
      {/* Where the numbers come from. */}
      <SourceLine seat={seat} />
      {cooling ? (
        <Row justify="between" align="center" gap="sm">
          <Text size="xs" tone="danger">
            {cooldownWords(seat.cooldownReason)} · ends <RelativeTime at={seat.cooldownUntil!} tone="danger" />
          </Text>
          <Button
            size="xs"
            variant="ghost"
            tooltip="Count this account as free again now"
            disabled={isBusy(`clear:${seat.key}`)}
            onPress={() => act(`clear:${seat.key}`, async () => {
              await plugin.request('rotator.clearCooldown', { seatKey: seat.key })
            })}
          >
            End cooldown
          </Button>
        </Row>
      ) : null}
      {/* Skip on the left, the hand-off by hand on the right; while it asks, the question sits
          below the row and the row stays where it is. */}
      {skip || handOff ? (
        <Row justify="between" align="center">
          {skip ?? <Box />}
          {handOff && !asking ? (
            <Button
              size="xs"
              variant="outline"
              icon="next"
              tooltip={`Hand ${name} off to this account now, instead of waiting for automatic hand-off`}
              disabled={moving()}
              onPress={() => {
                // One question at a time: an older one about unsent text is dropped.
                set(draftAsk, null)
                set(confirming, seat.key)
              }}
            >
              Hand off to this account
            </Button>
          ) : null}
        </Row>
      ) : null}
      {handOff && draft ? (
        <Box border="accent" radius="md" padding="sm" gap="sm">
          <Text size="sm" weight="medium">
            {draft.queued
              ? 'This session has queued messages that would be lost.'
              : `This session shows unsent text that cannot go along: “${shownDraft(draft.text)}”.`}
          </Text>
          <Text size="xs" muted>
            {draft.queued ? 'Hand off anyway?' : 'Hand off anyway? The text would be lost.'}
          </Text>
          <Row justify="end" gap="xs">
            <Button size="sm" variant="ghost" onPress={() => set(draftAsk, null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={moving()}
              onPress={() => {
                const asked = read(draftAsk)
                set(draftAsk, null)
                if (asked) void switchTo(seat.key, asked.draft)
              }}
            >
              Hand off anyway
            </Button>
          </Row>
        </Box>
      ) : handOff && confirm ? (
        <Box border="accent" radius="md" padding="sm" gap="sm">
          <Text size="sm" weight="medium">{`Hand off ${name} to ${seat.label}?`}</Text>
          <Text size="xs" muted>
            {`New ${name} sessions start on this account. The session on screen moves too if it is between turns; its unsent text goes along, or you are asked first.`}
          </Text>
          <Text size="xs" muted>
            {`Automatic hand-off for ${name} turns off.`}
          </Text>
          <Row justify="end" gap="xs">
            <Button size="sm" variant="ghost" onPress={() => set(confirming, null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={moving()}
              onPress={() => {
                set(confirming, null)
                void switchTo(seat.key)
              }}
            >
              Yes, hand off
            </Button>
          </Row>
        </Box>
      ) : null}
    </Box>
  )
}

// ---- settings -----------------------------------------------------------------------------

function moveSeat(seatKey: string, by: -1 | 1): void {
  void act(`move:${seatKey}`, async () => {
    await plugin.request('rotator.moveSeat', { seatKey, by })
  })
}

/** What is typed in a number or text setting and not saved yet (Enter or Save saves it). */
const drafts = atom<Record<string, string>>({})

function dropDraft(key: string): void {
  const rest = { ...read(drafts) }
  delete rest[key]
  set(drafts, rest)
}

function saveSetting(spec: SettingSpec, value: string | number | boolean): void {
  void act(
    `setting:${spec.key}`,
    async () => {
      set(settings, await plugin.request('rotator.settings', { key: spec.key, value }))
      dropDraft(spec.key)
      const shown = spec.kind === 'choice' ? (spec.options.find((o) => o.value === value)?.label ?? String(value)) : spec.kind === 'boolean' ? (value ? 'on' : 'off') : String(value) || 'empty'
      return `${spec.title}: ${shown}`
    },
    undefined,
    `setting:${spec.key}`
  )
}

/** One setting: its control, one muted line saying what the current value does (or why it does
 *  not apply right now), and the result of the last change made to it. */
function SettingRow({ spec, values }: { spec: SettingSpec; values: SettingValues }) {
  const value = values[spec.key] ?? spec.default
  const off = !applies(spec.when, values)
  const disabled = off || isBusy(`setting:${spec.key}`)
  let control: OrcaNode
  let help = spec.help
  let unsaved: OrcaNode = null
  if (spec.kind === 'choice') {
    // The options in their own order (as on Orca's Settings page), the default named.
    control = <Select label={spec.title} value={String(value)} options={spec.options.map((o) => ({ value: o.value, label: o.value === spec.default ? `${o.label} (Default)` : o.label }))} disabled={disabled} onChange={(v: string) => saveSetting(spec, v)} />
    help = spec.options.find((o) => o.value === value)?.help ?? spec.help
  } else if (spec.kind === 'boolean') {
    control = <Switch label={spec.title} checked={value === true} disabled={disabled} onChange={(v: boolean) => saveSetting(spec, v)} />
  } else {
    const typed = read(drafts)[spec.key]
    const label = spec.kind === 'number' && spec.unit ? `${spec.title} (${spec.unit})` : spec.title
    const valid = typed === undefined ? undefined : checked(spec, typed)
    control = (
      <Input
        label={label}
        value={typed ?? String(value)}
        {...(spec.kind === 'text' && spec.placeholder ? { placeholder: spec.placeholder } : {})}
        invalid={spec.kind === 'number' && typed !== undefined && valid === undefined}
        disabled={disabled}
        onChange={(v: string) => set(drafts, { ...read(drafts), [spec.key]: v })}
        onSubmit={(v: string) => {
          const ok = checked(spec, v)
          if (ok !== undefined) saveSetting(spec, ok)
        }}
      />
    )
    if (spec.kind === 'number') help = `${help} ${spec.min}–${spec.max}${spec.unit ? ` ${spec.unit}` : ''}.`
    // Typed and not saved: said in the accent, with Save and Undo, so it is not left behind.
    if (typed !== undefined && typed !== String(value)) {
      unsaved = (
        <Row justify="between" align="center" gap="sm">
          <Text size="xs" tone={valid === undefined ? 'danger' : 'accent'}>
            {valid === undefined && spec.kind === 'number'
              ? `Not saved: enter a number, ${spec.min}–${spec.max}.`
              : spec.kind === 'number' && String(valid) !== typed.trim()
                ? `Not saved yet. Saves as ${valid} (${spec.min}–${spec.max}).`
                : 'Not saved yet. Press Enter or Save.'}
          </Text>
          <Row gap="xs">
            <Button size="xs" variant="ghost" onPress={() => dropDraft(spec.key)}>
              Undo
            </Button>
            <Button size="xs" variant="outline" disabled={disabled || valid === undefined} onPress={() => valid !== undefined && saveSetting(spec, valid)}>
              Save
            </Button>
          </Row>
        </Row>
      )
    }
  }
  return (
    <Stack gap="xs">
      {control}
      {unsaved ?? (
        <Text size="xs" muted>
          {off ? spec.when!.why : help}
        </Text>
      )}
      {spec.key === 'timing' && value === 'early' && read(snapshot)?.userHere ? (
        <Text size="xs" tone="warning">
          Right now you are using Orca, so sessions hand off only at a limit.
        </Text>
      ) : null}
      <NoteLine at={`setting:${spec.key}`} />
    </Stack>
  )
}

/** Advanced, in groups. A key not named here (a setting added later) goes under Other. */
const ADVANCED_GROUPS: { title: string; keys: string[] }[] = [
  { title: 'Early hand-offs', keys: ['away_minutes', 'early_minutes', 'early_percent_left', 'idle_minutes', 'switch_cooldown_minutes'] },
  { title: 'Session on screen', keys: ['active_countdown_seconds', 'active_presence_seconds', 'active_reminder_minutes'] },
  { title: 'Limits and errors', keys: ['restore_unsent_text', 'auto_message', 'max_api_retries', 'model_fallback', 'model_window_policy', 'default_cooldown_minutes'] },
  { title: 'Other', keys: [] }
]

function advancedGroups(): { title: string; specs: SettingSpec[] }[] {
  const named = new Set(ADVANCED_GROUPS.flatMap((g) => g.keys))
  return ADVANCED_GROUPS.map((g) => ({
    title: g.title,
    specs: g.keys.length ? ADVANCED_SETTINGS.filter((s) => g.keys.includes(s.key)) : ADVANCED_SETTINGS.filter((s) => !named.has(s.key))
  })).filter((g) => g.specs.length > 0)
}

/** One group of advanced settings. When none of them applies, the group says why once instead of
 *  showing a column of greyed-out fields. */
function SettingGroup({ title, specs, values }: { title: string; specs: SettingSpec[]; values: SettingValues }) {
  const allOff = specs.every((s) => s.when && !applies(s.when, values))
  return (
    <Stack gap="sm">
      <Heading level={3}>{title}</Heading>
      {allOff ? (
        <Text size="xs" muted>
          {[...new Set(specs.map((s) => s.when!.why))].join(' ')}
        </Text>
      ) : (
        specs.map((spec) => <SettingRow key={spec.key} spec={spec} values={values} />)
      )}
    </Stack>
  )
}

function SettingsView() {
  const values = read(settings)
  if (!values) return <Skeleton shape="text" lines={4} label="Loading settings" />
  return (
    <Stack gap="md">
      {/* What matters most first: how and when sessions hand off. */}
      <Heading level={2}>Hand-off</Heading>
      {BASIC_SETTINGS.map((spec) => (
        <SettingRow key={spec.key} spec={spec} values={values} />
      ))}
      <Collapsible title="Advanced" description="Fine-tuning. The defaults suit most people.">
        <Stack gap="lg">
          {advancedGroups().map((g) => (
            <SettingGroup key={g.title} title={g.title} specs={g.specs} values={values} />
          ))}
        </Stack>
      </Collapsible>
      <Separator />
      <Stack gap="xs">
        <Heading level={2}>Claude status line</Heading>
        <ConsoleLineRow />
        <ConsoleLineReason />
        <NoteLine at="consoleLine" />
        {STATUS_LINE_SETTINGS.map((spec) => <SettingRow key={spec.key} spec={spec} values={values} />)}
      </Stack>
      <Text size="xs" muted>
        The same settings are on Orca's Settings page under Plugins → Auto Hand-off.
      </Text>
    </Stack>
  )
}

/** Claude only: the console status line is per workspace, so the switch names the focused one.
 *  A placeholder while it is read, so the section does not jump; a line when it could not be. */
function ConsoleLineRow() {
  const state = read(consoleLine)
  if (state === undefined) return <Skeleton shape="text" lines={1} label="Loading status line" />
  if (state === null) {
    return (
      <Text size="xs" muted>
        Couldn't read the status line for this workspace. It updates when you switch workspaces.
      </Text>
    )
  }
  return (
    <Row gap="xs" align="center">
      <Switch
        label="Status line"
        checked={state.installed}
        disabled={isBusy('consoleLine') || !state.workspace}
        onChange={(enabled: boolean) =>
          act(
            'consoleLine',
            async () => {
              const next = await plugin.request('rotator.consoleLine', { enabled })
              set(consoleLine, next)
              return next.message
            },
            undefined,
            'consoleLine'
          )
        }
      />
    </Row>
  )
}

/** Why the Status line switch is disabled, as the worker gives it: one short muted line. */
function ConsoleLineReason() {
  const state = read(consoleLine)
  if (!state || state.workspace || !state.reason) return null
  return (
    <Text size="xs" muted>
      {`Status line: ${state.reason.charAt(0).toLowerCase()}${state.reason.slice(1)}`}
    </Text>
  )
}

function ServiceSection({ provider, snap, now }: { provider: Provider; snap: Snapshot; now: number }) {
  const seats = snap.seats.filter((s) => s.provider === provider)
  const on = snap.services?.[provider] !== false
  const name = PROVIDER_NAME[provider]
  // Ready means there is room to hand off to: a limited account (cooling down) and a drained one
  // (10 % or less left in a window) are not, and are counted apart.
  const states = seats.map((s) => seatStatus(s, now).word)
  const limited = states.filter((w) => w === 'limited').length
  const drained = states.filter((w) => w === 'drained').length
  const summary = [
    `${seats.length - limited - drained} of ${seats.length} ready`,
    drained ? `${drained} drained` : null,
    limited ? `${limited} limited` : null
  ]
    .filter(Boolean)
    .join(' · ')
  const rank: Tone[] = ['danger', 'warning', 'success', 'neutral']
  const active = seats.find((s) => s.active)
  // The service light follows the account in use; with none in use, the worst standby.
  const light: SeatStatus = active
    ? seatStatus(active, now)
    : { tone: rank.find((t) => seats.some((s) => seatStatus(s, now).tone === t)) ?? 'neutral', word: '', filled: false, dim: true }
  // The service of the agent the user is working with (see `Snapshot.focused`) is outlined in
  // the accent so it stands out from the other services at a glance. No wash behind any service:
  // colour is kept for state, and the brand tile carries the brand.
  const focused = snap.focused === provider
  const order = snap.order?.[provider]
  const sorted = order ? [...seats].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)) : [...seats].sort(seatOrder(now))
  return (
    <Box border={focused ? 'accent' : true} radius="lg" padding="sm" gap="xs">
      {/* One header line: the service on the left, how many accounts have room on the right. */}
      <Row justify="between" align="center" gap="sm" wrap>
        <Row gap="xs" align="center">
          <Box width={12} height={12} shrink={false}>
            <Image src={brandMark(provider)} alt="" size="full" fit="contain" />
          </Box>
          <Text size="xs" weight="semibold" muted>
            {name.toUpperCase()}
          </Text>
          {/* Right after the service name: the service of the agent in the focused terminal. */}
          {focused ? (
            <Text size="xs" weight="medium">
              · on screen
            </Text>
          ) : null}
        </Row>
        <Row gap="xs" align="center">
          {/* The service light: it follows the account in use, as the summary beside it does. */}
          <StatusDot tone={light.tone} filled={light.filled} dim={light.dim} />
          <Text size="xs" muted>
            {summary}
          </Text>
        </Row>
      </Row>
      {provider === 'antigravity' && seats.length < 2 ? (
        <Text muted size="xs">
          To add another Antigravity account: save the current sign-in in Orca Settings → AI Provider Accounts, sign in with the other account in Antigravity, save it there too, then refresh.
        </Text>
      ) : null}
      {/* This service alone. With one account there is nothing to switch to, so no switch,
          unless it was turned off elsewhere (Orca's Settings page): then it is shown, so it can be
          turned on again. Not while every service only counts as off (`Snapshot.held`): nobody
          turned it off, and the callout at the top says why. */}
      {!snap.held && (seats.length > 1 || !on) ? (
        <Switch
          key={`auto-${provider}`}
          label={`Automatic hand-off for ${name}`}
          checked={on}
          disabled={isBusy(`service:${provider}`)}
          onChange={(enabled: boolean) =>
            act(`service:${provider}`, async () => {
              const { services } = await plugin.request('rotator.setService', { provider, enabled })
              const current = read(snapshot)
              if (current) show({ ...current, services })
              return `${name}: automatic hand-off ${enabled ? 'on' : 'off'}`
            })
          }
        />
      ) : null}
      {!on && !snap.held ? (
        <Text size="xs" tone="warning">
          {`Automatic hand-off for ${name} is off: sessions are not handed off and limits are not handled.`}
        </Text>
      ) : null}
      {/* "Hand off to this account" moves the session in the focused terminal, so only the
          service of that terminal's agent offers it; the others say how to get it. */}
      {!focused && seats.length > 1 ? (
        <Text size="xs" muted>
          {`To hand off by hand, focus a ${name} terminal.`}
        </Text>
      ) : null}
      {/* Custom order: the accounts in that order, with arrows to change it; otherwise in use
          first, then by room. Rows split by hairlines, not cards inside the block. */}
      {sorted.map((s, i, all) => (
        <Stack key={s.key} gap="none">
          <Separator />
          <SeatCard
            seat={s}
            now={now}
            switchable={focused && seats.length > 1}
            skippable={seats.length > 1}
            {...(order && all.length > 1 ? { place: { first: i === 0, last: i === all.length - 1 } } : {})}
          />
        </Stack>
      ))}
    </Box>
  )
}

function Accounts({ snap }: { snap: Snapshot }) {
  const now = Date.now()
  // Orca's order, except that the service of the agent the user is working with comes first.
  const providers = PROVIDERS.filter((p) => snap.seats.some((s) => s.provider === p)).sort(
    (a, b) => Number(b === snap.focused) - Number(a === snap.focused)
  )
  // Accounts belong to the Orca that runs the agent: for a project on a paired server the tab
  // shows that server's accounts and says so, since they differ from this computer's.
  const where = (
    <>
      {snap.server ? (
        <Text size="xs" muted>
          This project runs on Orca server {snap.server}; the accounts below are that server's.
        </Text>
      ) : null}
      {snap.sshHost ? (
        <Callout tone="warning" title={`This project runs on SSH target ${snap.sshHost}`}>
          Orca manages no accounts there: its agents use that machine's own login, so the accounts below do not apply to it and its sessions are left alone.
        </Callout>
      ) : null}
    </>
  )
  if (providers.length === 0) {
    return (
      <Stack gap="md">
        {where}
        <EmptyState title="No accounts" description="Manage sign-ins in Orca Settings → AI Provider Accounts." icon="agent">
          <Button size="sm" variant="outline" icon="refresh" disabled={isBusy('refresh')} onPress={() => act('refresh', () => load(true))}>
            Refresh
          </Button>
        </EmptyState>
      </Stack>
    )
  }
  return (
    <Stack gap="md">
      {where}
      {providers.map((p) => (
        <ServiceSection key={p} provider={p} snap={snap} now={now} />
      ))}
    </Stack>
  )
}

// ---- live quota ---------------------------------------------------------------------------

/** An account that can be checked directly: one saved in Orca (not the agent's own login). */
const checkable = (s: SeatRow): boolean => s.accountId !== 'system'

/** One account's direct check: on (and how it went), off by hand, or not available (and why).
 *  `button` is what the row offers: Turn off, Turn on, or nothing (a check cannot serve it). */
type QuotaState = { word: string; tone: Tone; dim: boolean; filled: boolean; detail?: string; button?: 'off' | 'on' }
function quotaState(seat: SeatRow): QuotaState {
  const name = PROVIDER_NAME[seat.provider]
  if (seat.quotaUnavailable) return { word: 'Not available', tone: 'neutral', dim: true, filled: false, detail: capital(seat.quotaUnavailable) }
  if (seat.quotaOff || !seat.quotaLinked) {
    // Off by hand: stays off. Neither on nor off: turned on at the next read.
    return seat.quotaOff ? { word: 'Off', tone: 'neutral', dim: true, filled: false, button: 'on' } : { word: 'Starting', tone: 'neutral', dim: true, filled: false }
  }
  const on = (s: Omit<QuotaState, 'button' | 'filled'>): QuotaState => ({ ...s, filled: true, button: 'off' })
  switch (seat.directQuotaIssue?.reason) {
    case undefined:
      break
    case 'rate-limited':
      return on({ word: 'Rate-limited', tone: 'warning', dim: false })
    case 'stale-token':
      return on({ word: 'Sign-in expired', tone: 'warning', dim: false, detail: `Updates once ${name} renews it, or sign in again in Orca.` })
    case 'sign-in':
      return on({ word: 'Sign-in needed', tone: 'warning', dim: false, detail: 'Sign in to this account again in Orca.' })
    case 'native-sign-in-required':
      return on({ word: 'Sign-in needed', tone: 'warning', dim: false, detail: `Sign in to this account in ${name} first.` })
    case 'no-usage-api':
      return { word: 'Not available', tone: 'neutral', dim: true, filled: false, detail: `${name} offers no direct check.` }
    default:
      return on({ word: 'Check failed', tone: 'warning', dim: false })
  }
  const { source, origin } = seat.usage
  if (origin && origin !== 'pane') return on(source === 'live' ? { word: 'Live', tone: 'success', dim: false } : { word: 'Checked', tone: 'neutral', dim: true })
  return on({ word: 'Pending', tone: 'neutral', dim: true })
}

/** Accounts whose direct check is on and needs a look, for the tab's label. */
function quotaIssues(snap: Snapshot): number {
  return snap.seats.filter((s) => checkable(s) && quotaState(s).tone === 'warning').length
}

/** One account: its name, the state of its direct check, and Turn off or Turn on; a second line
 *  only when there is something to say (why not, what to do, or when it retries). */
function QuotaRow({ seat, now }: { seat: SeatRow; now: number }) {
  const state = quotaState(seat)
  const issue = seat.directQuotaIssue
  const checkedAt = state.word === 'Live' || state.word === 'Checked' ? seat.usage.asOf : undefined
  const retryAt = issue?.reason === 'rate-limited' && issue.retryAt > now ? issue.retryAt : undefined
  return (
    <Stack gap="none">
      <Row justify="between" align="center" gap="sm">
        <Row gap="xs" align="center">
          <StatusDot tone={state.tone} filled={state.filled} dim={state.dim} />
          <Text size="sm" truncate>
            {seat.label}
          </Text>
        </Row>
        <Row gap="xs" align="center">
          <Text size="xs" tone={state.tone} muted={state.dim}>
            {state.word}
            {checkedAt ? (
              <>
                {' · '}
                <RelativeTime at={checkedAt} format="short" muted />
              </>
            ) : null}
          </Text>
          {state.button ? (
            <Button
              size="xs"
              variant={state.button === 'on' ? 'outline' : 'ghost'}
              tooltip={state.button === 'off' ? 'Stop checking this account directly. It stays off until you turn it on.' : "Check this account's usage directly again"}
              disabled={isBusy(`quotaLink:${seat.key}`)}
              onPress={() =>
                act(`quotaLink:${seat.key}`, async () => {
                  show(await plugin.request('rotator.linkQuota', { seatKey: seat.key, linked: state.button === 'on' }))
                })
              }
            >
              {state.button === 'off' ? 'Turn off' : 'Turn on'}
            </Button>
          ) : null}
        </Row>
      </Row>
      {state.detail || retryAt ? (
        <Text size="xs" muted>
          {state.detail ?? null}
          {retryAt ? (
            <>
              {state.detail ? ' ' : ''}Retries <RelativeTime at={retryAt} muted />.
            </>
          ) : null}
        </Text>
      ) : null}
    </Stack>
  )
}

/** Live Quota: ask the providers for usage directly. Every saved account a check can serve is on
 *  by itself (the daemon's `quotaStatus`); Turn off is remembered. One line of why, one button
 *  for all, then one row per account. The numbers stay on the Accounts tab. */
function QuotaView({ snap }: { snap: Snapshot }) {
  const now = Date.now()
  const seats = snap.seats.filter(checkable)
  if (snap.server) {
    return (
      <EmptyState
        title="Not for a remote project"
        description={`This project runs on Orca server ${snap.server}. Direct checks work for accounts on this computer.`}
        icon="activity"
      />
    )
  }
  if (seats.length === 0) {
    return <EmptyState title="No saved accounts" description="Save sign-ins in Orca Settings → AI Provider Accounts; they are checked directly once saved." icon="activity" />
  }
  const on = seats.filter((s) => quotaState(s).button === 'off').length
  const checking = isBusy('directQuota')
  const providers = PROVIDERS.filter((p) => seats.some((s) => s.provider === p))
  return (
    <Stack gap="md">
      <Stack gap="xs">
        <Row justify="between" align="center" gap="sm">
          <Text size="sm" weight="medium">
            {`${on} checked directly`}
          </Text>
          <Button size="xs" variant="outline" icon="refresh" disabled={on === 0 || checking} onPress={() => act('directQuota', () => load(true, true))}>
            {checking ? 'Checking…' : 'Check now'}
          </Button>
        </Row>
        <Text size="xs" muted>
          Saved accounts are checked with their provider in the background, so accounts not in use stay current too. The numbers show on Accounts.
        </Text>
      </Stack>
      {providers.map((p) => (
        <Stack key={p} gap="xs">
          <Row gap="xs" align="center">
            <Box width={12} height={12} shrink={false}>
              <Image src={brandMark(p)} alt="" size="full" fit="contain" />
            </Box>
            <Text size="xs" weight="semibold" muted>
              {PROVIDER_NAME[p].toUpperCase()}
            </Text>
          </Row>
          {seats
            .filter((s) => s.provider === p)
            .map((s) => (
              <Stack key={s.key} gap="xs">
                <Separator />
                <QuotaRow seat={s} now={now} />
              </Stack>
            ))}
        </Stack>
      ))}
    </Stack>
  )
}

// ---- history ------------------------------------------------------------------------------

/** The day an entry belongs to, as a heading: Today, Yesterday, then the weekday and date. */
function dayLabel(at: number, now: number): string {
  const start = (t: number) => {
    const d = new Date(t)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const days = Math.round((start(now) - start(at)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return new Date(at).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

function History({ snap }: { snap: Snapshot }) {
  const label = (key: string | undefined) => snap.seats.find((s) => s.key === key)?.label ?? key ?? ''
  const entries = [...snap.history].reverse()
  if (entries.length === 0) {
    return <EmptyState title="No hand-offs yet" description="Hand-offs of the last 7 days appear here." icon="activity" />
  }
  const now = Date.now()
  return (
    <Stack gap="xs">
      <Text size="xs" muted>
        {`Last 7 days · ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`}
      </Text>
      {/* The whole tab: the panel scrolls, not a box of its own. Entries under their day. */}
      <Stack gap="none">
        {entries.map((h, i) => {
          const day = dayLabel(h.at, now)
          const first = i === 0 || dayLabel(entries[i - 1]!.at, now) !== day
          return (
            <Stack key={`${h.at}-${i}`} gap="none">
              {first ? (
                <Box paddingY={i === 0 ? 'none' : 'sm'}>
                  <Text size="xs" weight="semibold" muted>
                    {day}
                  </Text>
                </Box>
              ) : null}
              <Separator />
              <Box paddingY="sm" gap="none">
                <Row justify="between" align="center" gap="sm">
                  <Row gap="xs" align="center" wrap>
                    <Text size="sm" weight="medium">
                      {PROVIDER_NAME[h.provider] ?? h.provider} · {REASON_WORDS[h.reason] ?? h.reason}
                    </Text>
                    <Badge tone={RESULT_TONE[h.result] ?? 'neutral'}>{resultWords(h)}</Badge>
                  </Row>
                  <RelativeTime at={h.at} format="short" muted />
                </Row>
                <Text size="xs" muted truncate>
                  {h.to && h.to !== h.from ? `${label(h.from)} → ${label(h.to)}` : label(h.from)}
                </Text>
                {h.why ? <Text size="xs">{capital(h.why)}</Text> : null}
                {h.detail ? (
                  <Text size="xs" muted>
                    {h.detail}
                  </Text>
                ) : null}
                {/* Unsent text that went with the session and could not be put back: kept whole, to copy. */}
                {h.unsent ? (
                  <Stack gap="xs">
                    <Text size="xs" tone="warning">
                      Your unsent text, not put back:
                    </Text>
                    <Code block>{h.unsent}</Code>
                  </Stack>
                ) : null}
              </Box>
            </Stack>
          )
        })}
      </Stack>
    </Stack>
  )
}

// ---- panel --------------------------------------------------------------------------------

/** *Hand off now*: the worker says why, when it could not hand the session off. */
function handOffNow(terminalId: string): Promise<void> {
  return act(`now:${terminalId}`, async () => (await plugin.request('rotator.handoffNow', { terminalId })).message)
}

/** *Not now*: the session on screen waits for another tab, with no countdown. */
function notNow(terminalId: string): Promise<void> {
  return act(`decline:${terminalId}`, async () => {
    await plugin.request('rotator.declineHandoff', { terminalId })
    return 'It waits until you switch to another tab'
  })
}

function Waiting({ snap }: { snap: Snapshot }) {
  if (snap.waiting.length === 0) return null
  // Paused, or the service off: nothing hands off by itself, so no countdown is shown as if it ran.
  const stopped = (w: Snapshot['waiting'][number]) => snap.paused || snap.services?.[w.agent] === false
  const stoppedWords = (w: Snapshot['waiting'][number]) =>
    snap.paused
      ? 'Automatic hand-off is paused, so it waits until you turn it on.'
      : snap.held
        ? `${HELD_WORDS[snap.held]?.title ?? 'Auto Hand-off is not ready'}, so it waits.`
        : `Automatic hand-off is off for ${PROVIDER_NAME[w.agent] ?? w.agent}, so it waits until you turn it on.`
  // Text that cannot go along keeps the session where it is whatever is answered: its line says
  // that, not the question or a countdown.
  // (Asked under "Ask me first" and the setting changed since: its line then says what the new
  // setting does, without the question's "then counts down".)
  const asks = (w: Snapshot['waiting'][number]) => w.activeSince !== undefined && w.asked && !w.declined && !w.draftAt && (snap.activeTerminal ?? 'ask') === 'ask'
  // A hand-off at a limit that is tried again at the next look (the last look found the session
  // busy or being typed in, or the hand-off failed and another account is next).
  const retrying = (w: Snapshot['waiting'][number]) => w.reason !== undefined && w.reason !== 'reset' && w.activeSince === undefined && !w.draftAt
  const held = snap.waiting.some((w) => w.activeSince !== undefined || w.draftAt !== undefined || retrying(w))
  const asking = snap.waiting.some(asks)
  return (
    <Callout tone="warning" title={asking ? 'Hand off the session on screen?' : held ? 'Waiting to hand off' : 'Waiting for a limit to reset'}>
      <Stack gap="xs">
        {snap.waiting.map((w) =>
          // "Ask me first": the question, until it is answered (or the session moves).
          asks(w) ? (
            <Stack key={w.terminalId} gap="xs">
              <Text size="sm" weight="medium">
                {w.reason === 'reset'
                  ? `An account is free again for the ${PROVIDER_NAME[w.agent] ?? w.agent} session on screen. Hand it off now?`
                  : `${PROVIDER_NAME[w.agent] ?? w.agent} hit its limit in the session on screen. Hand it off to another account now?`}
              </Text>
              <Text size="xs" muted>
                {stopped(w) ? (
                  stoppedWords(w)
                ) : w.countdownUntil !== undefined ? (
                  <>
                    If you do not answer, it hands off <RelativeTime at={w.countdownUntil} />.
                  </>
                ) : (
                  'If you do not answer, it waits while you are using Orca, then counts down.'
                )}
              </Text>
              <Row justify="end" gap="xs">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={moving()}
                  onPress={() => notNow(w.terminalId)}
                >
                  Not now
                </Button>
                <Button size="sm" variant="outline" disabled={moving()} onPress={() => handOffNow(w.terminalId)}>
                  Hand off now
                </Button>
              </Row>
            </Stack>
          ) : (
          <Row key={w.terminalId} justify="between" align="center" gap="sm">
            <Text size="xs">
              {stopped(w) ? (
                <>
                  {PROVIDER_NAME[w.agent] ?? w.agent} session waits. {stoppedWords(w)}
                </>
              ) : w.draftAt && w.unchecked ? (
                <>{PROVIDER_NAME[w.agent] ?? w.agent} session hands off once Orca can say that it is between turns with an empty input box</>
              ) : w.draftAt && w.queued ? (
                <>{PROVIDER_NAME[w.agent] ?? w.agent} session hands off once its queued messages are sent or cleared</>
              ) : w.draftAt ? (
                <>{PROVIDER_NAME[w.agent] ?? w.agent} session hands off once the text typed in it is sent or cleared</>
              ) : w.activeSince !== undefined && w.countdownUntil !== undefined ? (
                <>
                  {PROVIDER_NAME[w.agent] ?? w.agent} session on screen hands off <RelativeTime at={w.countdownUntil} />
                </>
              ) : w.activeSince !== undefined ? (
                <>
                  {PROVIDER_NAME[w.agent] ?? w.agent} session on screen hands off when you switch to another tab
                  {w.declined || snap.activeTerminal === 'wait' ? '' : ' or step away'}
                </>
              ) : retrying(w) ? (
                `${PROVIDER_NAME[w.agent] ?? w.agent} session hands off in a moment${w.failures ? ', to another account' : ''}`
              ) : (
                <>
                  {PROVIDER_NAME[w.agent] ?? w.agent} session resumes <RelativeTime at={w.wakeAt} />
                </>
              )}
            </Text>
            <Row gap="xs" align="center">
              {/* Not now: no countdown, it waits for another tab (Cancel gives up the hand-off). */}
              {w.activeSince !== undefined && !w.declined && snap.activeTerminal !== 'wait' && !stopped(w) ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={moving()}
                  onPress={() => notNow(w.terminalId)}
                >
                  Not now
                </Button>
              ) : null}
              {w.activeSince !== undefined ? (
                <Button size="xs" variant="outline" disabled={moving()} onPress={() => handOffNow(w.terminalId)}>
                  Hand off now
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="ghost"
                disabled={moving()}
                onPress={() => act(`cancel:${w.terminalId}`, async () => {
                  await plugin.request('rotator.cancelWaiting', { terminalId: w.terminalId })
                })}
              >
                {w.activeSince !== undefined ? "Don't hand off" : 'Cancel'}
              </Button>
            </Row>
          </Row>
          )
        )}
      </Stack>
    </Callout>
  )
}

export default function Panel() {
  const snap = read(snapshot)
  if (!snap) return <Skeleton shape="text" lines={6} label="Loading accounts" />
  const stored = read(tab)
  const current = (TABS as readonly string[]).includes(stored) ? stored : 'accounts'
  // The History tab counts only what needs a look: hand-offs that failed.
  const failed = snap.history.filter((h) => h.result === 'failed').length
  // Live Quota counts only what needs a look: linked accounts whose check is in trouble.
  const issues = quotaIssues(snap)
  return (
    <Stack gap="md">
      <Row justify="between" align="center" gap="sm">
        {/* On a narrow panel the badge goes under the title, whole, rather than split both. */}
        <Row gap="sm" align="center" wrap>
          <Heading>Auto Hand-off</Heading>
          {/* What automatic hand-off is doing now, in one pill (Orca's Badge colours only a dot,
              so it is drawn): amber while paused, green while early hand-offs are on or wait for
              the user to step away, grey while sessions move only at a limit. Not while every
              service only counts as off (`Snapshot.held`): the callout below says what is
              happening, and a green "on" beside it would say the opposite. */}
          {snap.paused || (snap.mode && !snap.held) ? (
            (() => {
              const state = badgeState(snap)
              return (
                <Box background={state.tone === 'neutral' ? 'muted' : state.tone} border={state.plain ? true : state.tone} radius="full" paddingX="sm" shrink={false}>
                  <Row gap="xs" align="center">
                    <Text size="xs" tone={state.tone}>
                      {BADGE_SYMBOL[state.mark]}
                    </Text>
                    <Text size="xs" weight="semibold" tone={state.tone}>
                      {state.label}
                    </Text>
                  </Row>
                </Box>
              )
            })()
          ) : null}
        </Row>
        <IconButton
          icon="refresh"
          label="Refresh usage from Orca"
          variant="ghost"
          size="sm"
          disabled={isBusy('refresh')}
          onPress={() => act('refresh', () => load(true))}
        />
      </Row>

      <Row justify="between" align="center" gap="sm">
        <Switch
          label="Automatic hand-off, all services"
          checked={!snap.paused}
          disabled={isBusy('pause')}
          onChange={(on: boolean) =>
            act('pause', async () => {
              await plugin.request('rotator.pause', { paused: !on })
            })
          }
        />
        {snap.updatedAt ? (
          <Text size="xs" muted>
            Usage read <RelativeTime at={snap.updatedAt} format="short" muted />
          </Text>
        ) : null}
      </Row>

      {/* Every service counts as off though nobody turned one off: why, and that it ends by itself. */}
      {snap.held && HELD_WORDS[snap.held] ? (
        <Callout tone="warning" title={HELD_WORDS[snap.held].title}>
          {HELD_WORDS[snap.held].body}
        </Callout>
      ) : null}
      {snap.error ? (
        <Callout tone="danger" title="Cannot read accounts">
          {snap.error}
        </Callout>
      ) : null}
      <Waiting snap={snap} />
      <NoteLine />

      <Tabs label="View" value={current} onChange={(v: string) => set(tab, v)}>
        <Tab value="accounts" label="Accounts">
          <Accounts snap={snap} />
        </Tab>
        <Tab value="proxy" label={issues ? `Live Quota · ${issues}` : 'Live Quota'}>
          <QuotaView snap={snap} />
        </Tab>
        <Tab value="history" label={failed ? `History · ${failed} failed` : 'History'}>
          <History snap={snap} />
        </Tab>
        <Tab value="settings" label="Settings">
          <SettingsView />
        </Tab>
      </Tabs>
    </Stack>
  )
}
