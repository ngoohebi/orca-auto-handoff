// Auto Hand-off panel: every seat's usage, cooldowns, parked sessions and swap history.
//
// Display first: the panel never changes which account new launches use; that is the worker's
// job (and the status-bar click or the commands). Its only controls pause the automation, clear
// a cooldown and cancel a parked session.
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
  EmptyState,
  Heading,
  IconButton,
  Image,
  plugin,
    read,
  RelativeTime,
  Row,
  Separator,
  set,
  Skeleton,
  Stack,
  Switch,
  Tab,
  Tabs,
  Text,
  type PanelContext,
  type Tone
} from 'orca'
import { minLeft, percentLeft, PROVIDER_NAME, runwayWords, seatOrder } from './labels'
import type { ConsoleLineState, Snapshot, UnsentDraft } from './protocol'
import { PROVIDERS, type Provider } from './types'

/** The Auto-switch mode as the panel names it. */
const MODE_NAME = { smart: 'Smart', 'my-order': 'My order', manual: 'Manual', custom: 'Custom' } as const

const snapshot = atom<Snapshot | null>(null)
const busy = atom<string | null>(null)
const message = atom<string | null>(null)
const tab = atom('tab', 'accounts', { persist: 'plugin' })
/** The Claude console status line in the focused workspace; null until read. */
const consoleLine = atom<ConsoleLineState | null>(null)
/** The standby account whose *Hand off to this account* is waiting for confirmation. */
const confirming = atom<string | null>(null)
/** *Yes, hand off* found unsent text in the session that would move: the account it was for and the
 *  text, shown in a second confirmation. Only its *Hand off anyway* gives the text up. */
const draftAsk = atom<{ seatKey: string; draft: UnsentDraft } | null>(null)
/** Takes a new snapshot. A project on another server lists other accounts under the same keys,
 *  and has another session in front: a question about unsent text asked before is dropped. */
function show(next: Snapshot): void {
  if ((next.server ?? '') !== (read(snapshot)?.server ?? '')) set(draftAsk, null)
  set(snapshot, next)
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

/** The console line state; one retry, since the first request after a reload can race the
 *  worker's restart and the row would otherwise stay hidden until the next refresh. */
async function readConsoleLine(): Promise<ConsoleLineState | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await plugin.request('rotator.consoleLine', {})
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_500))
    }
  }
  return null
}

async function load(refresh = false): Promise<void> {
  show(await plugin.request('rotator.snapshot', { refresh }))
  set(consoleLine, await readConsoleLine())
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
  ctx.subscriptions.push(plugin.on('rotator.changed', (payload) => show(payload)))
  // The Status line switch is per workspace: the worker says when the focused one changes.
  ctx.subscriptions.push(plugin.on('rotator.consoleLine', (payload) => set(consoleLine, payload)))
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
      if (timer) clearTimeout(timer)
    }
  })
  // The first read can race the worker's restart: the worker's next push then fills the list,
  // and the Status line switch is still read.
  void load().catch(async () => set(consoleLine, await readConsoleLine()))
}

// ---- wording ------------------------------------------------------------------------------

/** Brand colours cannot be given to Orca's components (only theme tones), so each service's
 *  colour ships as a small image in assets/brand: a soft rule under its title. Claude is
 *  Anthropic's terracotta, Codex OpenAI's green, Antigravity Google's blue, Devin Cognition's
 *  blue; OpenCode's mark is near-black, so a light neutral stands in. */
const brandRule = (p: Provider) => `assets/brand/${p}-strip.png`

/** The service block's wash. Orca only paints theme tints, so each service takes the tone nearest
 *  its brand: amber for Claude's terracotta, green for Codex; the blue brands have no blue tint
 *  and sit on the quiet accent wash, with the brand strip carrying their colour. */
const BRAND_TINT: Record<Provider, 'muted' | Tone> = {
  claude: 'warning',
  codex: 'success',
  antigravity: 'accent',
  opencode: 'muted',
  devin: 'accent'
}

/** `rate_limit` → `rate limit`, `api_error` → `API error`. */
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
      return 'This service reports no usage; only limits switch it.'
    case 'not-reported':
      return seat.active ? 'Orca has not reported usage yet.' : 'Orca reports usage for this account only while it is in use.'
    case 'error':
      return seat.usage.detail ?? 'Orca could not read usage.'
    default:
      return undefined
  }
}

function words(code: string | undefined): string {
  if (!code) return ''
  return code.replace(/_/g, ' ').replace(/\bapi\b/i, 'API')
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
  if (!seat.usage.known) return { tone: 'neutral', word: 'idle', filled: false, dim: true }
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

/** One usage window: name left, headroom and reset right, the bar under them. The bar is drawn
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
    <Stack gap="xs">
      <Row justify="between" align="center" gap="xs">
        <Text size="xs" muted>
          {name}
        </Text>
        <Row gap="xs" align="center">
          <Text size="xs" tone={tone} muted={tone === 'neutral'}>
            {reading}
          </Text>
          {window?.resetsAt ? (
            <Text size="xs" muted>
              · resets <RelativeTime at={window.resetsAt} format="duration" muted />
            </Text>
          ) : null}
        </Row>
      </Row>
      <Box height={4} radius="full" background="muted">
        {left ? (
          <Box width={`${left}%`} gap="none" radius="full">
            <Box height={2} radius="full" border={fill} />
            <Box height={2} radius="full" border={fill} />
          </Box>
        ) : null}
      </Box>
    </Stack>
  )
}

function SeatCard({ seat, now, switchable }: { seat: SeatRow; now: number; switchable: boolean }) {
  const cooling = !!seat.cooldownUntil && seat.cooldownUntil > now
  const status = seatStatus(seat, now)
  const name = PROVIDER_NAME[seat.provider]
  return (
    <Box border radius="md" gap="none" background="card">
      {/* Who: the account on its own line. */}
      <Box direction="row" justify="between" align="center" gap="sm" paddingX="sm" paddingY="xs">
        <Row gap="xs" align="center">
          <StatusDot tone={status.tone} filled={status.filled} dim={status.dim} />
          <Text truncate>{seat.label}</Text>
        </Row>
        <Text size="xs" tone={status.tone} muted={!!status.dim}>
          {status.word}
        </Text>
      </Box>
      <Separator />
      {/* How it is doing: usage and cooldown, set apart under a hairline. */}
      <Box padding="sm" gap="sm">
        {seat.usage.known ? (
          <Stack gap="xs">
            <UsageBar name="5h" window={seat.usage.session} />
            <UsageBar name="Week" window={seat.usage.weekly} />
            {seat.usage.model ? <UsageBar name={`${capital(seat.usage.model.name)} week`} window={seat.usage.model} /> : null}
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
              {capital(words(seat.cooldownReason) || 'limited')} · ends <RelativeTime at={seat.cooldownUntil!} tone="danger" />
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
        {switchable && !seat.active && !cooling ? (
          <Box paddingY="xs">
            {read(draftAsk)?.seatKey === seat.key ? (
              <Box border="accent" radius="md" padding="sm" gap="sm">
                <Text size="sm" weight="medium">{`This session shows unsent text: “${shownDraft(read(draftAsk)!.draft.text)}”.`}</Text>
                <Text size="xs" muted>
                  Hand off anyway? The text will be cleared.
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
                  The session in this tab moves too if it is idle; a busy one stays where it is.
                </Text>
                <Text size="xs" muted>
                  Auto hand-off for {name} turns off, so it won't switch back on its own.
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
              <Row justify="end">
                <Button
                  size="sm"
                  variant="outline"
                  icon="next"
                  tooltip={`Hand ${name} off to this account now, instead of waiting for auto hand-off`}
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
  const limited = seats.filter((s) => s.cooldownUntil && s.cooldownUntil > now).length
  const summary = [`${seats.length - limited} of ${seats.length} ready`, limited ? `${limited} limited` : null].filter(Boolean).join(' · ')
  const rank: Tone[] = ['danger', 'warning', 'success', 'neutral']
  const active = seats.find((s) => s.active)
  // The service light follows the account in use; with none in use, the worst standby.
  const light: SeatStatus = active
    ? seatStatus(active, now)
    : { tone: rank.find((t) => seats.some((s) => seatStatus(s, now).tone === t)) ?? 'neutral', word: '', filled: false, dim: true }
  // The service of the agent the user is working with (see `Snapshot.focused`) is outlined in
  // the accent so it stands out from the other services at a glance.
  const focused = snap.focused === provider
  return (
    <Box background={BRAND_TINT[provider]} border={focused ? 'accent' : undefined} radius="lg" padding="sm" gap="sm">
      <Row justify="between" align="center" gap="sm">
        <Row gap="xs" align="center">
          <StatusDot tone={light.tone} filled={light.filled} dim={light.dim} />
          <Text size="xs" weight="semibold" muted>
            {PROVIDER_NAME[provider].toUpperCase()}
          </Text>
        </Row>
        {/* With one account there is nothing to switch to, so no toggle. */}
        {seats.length > 1 ? (
          <Switch
            label={`Auto hand-off ${PROVIDER_NAME[provider]}`}
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
      </Row>
      <Image src={brandRule(provider)} alt="" size="full" />
      <Row justify="between" align="center" gap="sm">
        <Row gap="xs" align="center">
          <Text size="xs" muted>
            {summary}
          </Text>
          {/* The marker sits here, not in the header, so the service name never wraps. */}
          {focused ? (
            <Text size="xs" weight="medium">
              · this terminal
            </Text>
          ) : null}
        </Row>
        {provider === 'claude' ? <ConsoleLineRow /> : null}
      </Row>
      {provider === 'claude' ? <ConsoleLineReason /> : null}
      {!on && seats.length > 1 ? (
        <Callout tone="warning" title={`Automatic hand-off for ${PROVIDER_NAME[provider]} is off`}>
          Accounts are not rotated and limits are not handled. Turn Auto hand-off {PROVIDER_NAME[provider]} on to resume.
        </Callout>
      ) : null}
      {[...seats].sort(seatOrder(now)).map((s) => (
        <SeatCard key={s.key} seat={s} now={now} switchable={seats.length > 1} />
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
          Orca refreshes accounts that are not in use when its usage view is open or right after an account switch; until then the last reading is shown.
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
    return <EmptyState title="No switches yet" description="Switches of the last 7 days appear here." icon="activity" />
  }
  return (
    <Stack gap="xs">
      <Text size="xs" muted>
        Last 7 days
      </Text>
      <Box maxHeight={560} scroll="y">
        {entries.map((h, i) => (
          <Stack key={`${h.at}-${i}`} gap="none">
            {i > 0 ? <Separator /> : null}
            <Box paddingY="sm" gap="none">
              <Row justify="between" align="center" gap="sm">
                <Row gap="xs" align="center" wrap>
                  <Text size="sm" weight="medium">
                    {PROVIDER_NAME[h.provider] ?? h.provider} · {words(h.reason)}
                  </Text>
                  <Badge tone={RESULT_TONE[h.result] ?? 'neutral'}>{h.result}</Badge>
                </Row>
                <RelativeTime at={h.at} format="short" muted />
              </Row>
              <Text size="xs" muted truncate>
                {h.to ? `${label(h.from)} → ${label(h.to)}` : label(h.from)}
              </Text>
              {h.why ? <Text size="xs">{capital(h.why)}</Text> : null}
              {h.detail ? (
                <Text size="xs" muted>
                  {h.detail}
                </Text>
              ) : null}
            </Box>
          </Stack>
        ))}
      </Box>
    </Stack>
  )
}

// ---- panel --------------------------------------------------------------------------------

function Waiting({ snap }: { snap: Snapshot }) {
  if (snap.waiting.length === 0) return null
  return (
    <Callout tone="warning" title="Waiting for a limit to reset">
      <Stack gap="xs">
        {snap.waiting.map((w) => (
          <Row key={w.terminalId} justify="between" align="center" gap="sm">
            <Text size="xs">
              {w.draftAt ? (
                <>{PROVIDER_NAME[w.agent] ?? w.agent} session moves once the text typed in it is sent or cleared</>
              ) : (
                <>
                  {PROVIDER_NAME[w.agent] ?? w.agent} session resumes <RelativeTime at={w.wakeAt} />
                </>
              )}
            </Text>
            <Button
              size="xs"
              variant="ghost"
              onPress={() => act(`cancel:${w.terminalId}`, async () => {
                await plugin.request('rotator.cancelWaiting', { terminalId: w.terminalId })
              })}
            >
              Cancel
            </Button>
          </Row>
        ))}
      </Stack>
    </Callout>
  )
}

export default function Panel() {
  const snap = read(snapshot)
  if (!snap) return <Skeleton shape="text" lines={6} label="Loading accounts" />
  const note = read(message)
  return (
    <Stack gap="md">
      <Row justify="between" align="center" gap="sm">
        <Row gap="sm" align="center">
          <Heading>Auto Hand-off</Heading>
          {snap.paused ? <Badge tone="warning">paused</Badge> : null}
          {snap.mode ? <Badge tone="neutral">{MODE_NAME[snap.mode]}</Badge> : null}
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
          Orca manages no accounts there: its agents use that machine's own login, so the accounts below do not apply to it and its panes are left alone.
        </Callout>
      ) : null}
      {snap.error ? (
        <Callout tone="danger" title="Cannot read accounts">
          {snap.error}
        </Callout>
      ) : null}
      {snap.notice ? (
        <Callout tone="neutral" title="Your settings were kept">
          <Text size="xs">{snap.notice}</Text>
          <Button
            size="sm"
            variant="outline"
            onPress={() =>
              act('notice', async () => {
                await plugin.request('rotator.dismissNotice', {})
              })
            }
          >
            Got it
          </Button>
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
        <Tab value="history" label={`History (${snap.history.length})`}>
          <History snap={snap} />
        </Tab>
      </Tabs>
    </Stack>
  )
}
