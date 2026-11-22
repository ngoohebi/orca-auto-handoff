// Auto Hand-off panel: every account's usage, cooldowns, waiting sessions, the hand-off history
// and the settings.
//
// What it changes goes through the worker: automatic hand-off on or off (all, or per service),
// "Hand off to this account", the custom order's arrows, clearing a cooldown, answering
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
import type { SettingValues, Snapshot, UnsentDraft } from './protocol'
import { ADVANCED_SETTINGS, applies, BASIC_SETTINGS, checked, type SettingSpec } from './core/settings.ts'
import { PROVIDERS, type Provider } from './core/types.ts'
import { VERSION } from './core/version.ts'

/** The panel's first line, the switch for everything: named as the panel is in Orca's sidebar
 *  (orca-plugin.json), whose header shows only the panel's icon. */
export const PANEL_TITLE = `OAH (Orca Auto Hand-off) v${VERSION}`

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
/** The tabs there are. Any other stored tab (Live Quota, from an earlier version) opens Accounts. */
const TABS = ['accounts', 'history', 'settings'] as const
const tab = atom('tab', 'accounts', { persist: 'plugin' })
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

async function load(refresh = false, directQuota = false): Promise<void> {
  const mine = opening
  const next = await plugin.request('rotator.snapshot', { refresh, ...(directQuota ? { directQuota } : {}) })
  if (mine !== opening) return
  show(next)
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
 *  current terminal's agent belongs to, every second. The daemon asks Orca over its local socket
 *  (a millisecond or two, no process started), and the next question is asked only after the
 *  answer. (A workspace or agent change is pushed by the worker at once anyway.) */
const FOCUS_POLL_MS = 1_000
const FOCUS_POLL_MAX_MS = 1_000

export function setup(ctx: PanelContext): void {
  opening++
  ctx.subscriptions.push(plugin.on('rotator.changed', (payload) => show(payload)))
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
  // The first read can race the worker's restart: the worker's next push then fills the list.
  void load().catch(() => undefined)
}

// ---- wording ------------------------------------------------------------------------------

/** Brand colours cannot be given to Orca's components (only theme tones), so each service's
 *  colour ships as a small image in assets/brand: a rounded tile before its name, like an app
 *  icon, so nothing in the block but the usage bars is a bar. Claude is Anthropic's terracotta,
 *  Codex OpenAI's green, Antigravity Google's blue, Devin Cognition's blue; OpenCode's mark is
 *  near-black, so a light neutral stands in. */
const brandMark = (p: Provider) => `assets/brand/${p}-mark.png`
/** What automatic hand-off is doing right now, beside its switch: the state only, in words that
 *  need no legend (how accounts are picked is on the Settings tab). Colour backs the words:
 *  amber while paused, green while early hand-offs are on or wait for you to step away, quiet
 *  while sessions move only at a limit. */
function handOffState(snap: Snapshot): { label: string; tone: Tone } {
  if (snap.paused) return { label: 'Paused', tone: 'warning' }
  if (snap.atLimitOnly) return { label: 'At limit only', tone: 'neutral' }
  if (snap.userHere) return { label: 'Early once you step away', tone: 'success' }
  return { label: 'Early hand-offs on', tone: 'success' }
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
  // A current reading needs no line, whether Orca or Live quota took it.
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

/** Live quota could not ask the provider for this account: what to do, in one muted line. Only
 *  what needs a look; "this service cannot" is said once, in Settings. */
function DirectIssue({ seat, now }: { seat: SeatRow; now: number }) {
  const issue = seat.quotaLinked ? seat.directQuotaIssue : undefined
  if (!issue) return null
  const name = PROVIDER_NAME[seat.provider]
  const words =
    issue.reason === 'rate-limited'
      ? 'Live quota: rate-limited for now.'
      : issue.reason === 'stale-token'
        ? `Live quota: sign-in expired; it updates once ${name} renews it.`
        : issue.reason === 'sign-in'
          ? 'Live quota: sign in to this account again in Orca.'
          : issue.reason === 'native-sign-in-required'
            ? `Live quota: sign in to this account in ${name} first.`
            : issue.reason === 'no-usage-api'
              ? null
              : 'Live quota: could not check this account.'
  if (!words) return null
  return (
    <Text size="xs" tone="warning">
      {words}
      {issue.reason === 'rate-limited' && issue.retryAt > now ? (
        <>
          {' '}Retries <RelativeTime at={issue.retryAt} tone="warning" />.
        </>
      ) : null}
    </Text>
  )
}

/** The one look for a small action anywhere in the panel: small text in a clearly visible
 *  neutral outline, twice a hairline thick (Orca draws every border one line thin, so two
 *  bordered boxes sit inside one another), around a button with no outline of its own. `main`:
 *  the one stronger action of a question, a small solid button. */
function SmallAction({ label, tooltip, disabled, main, onPress }: { label: string; tooltip?: string; disabled?: boolean; main?: boolean; onPress: () => void }) {
  const props = { size: 'xs' as const, disabled: !!disabled, onPress, ...(tooltip ? { tooltip } : {}) }
  if (main) {
    return (
      <Button variant="solid" {...props}>
        {label}
      </Button>
    )
  }
  return (
    <Box border="neutral" radius="md" shrink={false}>
      <Box border="neutral" radius="md">
        <Button variant="ghost" {...props}>
          {label}
        </Button>
      </Box>
    </Box>
  )
}

function SeatCard({ seat, now, switchable, place }: { seat: SeatRow; now: number; switchable: boolean; place?: { first: boolean; last: boolean } }) {
  const cooling = !!seat.cooldownUntil && seat.cooldownUntil > now
  const status = seatStatus(seat, now)
  const name = PROVIDER_NAME[seat.provider]
  const handOff = switchable && !seat.active && !cooling
  const draft = read(draftAsk)?.seatKey === seat.key ? read(draftAsk)!.draft : undefined
  const confirm = !draft && read(confirming) === seat.key
  const asking = !!draft || confirm
  return (
    <Box gap="xs" paddingY="xs">
      {/* Who, its state, and what can be done with it, on one line; its usage right under it. */}
      <Box direction="row" justify="between" align="center" gap="sm">
        {/* Who and its state on the left; the actions on the right edge, in line with the
            right edge of the bars. */}
        <Row gap="xs" align="center">
          <StatusDot tone={status.tone} filled={status.filled} dim={status.dim} />
          <Text truncate>{seat.label}</Text>
          <Text size="xs" tone={status.tone} muted={!!status.dim}>
            {`· ${status.word}`}
          </Text>
        </Row>
        <Row gap="xs" align="center">
          {/* Custom order: the account's place in its service's ranking. */}
          {place ? (
            <>
              <IconButton icon="collapse" label="Move up in custom order" variant="ghost" size="xs" disabled={place.first || busyWith('move:')} onPress={() => moveSeat(seat.key, -1)} />
              <IconButton icon="expand" label="Move down in custom order" variant="ghost" size="xs" disabled={place.last || busyWith('move:')} onPress={() => moveSeat(seat.key, 1)} />
            </>
          ) : null}
          {cooling ? (
            <SmallAction
              label="End cooldown"
              tooltip="Count this account as free again now"
              disabled={isBusy(`clear:${seat.key}`)}
              onPress={() => act(`clear:${seat.key}`, async () => {
                await plugin.request('rotator.clearCooldown', { seatKey: seat.key })
              })}
            />
          ) : null}
          {/* While it asks, the question sits below and the button gives way to it. */}
          {handOff && !asking ? (
            <SmallAction
              label="Early hand off"
              tooltip={`Hand ${name} off to this account now, without waiting; automatic hand-off stays on and follows its usual rules`}
              disabled={moving()}
              onPress={() => {
                // One question at a time: an older one about unsent text is dropped.
                set(draftAsk, null)
                set(confirming, seat.key)
              }}
            />
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
      {/* Where the numbers come from, and a Live quota check that needs a look. */}
      <SourceLine seat={seat} />
      <DirectIssue seat={seat} now={now} />
      {cooling ? (
        <Text size="xs" tone="danger">
          {cooldownWords(seat.cooldownReason)} · ends <RelativeTime at={seat.cooldownUntil!} tone="danger" />
        </Text>
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
            <SmallAction label="Cancel" onPress={() => set(draftAsk, null)} />
            <SmallAction
              main
              label="Hand off anyway"
              disabled={moving()}
              onPress={() => {
                const asked = read(draftAsk)
                set(draftAsk, null)
                if (asked) void switchTo(seat.key, asked.draft)
              }}
            />
          </Row>
        </Box>
      ) : handOff && confirm ? (
        <Box border="accent" radius="md" padding="sm" gap="sm">
          <Text size="sm" weight="medium">{`Early hand off ${name} to ${seat.label}?`}</Text>
          <Text size="xs" muted>
            {`New ${name} sessions start here, and the session on screen moves if it is between turns. Automatic hand-off stays on and may move sessions again by its usual rules.`}
          </Text>
          <Row justify="end" gap="xs">
            <SmallAction label="Cancel" onPress={() => set(confirming, null)} />
            <SmallAction
              main
              label="Yes, hand off"
              disabled={moving()}
              onPress={() => {
                set(confirming, null)
                void switchTo(seat.key)
              }}
            />
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
            <SmallAction label="Undo" onPress={() => dropDraft(spec.key)} />
            <SmallAction main label="Save" disabled={disabled || valid === undefined} onPress={() => valid !== undefined && saveSetting(spec, valid)} />
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

/** The basic settings about where usage readings come from, under their own heading. */
const USAGE_KEYS = ['direct_quota', 'console_statusline']

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
      {BASIC_SETTINGS.filter((spec) => !USAGE_KEYS.includes(spec.key)).map((spec) => (
        <SettingRow key={spec.key} spec={spec} values={values} />
      ))}
      {/* Where usage comes from and where it is shown: Live quota, then the Claude status line,
          which shows that usage in Claude Code. */}
      <Heading level={2}>Usage</Heading>
      {BASIC_SETTINGS.filter((spec) => USAGE_KEYS.includes(spec.key)).map((spec) => (
        <SettingRow key={spec.key} spec={spec} values={values} />
      ))}
      <Collapsible title="Advanced" description="Fine-tuning. The defaults suit most people.">
        <Stack gap="lg">
          {advancedGroups().map((g) => (
            <SettingGroup key={g.title} title={g.title} specs={g.specs} values={values} />
          ))}
        </Stack>
      </Collapsible>
      <Text size="xs" muted>
        The same settings are on Orca's Settings page under Plugins → Auto Hand-off.
      </Text>
    </Stack>
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
      {/* The header: the service and its own switch on one line; under it, how many accounts
          have room. The switch is shown only with more than one account (nothing to switch to
          otherwise), unless it was turned off elsewhere (Orca's Settings page), so it can be
          turned on again; and not while every service only counts as off (`Snapshot.held`):
          nobody turned it off, and the callout at the top says why. */}
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
        {!snap.held && (seats.length > 1 || !on) ? (
          <Switch
            key={`auto-${provider}`}
            label="Auto hand-off"
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
      </Row>
      {/* The service light follows the account in use, as the summary beside it does. "Hand off"
          moves the session in the focused terminal, so only that terminal's service offers it;
          the others say where it is. */}
      <Row gap="xs" align="center">
        <StatusDot tone={light.tone} filled={light.filled} dim={light.dim} />
        <Text size="xs" muted>
          {!focused && seats.length > 1 ? `${summary} · hand off by hand from ${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name} terminal` : summary}
        </Text>
      </Row>
      {!on && !snap.held ? (
        <Text size="xs" tone="warning">
          {`Automatic hand-off for ${name} is off: limits are not handled.`}
        </Text>
      ) : null}
      {provider === 'antigravity' && seats.length < 2 ? (
        <Text muted size="xs">
          To add another Antigravity account, save each sign-in in Orca Settings → AI Provider Accounts, then refresh.
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
          <SmallAction label="Refresh" disabled={isBusy('refresh')} onPress={() => act('refresh', () => load(true))} />
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
                <SmallAction label="Not now" disabled={moving()} onPress={() => notNow(w.terminalId)} />
                <SmallAction main label="Hand off now" disabled={moving()} onPress={() => handOffNow(w.terminalId)} />
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
                <SmallAction label="Not now" disabled={moving()} onPress={() => notNow(w.terminalId)} />
              ) : null}
              {w.activeSince !== undefined ? (
                <SmallAction main label="Hand off now" disabled={moving()} onPress={() => handOffNow(w.terminalId)} />
              ) : null}
              <SmallAction
                label={w.activeSince !== undefined ? "Don't hand off" : 'Cancel'}
                disabled={moving()}
                onPress={() => act(`cancel:${w.terminalId}`, async () => {
                  await plugin.request('rotator.cancelWaiting', { terminalId: w.terminalId })
                })}
              />
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
  return (
    <Stack gap="md">
      {/* Orca's panel header already names the panel, so the top is the one control for
          everything, alone on its line; under it, what it is doing now on the left, and how
          fresh the numbers are with the way to refresh them on the right. The state words are
          left out while every service only counts as off (`Snapshot.held`): the callout below
          says what is happening, and a green "on" beside it would say the opposite. */}
      <Stack gap="xs">
        <Switch
          label={PANEL_TITLE}
          checked={!snap.paused}
          disabled={isBusy('pause')}
          onChange={(on: boolean) =>
            act('pause', async () => {
              await plugin.request('rotator.pause', { paused: !on })
            })
          }
        />
        <Row justify="between" align="center" gap="sm">
          {snap.paused || (snap.mode && !snap.held)
            ? (() => {
                const state = handOffState(snap)
                return (
                  <Text size="xs" weight="medium" tone={state.tone} muted={state.tone === 'neutral'}>
                    {state.label}
                  </Text>
                )
              })()
            : <Box />}
          <Row gap="xs" align="center">
            {snap.updatedAt ? <RelativeTime at={snap.updatedAt} format="short" muted /> : null}
            <IconButton
              icon="refresh"
              label="Refresh usage"
              variant="ghost"
              size="sm"
              disabled={isBusy('refresh')}
              onPress={() => act('refresh', () => load(true, snap.seats.some((s) => s.quotaLinked)))}
            />
          </Row>
        </Row>
      </Stack>

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
        <Tab value="history" label="History">
          <History snap={snap} />
        </Tab>
        <Tab value="settings" label="Settings">
          <SettingsView />
        </Tab>
      </Tabs>
    </Stack>
  )
}
