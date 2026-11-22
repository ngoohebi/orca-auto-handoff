// Persistent bidirectional NDJSON stdio session (`oah session`).
// Auto-starts local `oahd` on the host where `oah session` runs, subscribes to live push events,
// and forwards JSON-RPC requests/responses between stdin/stdout and `oahd.sock`.
// This lets the thin Orca plugin attach to ANY workspace's `oah` (local or paired server)
// using the exact same protocol.
import { createConnection } from 'node:net'
import { createLineParser, encodeMessage, type WireMessage } from '../daemon/ipc.ts'
import type { OahClient } from './client.ts'

export async function runSession(client: OahClient): Promise<void> {
  await client.ensureDaemon()
  const sock = createConnection(client.sockPath)
  sock.setEncoding('utf8')

  await new Promise<void>((resolve, reject) => {
    sock.on('connect', () => {
      // Subscribe immediately so push events stream over stdout.
      sock.write(encodeMessage({ type: 'req', id: '__sub__', method: 'subscribe', params: {} }))
      resolve()
    })
    sock.on('error', reject)
  })

  const fromDaemon = createLineParser((msg: WireMessage) => {
    if (msg.type === 'res' && msg.id === '__sub__') return
    process.stdout.write(encodeMessage(msg))
  })
  sock.on('data', (chunk) => fromDaemon(chunk.toString('utf8')))

  process.stdin.setEncoding('utf8')
  const fromClient = createLineParser((msg: WireMessage) => {
    sock.write(encodeMessage(msg))
  })
  process.stdin.on('data', (chunk) => fromClient(chunk))

  await new Promise<void>((resolve) => {
    sock.on('close', () => resolve())
    process.stdin.on('end', () => {
      sock.end()
      resolve()
    })
  })
}
