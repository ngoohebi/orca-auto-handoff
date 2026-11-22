// Integration test for `LocalProxy` (real `node:http` upstream failover + circuit breaker + latency bench).
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import test from 'node:test'
import type { ProxyProvider } from '../core/types.ts'
import { benchProviders, LocalProxy } from './proxy.ts'

function startMockUpstream(handler: (url: string, headers: Record<string, string | string[] | undefined>, body: string) => { status: number; body: string }): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += typeof c === 'string' ? c : new TextDecoder().decode(c)))
      req.on('end', () => {
        const out = handler(req.url ?? '/', req.headers, body)
        res.writeHead(out.status, { 'content-type': 'application/json' })
        res.end(out.body)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ server, url: `http://127.0.0.1:${addr.port}` })
    })
  })
}

test('LocalProxy transparently fails over on HTTP 429, trips circuit breaker, and benchmarks latency', async () => {
  let primaryHits = 0
  let backupHits = 0
  let receivedModel = ''
  const primary = await startMockUpstream(() => {
    primaryHits++
    return { status: 429, body: JSON.stringify({ error: 'rate_limit_exceeded' }) }
  })
  const backup = await startMockUpstream((_url, _headers, body) => {
    backupHits++
    if (body) receivedModel = JSON.parse(body).model ?? ''
    return { status: 200, body: JSON.stringify({ ok: true, from: 'backup' }) }
  })

  const providers: ProxyProvider[] = [
    { id: 'p1', kind: 'anthropic', name: 'Primary', baseUrl: primary.url, apiKey: 'k1', priority: 1, enabled: true },
    {
      id: 'p2',
      kind: 'anthropic',
      name: 'Backup',
      baseUrl: backup.url,
      apiKey: 'k2',
      priority: 2,
      enabled: true,
      modelMap: { 'claude-opus': 'claude-sonnet' }
    }
  ]

  const proxy = new LocalProxy({ getProviders: () => providers })
  try {
    const st = await proxy.start(0)
    assert.equal(st.running, true)

    // First request hits primary (429) -> fails over to backup (200) + rewrites model
    const res1 = await fetch(`http://127.0.0.1:${proxy.boundPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus', messages: [] })
    })
    assert.equal(res1.status, 200)
    assert.equal(res1.headers.get('x-oah-provider'), 'p2')
    assert.equal(receivedModel, 'claude-sonnet')
    assert.equal(primaryHits, 1)
    assert.equal(backupHits, 1)

    // Primary circuit is now open -> second request skips primary completely
    const statusAfter = proxy.status()
    assert.equal(statusAfter.providers.find((p) => p.id === 'p1')?.circuit, 'open')
    assert.equal(statusAfter.providers.find((p) => p.id === 'p2')?.circuit, 'closed')

    const res2 = await fetch(`http://127.0.0.1:${proxy.boundPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus', messages: [] })
    })
    assert.equal(res2.status, 200)
    assert.equal(primaryHits, 1)
    assert.equal(backupHits, 2)

    // Latency bench
    const bench = await benchProviders(providers)
    assert.equal(bench.length, 2)
    assert.equal(bench[0]!.ok, true)
    assert.equal(bench[0]!.band, 'fast')
  } finally {
    await proxy.stop()
    await new Promise<void>((r) => primary.server.close(() => r()))
    await new Promise<void>((r) => backup.server.close(() => r()))
  }
})
