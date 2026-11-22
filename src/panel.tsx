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

/** "Pick the next account", as the panel names it. */
const MODE_NAME = { smart: 'Auto', 'my-order': 'Custom order' } as const

const snapshot = atom<Snapshot | null>(null)
const busy = atom<string | null>(null)
const message = atom<string | null>(null)
const tab = atom('tab', 'accounts', { persist: 'plugin' })
/** The Claude console status line in the focused workspace; null until read. */
const consoleLine = atom<ConsoleLineState | null>(null)
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

async function load(refresh = false): Promise<void> {
  const mine = opening
  const next = await plugin.request('rotator.snapshot', { refresh })
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
 *  from it (the worker's next push brings the list up to date). */
async function act(key: string, fn: () => Promise<string | void>, reload?: () => Promise<void>): Promise<void> {
  set(busy, key)
  try {
    let text: string | void
    try {
      text = await fn()
    } catch (error) {
      set(message, `Failed: ${String((error as Error)?.message ?? error)}`)
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
    if (!refreshed) set(message, `${text ? text.replace(/[.\s]+$/, '') : 'Done'}. ${NOT_REFRESHED}`)
    else if (text) set(message, text)
  } finally {
    set(busy, null)
  }
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
const BADGE_SYMBOL = { away: '●', limit: '○', paused: '■' } as const
const HERE_MARK = 'assets/mark-here.png'

/** The service block's wash. Orca only paints theme tints, so each service takes the tone nearest
 *  its brand: amber for Claude's terracotta, green for Codex; the blue brands have no blue tint
 *  and sit on the quiet accent wash, with the brand tile carrying their colour. */
const BRAND_TINT: Record<Provider, 'muted' | Tone> = {
  claude: 'warning',
  codex: 'success',
  antigravity: 'accent',
  opencode: 'muted',
  devin: 'accent'
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

function SeatCard({ seat, now, switchable, place, skippable }: { seat: SeatRow; now: number; switchable: boolean; place?: { first: boolean; last: boolean }; skippable?: boolean }) {
  const cooling = !!seat.cooldownUntil && seat.cooldownUntil > now
  const status = seatStatus(seat, now)
  const name = PROVIDER_NAME[seat.provider]
  // "Skip": never chosen automatically (a hand-off by hand still can). It shares the last row
  // with "Hand off to this account".
  const skip = skippable ? (
    <Switch
      label="Skip"
      checked={!!seat.excluded}
      disabled={read(busy) !== null}
      onChange={(excluded: boolean) =>
        act(`exclude:${seat.key}`, async () => {
          await plugin.request('rotator.setExcluded', { seatKey: seat.key, excluded })
          return excluded ? `${seat.label}: skipped by automatic hand-off` : `${seat.label}: no longer skipped`
        })
      }
    />
  ) : null
  const handOff = switchable && !seat.active && !cooling
  const asking = read(draftAsk)?.seatKey === seat.key || read(confirming) === seat.key
  return (
    <Box border radius="md" gap="none" background="card">
      {/* Who: the account on its own line, then its usage right under it. */}
      <Box direction="row" justify="between" align="center" gap="sm" paddingX="sm" paddingY="xs">
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
              <IconButton icon="collapse" label="Move up in custom order" variant="ghost" size="xs" disabled={place.first || read(busy) !== null} onPress={() => moveSeat(seat.key, -1)} />
              <IconButton icon="expand" label="Move down in custom order" variant="ghost" size="xs" disabled={place.last || read(busy) !== null} onPress={() => moveSeat(seat.key, 1)} />
            </>
          ) : null}
        </Row>
      </Box>
      <Box paddingX="sm" paddingY="xs" gap="xs">
        {seat.usage.known ? (
          <Stack gap="xs">
            <UsageBar name="5h" window={seat.usage.session} />
            <UsageBar name="Week" window={seat.usage.weekly} />
            {seat.usage.model ? <UsageBar name={capital(seat.usage.model.name)} window={seat.usage.model} /> : null}
            {/* The pace of use, when the last readings show one; half an hour or less takes a colour. */}
            {seat.runwayMs !== undefined ? (
              <Text size="xs" tone={seat.runwayMs <= 10 * 60_000 ? 'danger' : seat.runwayMs <= 30 * 60_000 ? 'warning' : 'neutral'} muted={seat.runwayMs > 30 * 60_000}>
                {capital(runwayWords(seat.runwayMs))}
              </Text>
            ) : null}
            {seat.usage.source === 'cached' || seat.usage.source === 'projected' ? (
              <Text muted size="xs">
                Last reading {seat.usage.asOf ? <RelativeTime at={seat.usage.asOf} muted /> : null}
                {seat.usage.source === 'projected' ? ' · a window has reset since' : ''}
                {reasonText(seat) ? ` · ${reasonText(seat)}` : ''}
              </Text>
            ) : null}
          </Stack>
        ) : (
          <Text muted size="xs">
            {reasonText(seat) ?? 'No usage yet: Orca reports it once this account runs.'}
          </Text>
        )}
        {cooling ? (
          <Row justify="between" align="center" gap="sm">
            <Text size="xs" tone="danger">
              {cooldownWords(seat.cooldownReason)} · ends <RelativeTime at={seat.cooldownUntil!} tone="danger" />
            </Text>
            <Button
              size="xs"
              variant="ghost"
              disabled={read(busy) !== null}
              onPress={() => act(`clear:${seat.key}`, async () => {
                await plugin.request('rotator.clearCooldown', { seatKey: seat.key })
              })}
            >
              Clear
            </Button>
          </Row>
        ) : null}
        {/* A standby can be chosen by hand; it asks first. Automatic hand-off for the service
            then stops, so the plugin never undoes the choice; the block says so. */}
        {skip && (!handOff || asking) ? skip : null}
        {handOff ? (
          <Box>
            {read(draftAsk)?.seatKey === seat.key ? (
              <Box border="accent" radius="md" padding="sm" gap="sm">
                <Text size="sm" weight="medium">
                  {read(draftAsk)!.draft.queued
                    ? 'This session has queued messages that would be lost.'
                    : `This session shows unsent text that cannot go along: “${shownDraft(read(draftAsk)!.draft.text)}”.`}
                </Text>
                <Text size="xs" muted>
                  {read(draftAsk)!.draft.queued ? 'Hand off anyway?' : 'Hand off anyway? The text would be lost.'}
                </Text>
                <Row justify="end" gap="xs">
                  <Button size="sm" variant="ghost" onPress={() => set(draftAsk, null)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={read(busy) !== null}
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
            ) : read(confirming) === seat.key ? (
              <Box border="accent" radius="md" padding="sm" gap="sm">
                <Text size="sm" weight="medium">{`Hand off ${name} to ${seat.label}?`}</Text>
                <Text size="xs" muted>
                  New {name} sessions will start on this account.
                </Text>
                <Text size="xs" muted>
                  The session on screen is handed off too if it is between turns; a busy one stays where it is. Unsent text goes with it when it can; otherwise you are asked first.
                </Text>
                <Text size="xs" muted>
                  Automatic hand-off for {name} turns off, so it won't hand off again on its own.
                </Text>
                <Row justify="end" gap="xs">
                  <Button size="sm" variant="ghost" onPress={() => set(confirming, null)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={read(busy) !== null}
                    onPress={() => {
                      set(confirming, null)
                      void switchTo(seat.key)
                    }}
                  >
                    Yes, hand off
                  </Button>
                </Row>
              </Box>
            ) : (
              <Row justify="between" align="center">
                {skip ?? <Box />}
                <Button
                  size="xs"
                  variant="outline"
                  icon="next"
                  tooltip={`Hand ${name} off to this account now, instead of waiting for automatic hand-off`}
                  disabled={read(busy) !== null}
                  onPress={() => {
                    // One question at a time: an older one about unsent text is dropped.
                    set(draftAsk, null)
                    set(confirming, seat.key)
                  }}
                >
                  Hand off to this account
                </Button>
              </Row>
            )}
          </Box>
        ) : null}
      </Box>
    </Box>
  )
}

// ---- settings -----------------------------------------------------------------------------

function moveSeat(seatKey: string, by: -1 | 1): void {
  void act(`move:${seatKey}`, async () => {
    await plugin.request('rotator.moveSeat', { seatKey, by })
  })
}

/** What is typed in a number or text setting and not saved yet (Enter saves it). */
const drafts = atom<Record<string, string>>({})

function saveSetting(spec: SettingSpec, value: string | number | boolean): void {
  void act(`setting:${spec.key}`, async () => {
    set(settings, await plugin.request('rotator.settings', { key: spec.key, value }))
    const rest = { ...read(drafts) }
    delete rest[spec.key]
    set(drafts, rest)
    const shown = spec.kind === 'choice' ? (spec.options.find((o) => o.value === value)?.label ?? String(value)) : spec.kind === 'boolean' ? (value ? 'on' : 'off') : String(value) || 'empty'
    return `${spec.title}: ${shown}`
  })
}

/** One setting: its control, and one muted line saying what the current value does (or why it
 *  does not apply right now). */
function SettingRow({ spec, values }: { spec: SettingSpec; values: SettingValues }) {
  const value = values[spec.key] ?? spec.default
  const off = !applies(spec.when, values)
  const disabled = off || read(busy) !== null
  let control: OrcaNode
  let help = spec.help
  if (spec.kind === 'choice') {
    control = <Select label={spec.title} value={String(value)} options={[...spec.options]
          .sort((a, b) => Number(b.value === spec.default) - Number(a.value === spec.default))
          .map((o) => ({ value: o.value, label: o.value === spec.default ? `${o.label} (Default)` : o.label }))} disabled={disabled} onChange={(v: string) => saveSetting(spec, v)} />
    help = spec.options.find((o) => o.value === value)?.help ?? spec.help
  } else if (spec.kind === 'boolean') {
    control = <Switch label={spec.title} checked={value === true} disabled={disabled} onChange={(v: boolean) => saveSetting(spec, v)} />
  } else {
    const typed = read(drafts)[spec.key]
    const label = spec.kind === 'number' && spec.unit ? `${spec.title} (${spec.unit})` : spec.title
    control = (
      <Input
        label={label}
        value={typed ?? String(value)}
        {...(spec.kind === 'text' && spec.placeholder ? { placeholder: spec.placeholder } : {})}
        invalid={spec.kind === 'number' && typed !== undefined && checked(spec, typed) === undefined}
        disabled={disabled}
        onChange={(v: string) => set(drafts, { ...read(drafts), [spec.key]: v })}
        onSubmit={(v: string) => {
          const ok = checked(spec, v)
          if (ok !== undefined) saveSetting(spec, ok)
        }}
      />
    )
    if (spec.kind === 'number') help = `${help} ${spec.min}–${spec.max}${spec.unit ? ` ${spec.unit}` : ''}.`
    if (typed !== undefined && typed !== String(value)) help = `Press Enter to save (${spec.kind === 'number' ? `${spec.min}–${spec.max}` : 'or change it back'}).`
  }
  return (
    <Stack gap="xs">
      {control}
      <Text size="xs" muted>
        {off ? spec.when!.why : help}
      </Text>
      {spec.key === 'timing' && value === 'early' && read(snapshot)?.userHere ? (
        <Text size="xs" tone="warning">
          Right now you are using Orca, so sessions hand off only at a limit.
        </Text>
      ) : null}
    </Stack>
  )
}

function SettingsView() {
  const values = read(settings)
  if (!values) return <Skeleton shape="text" lines={4} label="Loading settings" />
  return (
    <Stack gap="md">
      {BASIC_SETTINGS.map((spec) => (
        <SettingRow key={spec.key} spec={spec} values={values} />
      ))}
      <Collapsible title="Advanced" description="Fine-tuning. The defaults suit most people.">
        <Stack gap="md">
          {ADVANCED_SETTINGS.map((spec) => (
            <SettingRow key={spec.key} spec={spec} values={values} />
          ))}
        </Stack>
      </Collapsible>
      <Text size="xs" muted>
        The same settings are on Orca's Settings page under Plugins → Auto Hand-off.
      </Text>
    </Stack>
  )
}

/** Claude only: the console status line is per workspace, so the switch names the focused one. */
function ConsoleLineRow() {
  const state = read(consoleLine)
  if (!state) return null
  return (
    <Row gap="xs" align="center">
      <Switch
        label="Status line"
        checked={state.installed}
        disabled={read(busy) !== null || !state.workspace}
        onChange={(enabled: boolean) =>
          act('consoleLine', async () => {
            const next = await plugin.request('rotator.consoleLine', { enabled })
            set(consoleLine, next)
            return next.message
          })
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
  // the accent so it stands out from the other services at a glance.
  const focused = snap.focused === provider
  const order = snap.order?.[provider]
  return (
    <Box background={BRAND_TINT[provider]} border={focused ? 'accent' : undefined} radius="lg" padding="sm" gap="xs">
      <Row justify="between" align="center" gap="sm">
        <Row gap="xs" align="center">
          <Box width={12} height={12} shrink={false}>
            <Image src={brandMark(provider)} alt="" size="full" fit="contain" />
          </Box>
          <Text size="xs" weight="semibold" muted>
            {PROVIDER_NAME[provider].toUpperCase()}
          </Text>
          {/* Right after the service name: the service of the agent in the focused terminal. */}
          {focused ? (
            <Text size="xs" weight="medium">
              · on screen
            </Text>
          ) : null}
        </Row>
      </Row>
      {/* The same words as the switch at the top, for this service alone, on a line of its own
          (beside the service name they would not fit). With one account there is nothing to
          switch to, so no switch, unless it was turned off elsewhere (Orca's Settings page): then
          it is shown, so it can be seen and turned on again. Not while every service only counts
          as off (`Snapshot.held`): nobody turned it off, and the callout at the top says why. */}
      {!snap.held && (seats.length > 1 || !on) ? (
        <Switch
          key={`auto-${provider}`}
          label="Automatic hand-off"
          checked={on}
          disabled={read(busy) !== null}
          onChange={(enabled: boolean) =>
            act(`service:${provider}`, async () => {
              const { services } = await plugin.request('rotator.setService', { provider, enabled })
              const current = read(snapshot)
              if (current) show({ ...current, services })
              return `${PROVIDER_NAME[provider]}: automatic hand-off ${enabled ? 'on' : 'off'}`
            })
          }
        />
      ) : null}
      <Row justify="between" align="center" gap="sm">
        <Row gap="xs" align="center">
          {/* The service light: it follows the account in use, as the summary beside it does. */}
          <StatusDot tone={light.tone} filled={light.filled} dim={light.dim} />
          <Text size="xs" muted>
            {summary}
          </Text>
        </Row>
        {provider === 'claude' ? <ConsoleLineRow /> : null}
      </Row>
      {provider === 'claude' ? <ConsoleLineReason /> : null}
      {/* The status line's own setting sits with its switch, while the line is on. */}
      {provider === 'claude' && read(consoleLine)?.installed && read(settings)
        ? STATUS_LINE_SETTINGS.map((spec) => <SettingRow key={spec.key} spec={spec} values={read(settings)!} />)
        : null}
      {!on && !snap.held ? (
        <Callout tone="warning" title={`Automatic hand-off for ${PROVIDER_NAME[provider]} is off`}>
          Sessions are not handed off and limits are not handled. Turn Automatic hand-off on for {PROVIDER_NAME[provider]} to resume.
        </Callout>
      ) : null}
      {/* "Hand off to this account" moves the session in the focused terminal, so only the
          service of that terminal's agent offers it. */}
      {/* Custom order: the accounts in that order, with arrows to change it; otherwise in use first, then by room. */}
      {(order ? [...seats].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)) : [...seats].sort(seatOrder(now))).map((s, i, all) => (
        <SeatCard
          key={s.key}
          seat={s}
          now={now}
          switchable={focused && seats.length > 1}
          skippable={seats.length > 1}
          {...(order && all.length > 1 ? { place: { first: i === 0, last: i === all.length - 1 } } : {})}
        />
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
  if (providers.length === 0) {
    return (
      <EmptyState title="No accounts" description="Add one in the terminal, then refresh." icon="agent">
        <Code>orca account add</Code>
        <Button size="sm" variant="outline" icon="refresh" disabled={read(busy) !== null} onPress={() => act('refresh', () => load(true))}>
          Refresh
        </Button>
      </EmptyState>
    )
  }
  const notLive = snap.seats.some((s) => s.usage.source !== undefined && s.usage.source !== 'live' && s.usage.reason !== 'no-usage-api')
  return (
    <Stack gap="md">
      {providers.map((p) => (
        <ServiceSection key={p} provider={p} snap={snap} now={now} />
      ))}
      {notLive ? (
        <Text muted size="xs">
          Orca refreshes accounts that are not in use when its usage view is open or right after the account in use changes; until then the last reading is shown.
        </Text>
      ) : null}
    </Stack>
  )
}

// ---- history ------------------------------------------------------------------------------

function History({ snap }: { snap: Snapshot }) {
  const label = (key: string | undefined) => snap.seats.find((s) => s.key === key)?.label ?? key ?? ''
  const entries = [...snap.history].reverse()
  if (entries.length === 0) {
    return <EmptyState title="No hand-offs yet" description="Hand-offs of the last 7 days appear here." icon="activity" />
  }
  return (
    <Stack gap="xs">
      <Text size="xs" muted>
        {`Last 7 days · ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`}
      </Text>
      {/* The whole tab: the panel scrolls, not a box of its own. */}
      <Stack gap="none">
        {entries.map((h, i) => (
          <Stack key={`${h.at}-${i}`} gap="none">
            {i > 0 ? <Separator /> : null}
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
        ))}
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
                  disabled={read(busy) !== null}
                  onPress={() => notNow(w.terminalId)}
                >
                  Not now
                </Button>
                <Button size="sm" variant="outline" disabled={read(busy) !== null} onPress={() => handOffNow(w.terminalId)}>
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
                  disabled={read(busy) !== null}
                  onPress={() => notNow(w.terminalId)}
                >
                  Not now
                </Button>
              ) : null}
              {w.activeSince !== undefined ? (
                <Button size="xs" variant="outline" disabled={read(busy) !== null} onPress={() => handOffNow(w.terminalId)}>
                  Hand off now
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="ghost"
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

/** Local HTTP proxy state & latency bench results, loaded when the Proxy tab opens. */
const proxyState = atom<{ running: boolean; host: string; port: number; providers: any[] } | null>(null)
const benchResults = atom<{ id: string; name: string; kind: string; latencyMs: number; band: string; ok: boolean; error?: string }[] | null>(null)

function loadProxy(): Promise<void> {
  return plugin
    .request('rotator.proxyStatus', {})
    .then((st) => set(proxyState, st), () => undefined)
}

function ProxyView() {
  const st = read(proxyState)
  const bench = read(benchResults)
  if (st === null) {
    void loadProxy()
    return <Skeleton shape="text" lines={4} label="Loading proxy status" />
  }
  return (
    <Stack gap="md">
      <Row justify="between" align="center" gap="sm">
        <Stack gap="xs">
          <Text weight="semibold">Local HTTP Failover Proxy</Text>
          <Text size="xs" muted>
            {st.running ? `Listening on http://${st.host}:${st.port}` : 'Stopped (opt-in for API-key & relay providers)'}
          </Text>
        </Stack>
        <Row gap="xs">
          <Button
            size="sm"
            variant={st.running ? 'ghost' : 'solid'}
            disabled={read(busy) !== null}
            onPress={() =>
              act('proxy', async () => {
                const next = st.running ? await plugin.request('rotator.proxyStop', {}) : await plugin.request('rotator.proxyStart', {})
                set(proxyState, next)
                return next.running ? `Proxy started on http://${next.host}:${next.port}` : 'Proxy stopped'
              })
            }
          >
            {st.running ? 'Stop' : 'Start'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={read(busy) !== null || st.providers.length === 0}
            onPress={() =>
              act('bench', async () => {
                const res = await plugin.request('rotator.bench', {})
                set(benchResults, res.results)
                return `Benchmarked ${res.results.length} providers`
              })
            }
          >
            Bench
          </Button>
        </Row>
      </Row>
      {st.providers.length === 0 ? (
        <EmptyState
          title="No API-key providers configured"
          description="Add relay or API-key endpoints with `oah provider add <anthropic|openai> <name> <baseUrl> <apiKey>`."
        />
      ) : (
        <Stack gap="sm">
          {st.providers.map((p: any) => {
            const b = bench?.find((x) => x.id === p.id)
            const tone: Tone = p.circuit === 'open' ? 'danger' : p.circuit === 'half_open' ? 'warning' : 'success'
            return (
              <Box key={p.id} border radius="md" padding="sm">
                <Row justify="between" align="center" gap="sm">
                  <Stack gap="xs">
                    <Text weight="semibold">{p.name}</Text>
                    <Text size="xs" muted>
                      {p.kind} · #{p.priority} · {p.baseUrl}
                    </Text>
                  </Stack>
                  <Row gap="xs" align="center">
                    {b ? <Badge tone={b.band === 'fast' ? 'success' : b.band === 'ok' ? 'warning' : 'danger'}>{b.ok ? `${b.latencyMs}ms` : 'err'}</Badge> : null}
                    <Badge tone={tone}>{p.circuit}</Badge>
                  </Row>
                </Row>
              </Box>
            )
          })}
        </Stack>
      )}
    </Stack>
  )
}

export default function Panel() {
  const snap = read(snapshot)
  if (!snap) return <Skeleton shape="text" lines={6} label="Loading accounts" />
  const note = read(message)
  return (
    <Stack gap="md">
      <Row justify="between" align="center" gap="sm">
        {/* On a narrow panel the badge goes under the title, whole, rather than split both. */}
        <Row gap="sm" align="center" wrap>
          <Heading>Auto Hand-off</Heading>
          {/* The settings in one pill (Orca's Badge colours only a dot, so it is drawn). One badge, coloured by what is happening now: amber while automatic hand-off is paused,
              green while early hand-offs are on (Early when away, and the user is away), grey while
              sessions move only at a limit (At limit, or the user is at Orca). */}
          {/* Not while every service only counts as off (`Snapshot.held`): the callout below says
              what is happening, and a green "on" beside it would say the opposite. */}
          {snap.paused || (snap.mode && !snap.held) ? (
            (() => {
              const early = !snap.paused && !snap.atLimitOnly && !snap.userHere
              // Early when away, waiting for the user to leave: green, without the solid green border
              // it has once early hand-offs are on.
              const waiting = !snap.paused && !snap.atLimitOnly && !!snap.userHere
              const tone: Tone = snap.paused ? 'warning' : early || waiting ? 'success' : 'neutral'
              // A mark says the state, the colour backs it: ● early hand-offs on, ◐ waiting for the
              // user to leave, ○ only at a limit, ■ paused.
              const mark: keyof typeof BADGE_SYMBOL | 'here' = snap.paused ? 'paused' : early ? 'away' : snap.atLimitOnly ? 'limit' : 'here'
              // Early when away: the style, and whether early hand-offs wait for the user to leave, or are on.
              const state = snap.atLimitOnly ? 'At limit' : waiting ? 'Early when away · waiting' : 'Early when away · on'
              // (A mode this version does not know, from a worker of another version: the state alone.)
              const mode = snap.mode ? MODE_NAME[snap.mode] : undefined
              const label = snap.paused ? 'Paused' : mode ? `${mode} · ${state}` : state
              return (
                <Box background={tone === 'neutral' ? 'muted' : tone} border={tone === 'neutral' || waiting ? true : tone} radius="full" paddingX="sm" shrink={false}>
                  {/* Every state the same: a fixed slot for the symbol, then the text, so the text
                      starts at the same place whatever the state. */}
                  <Row gap="xs" align="center">
                    {/* One fixed slot for every mark, so the text starts at the same place. */}
                    <Box width={12} height={14} shrink={false} align="center" justify="center">
                      {mark === 'here' ? (
                        <Box width={11} height={11}>
                          <Image src={HERE_MARK} alt="" size="full" fit="contain" />
                        </Box>
                      ) : (
                        <Text size="xs" tone={tone}>
                          {BADGE_SYMBOL[mark]}
                        </Text>
                      )}
                    </Box>
                    <Text size="xs" weight="semibold" tone={tone}>
                      {label}
                    </Text>
                  </Row>
                </Box>
              )
            })()
          ) : null}
        </Row>
        <IconButton
          icon="refresh"
          label="Refresh usage"
          variant="ghost"
          size="sm"
          disabled={read(busy) !== null}
          onPress={() => act('refresh', () => load(true))}
        />
      </Row>

      <Row justify="between" align="center" gap="sm">
        <Switch
          label="Automatic hand-off"
          checked={!snap.paused}
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

      {/* Accounts belong to the Orca that runs the agent: for a project on a paired server the
          panel shows that server's accounts and says so, since they differ from this computer's. */}
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
      {note ? (
        <Row justify="between" align="center" gap="sm">
          <Text size="xs" muted>
            {note}
          </Text>
          <IconButton icon="close" label="Dismiss" variant="ghost" size="xs" onPress={() => set(message, null)} />
        </Row>
      ) : null}

      <Tabs label="View" value={read(tab)} onChange={(v: string) => set(tab, v)}>
        <Tab value="accounts" label="Accounts">
          <Accounts snap={snap} />
        </Tab>
        <Tab value="proxy" label="Proxy">
          <ProxyView />
        </Tab>
        <Tab value="history" label={`History (${snap.history.length})`}>
          <History snap={snap} />
        </Tab>
        <Tab value="settings" label="Settings">
          <SettingsView />
        </Tab>
      </Tabs>
    </Stack>
  )
}
