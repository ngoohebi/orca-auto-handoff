import { assert, test } from 'orca/testing'
import { classify, hasDraft, parseModelFallback, parseReset } from './adapters'
import * as fx from './fixtures'

const NOW = new Date(2026, 10, 18, 10, 0, 0).getTime()

test('real Codex/Ollama credits banner is a rate limit, not a transient API error', () => {
  const s = classify('codex', fx.CODEX_OLLAMA_CREDITS, NOW)
  assert.equal(s?.kind, 'rate_limit')
  assert.match(s!.line, /Add usage credits/)
  assert.equal(s!.linesAfter, 1)
})

test('real Antigravity quota banner is a rate limit with a parsed reset', () => {
  const s = classify('antigravity', fx.AGY_QUOTA, NOW)
  assert.equal(s?.kind, 'rate_limit')
  assert.equal(s!.resetsAt, NOW + (135 * 3600 + 42 * 60 + 31) * 1000)
})

test('Claude 5-hour banner resets at the next 3pm', () => {
  const s = classify('claude', fx.CLAUDE_SESSION_LIMIT, NOW)
  assert.equal(s?.kind, 'rate_limit')
  assert.equal(new Date(s!.resetsAt!).getHours(), 15)
  assert.ok(s!.resetsAt! > NOW)
})

test('Claude legacy epoch banner', () => {
  const s = classify('claude', fx.CLAUDE_LEGACY_EPOCH, NOW)
  assert.equal(s?.kind, 'rate_limit')
  assert.equal(s!.resetsAt, 1_795_000_000_000)
})

test('Claude model cap names the model', () => {
  const s = classify('claude', fx.CLAUDE_MODEL_CAP, NOW)
  assert.equal(s?.kind, 'model_cap')
  assert.equal(s!.model, 'fable')
})

test('Claude API 529 is an api_error', () => {
  assert.equal(classify('claude', fx.CLAUDE_API_ERROR, NOW)?.kind, 'api_error')
})

test('talking about limits is not a limit', () => {
  assert.equal(classify('claude', fx.CLAUDE_TALKING_ABOUT_LIMITS, NOW), null)
  assert.equal(classify('codex', ['plan: handle rate limits and quota in the adapter'], NOW), null)
  // The banner's own words, where an agent wrote them: an indented line of a Claude reply, and a
  // Codex line without an error mark. The same words as a CLI status line do count.
  const words = '5-hour limit reached ∙ resets 3pm'
  assert.equal(classify('claude', ['⏺ The adapter looks for this text:', `     ${words}`, '  Done.'], NOW), null)
  assert.equal(classify('claude', [`  ⎿  ${words}`], NOW)?.kind, 'rate_limit')
  const codex = "You've hit your usage limit. Upgrade to Pro or try again in 2 days."
  assert.equal(classify('codex', [`• The banner reads: ${codex}`], NOW), null)
  assert.equal(classify('codex', [`■ ${codex}`], NOW)?.kind, 'rate_limit')
})

test('Codex usage limit with a multi-unit duration', () => {
  const s = classify('codex', fx.CODEX_USAGE_LIMIT, NOW)
  assert.equal(s?.kind, 'rate_limit')
  assert.equal(s!.resetsAt, NOW + ((2 * 24 + 3) * 60 + 4) * 60_000)
})

test('a banner that has scrolled out of the latest output is ignored', () => {
  const old = [...fx.CLAUDE_SESSION_LIMIT.slice(0, 3), ...Array.from({ length: 20 }, (_, i) => `⏺ step ${i}`)]
  assert.equal(classify('claude', old, NOW), null)
})

test('parseReset formats', () => {
  assert.equal(parseReset('resets in 45 min', NOW), NOW + 45 * 60_000)
  assert.equal(new Date(parseReset('limit will reset at 9:30 AM (Europe/Berlin)', NOW)!).getDate(), 19)
  assert.equal(parseReset('no time here', NOW), undefined)
})

test('model fallback setting', () => {
  assert.deepEqual(parseModelFallback('claude=sonnet, haiku; codex=gpt-5-mini; bogus=x'), {
    claude: ['sonnet', 'haiku'],
    codex: ['gpt-5-mini']
  })
})

test('Claude quoting a banner in its own reply is not a limit; the same text as tool output is', () => {
  assert.equal(classify('claude', ['⏺ The banner reads: 5-hour limit reached ∙ resets 3pm'], NOW), null)
  assert.equal(classify('claude', ['⏺ Bash(echo limit)', '  ⎿  5-hour limit reached ∙ resets 3pm'], NOW)?.kind, 'rate_limit')
})

test('a typed prompt that mentions a limit is not a limit (live: Claude ❯ prompt line)', () => {
  const tail = [
    "❯ Live test. Use the Bash tool to run exactly: echo '5-hour limit reached ∙ resets 3pm' ; then end your turn",
    '  Ran 1 shell command',
    '⏺ ok',
    '✻ Brewed for 2s · done 8:08 AM'
  ]
  assert.equal(classify('claude', tail, NOW), null)
})

test('unsent text in the input box is a draft; placeholders and empty boxes are not', () => {
  assert.equal(hasDraft(['⏺ Done.', '╭────╮', '│ > fix the flaky test', '╰────╯']), true)
  assert.equal(hasDraft(['⏺ Done.', '╭────╮', '│ >', '╰────╯']), false)
  assert.equal(hasDraft(['⏺ Done.', '╭────╮', '│ > Try "fix lint errors"', '╰────╯']), false)
  assert.equal(hasDraft(fx.CODEX_OLLAMA_CREDITS), false)
  assert.equal(hasDraft(['■ done', '› rerun the tests', '  gpt-5 · ~/repo']), true)
  assert.equal(hasDraft(['❯ Go continue.', '⏺ Working on it']), false)
})

// Live (Orca 1.4.263, Claude Code with the console status line installed): `terminal.read` gives the
// rendered screen, and under the input box come the plugin's own account rows and Claude's mode line.
const STATUS_ROWS = [
  '  ▶ work          5h ███████░  78%  7d ████████  96%  fable ████████  94%',
  '  · personal      5h ████████ 100%  7d ████████ 100%  fable ████████ 100%',
  '  · side          5h ░░░░░░░░   0%  7d ██████░░  81%  fable ██████░░  81%  ⏸1h20m',
  '  · fourth        5h ········  n/a  7d ········  n/a  model ········  n/a'
]
const MODE_LINE = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
const FRAME = '─'.repeat(60)

test('live: the console status line rows under the input box are not output printed after a banner', () => {
  const screen = [
    '⏺ I updated the parser and the tests pass.',
    '  ⎿  5-hour limit reached ∙ resets 3pm',
    '     /upgrade to increase your usage limit.',
    `${FRAME} claude ─`,
    '❯',
    FRAME,
    ...STATUS_ROWS,
    MODE_LINE
  ]
  const s = classify('claude', screen, NOW)
  assert.equal(s?.kind, 'rate_limit')
  assert.equal(s?.linesAfter, 1)
  // The rows are not a banner either, whatever they say.
  assert.equal(classify('claude', ['⏺ Done.', FRAME, '❯', FRAME, ...STATUS_ROWS, MODE_LINE], NOW), null)
})

test('live: unsent text is seen with the console status line rows and the mode line under the input box', () => {
  assert.equal(hasDraft(['⏺ Done.', FRAME, '❯ also update the docs', FRAME, ...STATUS_ROWS, MODE_LINE]), true)
  assert.equal(hasDraft(['⏺ Done.', FRAME, '❯', FRAME, ...STATUS_ROWS, MODE_LINE]), false)
  // A sent prompt with a reply under it is still no draft.
  assert.equal(hasDraft(['❯ also update the docs', '⏺ Updated.', FRAME, '❯', FRAME, ...STATUS_ROWS, MODE_LINE]), false)
})
