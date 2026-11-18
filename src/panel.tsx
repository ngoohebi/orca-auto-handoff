// Account Rotator panel: every seat's usage, cooldowns, parked sessions and swap history.
import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Heading,
  plugin,
  Progress,
  read,
  RelativeTime,
  Row,
  set,
  Stack,
  Switch,
  Tab,
  Table,
  Tabs,
  Text,
  type PanelContext
} from 'orca'
import type { Snapshot } from './protocol'
import { PROVIDERS } from './types'

const snapshot = atom<Snapshot | null>(null)
const busy = atom<string | null>(null)
const message = atom<string | null>(null)
const tab = atom('tab', 'accounts', { persist: 'plugin' })

async function load(refresh = false): Promise<void> {
  set(snapshot, await plugin.request('rotator.snapshot', { refresh }))
}

async function act(key: string, fn: () => Promise<string | void>): Promise<void> {
  set(busy, key)
  try {
    const text = await fn()
    if (text) set(message, text)
  } catch (error) {
    set(message, `Failed: ${String((error as Error)?.message ?? error)}`)
  } finally {
    set(busy, null)
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('rotator.changed', (payload) => set(snapshot, payload)))
  void load()
}

/** `5h 40%`, or `5h 0% · reset since` for a remembered window whose reset time has passed. */
function windowLabel(name: string, w: { usedPercent: number; reset?: true } | undefined): string {
  return `${name} ${pct(w?.usedPercent)}${w?.reset ? ' · reset since' : ''}`
}

/** Why Orca has no live numbers for this account, in plain words. */
function reasonText(seat: { usage: Snapshot['seats'][number]['usage']; active: boolean }): string | undefined {
  switch (seat.usage.reason) {
    case 'stale-token':
      return 'Updates the next time this account runs.'
    case 'sign-in':
      return 'Sign in to this account again in Orca.'
    case 'rate-limited':
      return 'Orca is rate limited; it retries shortly.'
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

function pct(n: number | undefined): string {
  return typeof n === 'number' ? `${Math.round(n)}%` : '–'
}

type SeatRow = Snapshot['seats'][number]

function SeatCard({ seat, now }: { seat: SeatRow; now: number }) {
  const cooling = seat.cooldownUntil && seat.cooldownUntil > now
  return (
    <Stack gap="xs">
      <Row justify="between" align="center">
        <Text weight="medium" truncate>
          {seat.label}
        </Text>
        <Row gap="xs">
          {seat.active ? <Badge tone="success">active</Badge> : null}
          {cooling ? <Badge tone="danger">limited</Badge> : null}
        </Row>
      </Row>
      {seat.usage.known ? (
        <Stack gap="xs">
          <Progress label={windowLabel('5h', seat.usage.session)} value={seat.usage.session?.usedPercent ?? 0} />
          <Progress label={windowLabel('Week', seat.usage.weekly)} value={seat.usage.weekly?.usedPercent ?? 0} />
          {seat.usage.model ? (
            <Progress label={windowLabel(`${seat.usage.model.name} week`, seat.usage.model)} value={seat.usage.model.usedPercent} />
          ) : null}
          {seat.usage.source === 'cached' || seat.usage.source === 'projected' ? (
            <Row gap="xs" align="center">
              <Text muted size="xs">
                Last reading
              </Text>
              {seat.usage.asOf ? <RelativeTime at={seat.usage.asOf} muted /> : null}
              {reasonText(seat) ? (
                <Text muted size="xs">
                  · {reasonText(seat)}
                </Text>
              ) : null}
            </Row>
          ) : null}
        </Stack>
      ) : (
        <Text muted size="xs">
          {reasonText(seat) ?? 'No usage reading yet.'}
        </Text>
      )}
      {cooling ? (
        <Row gap="xs" align="center">
          <Text size="xs" tone="danger">
            Free again
          </Text>
          <RelativeTime at={seat.cooldownUntil!} tone="danger" />
          <Button size="sm" variant="ghost" onPress={() => act(`clear:${seat.key}`, async () => {
            await plugin.request('rotator.clearCooldown', { seatKey: seat.key })
          })}>
            Clear
          </Button>
        </Row>
      ) : null}
      {!seat.active ? (
        <Button
          size="sm"
          disabled={read(busy) !== null}
          onPress={() => act(`select:${seat.key}`, async () => (await plugin.request('rotator.select', { seatKey: seat.key })).message)}
        >
          Use for new {seat.provider} launches
        </Button>
      ) : null}
    </Stack>
  )
}

function Accounts({ snap }: { snap: Snapshot }) {
  const now = Date.now()
  const providers = PROVIDERS.filter((p) => snap.seats.some((s) => s.provider === p))
  if (providers.length === 0) {
    return <EmptyState title="No accounts" description="Add accounts with orca account add, then refresh." icon="agent" />
  }
  const notLive = snap.seats.some((s) => s.usage.source !== undefined && s.usage.source !== 'live' && s.usage.reason !== 'no-usage-api')
  return (
    <Stack gap="md">
      {providers.map((p) => {
        const on = snap.services?.[p] !== false
        return (
        <Card key={p} title={p} description={`${snap.seats.filter((s) => s.provider === p).length} account(s)${on ? '' : ' · auto-switch off'}`}>
          <Stack gap="md">
            <Switch
              label={`Auto-switch ${p} accounts`}
              checked={on}
              disabled={read(busy) !== null}
              onChange={(enabled: boolean) => act(`service:${p}`, async () => {
                const { services } = await plugin.request('rotator.setService', { provider: p, enabled })
                const current = read(snapshot)
                if (current) set(snapshot, { ...current, services })
                return `${p}: automatic switching ${enabled ? 'on' : 'off'}`
              })}
            />
            {snap.seats
              .filter((s) => s.provider === p)
              .map((s) => (
                <SeatCard key={s.key} seat={s} now={now} />
              ))}
          </Stack>
        </Card>
        )
      })}
      {notLive ? (
        <Text muted size="xs">
          Orca refreshes accounts that are not in use when its usage view is open or right after an account switch; until then the last reading is shown.
        </Text>
      ) : null}
    </Stack>
  )
}

function History({ snap }: { snap: Snapshot }) {
  const label = (key: string | undefined) => snap.seats.find((s) => s.key === key)?.label ?? key ?? ''
  const rows = [...snap.history].reverse().map((h, i) => ({
    key: `${h.at}-${i}`,
    cells: {
      when: { type: 'relative' as const, at: h.at },
      what: `${h.provider} ${h.reason}`,
      result: h.result,
      move: h.to ? `${label(h.from)} → ${label(h.to)}` : label(h.from),
      detail: h.detail ?? ''
    }
  }))
  return (
    <Table
      label="Swap history"
      columns={[
        { key: 'when', label: 'When', width: 'sm' },
        { key: 'what', label: 'Trigger', width: 'sm' },
        { key: 'result', label: 'Result', width: 'xs' },
        { key: 'move', label: 'Accounts' },
        { key: 'detail', label: 'Detail', hideBelow: 'md' }
      ]}
      rows={rows}
      emptyText="No switches yet"
    />
  )
}

export default function Panel() {
  const snap = read(snapshot)
  if (!snap) return <Text muted>Loading accounts…</Text>
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading>Account Rotator</Heading>
        <Button size="sm" variant="ghost" icon="refresh" disabled={read(busy) !== null} onPress={() => act('refresh', () => load(true))}>
          Refresh
        </Button>
      </Row>
      <Switch
        label="Automatic switching"
        checked={!snap.paused}
        onChange={(on: boolean) => act('pause', async () => {
          await plugin.request('rotator.pause', { paused: !on })
        })}
      />
      {snap.error ? (
        <Callout tone="danger" title="Cannot read accounts">
          {snap.error}
        </Callout>
      ) : null}
      {snap.waiting.length > 0 ? (
        <Callout tone="warning" title="Waiting for a limit to reset">
          {snap.waiting.map((w) => (
            <Row key={w.terminalId} gap="xs" align="center">
              <Text size="xs">{w.agent} resumes</Text>
              <RelativeTime at={w.wakeAt} />
              <Button size="sm" variant="ghost" onPress={() => act(`cancel:${w.terminalId}`, async () => {
                await plugin.request('rotator.cancelWaiting', { terminalId: w.terminalId })
              })}>
                Cancel
              </Button>
            </Row>
          ))}
        </Callout>
      ) : null}
      {read(message) ? <Text size="xs" muted>{read(message)}</Text> : null}
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
