// Newline-delimited JSON-RPC + push-event framing over a Unix domain socket.
// Shared by `oahd` (server), `oah` (CLI client), and the thin Orca plugin worker (bridge client).

export type RpcRequest = {
  type: 'req'
  id: string
  method: string
  params?: unknown
}

export type RpcResponse =
  | { type: 'res'; id: string; ok: true; result: unknown }
  | { type: 'res'; id: string; ok: false; error: { code?: string; message: string } }

export type RpcEvent = {
  type: 'event'
  event: string
  data: unknown
}

export type WireMessage = RpcRequest | RpcResponse | RpcEvent

export function encodeMessage(msg: WireMessage): string {
  return `${JSON.stringify(msg)}\n`
}

/** Splits an incoming UTF-8 stream into complete JSON messages. */
export function createLineParser(onMessage: (msg: WireMessage) => void): (chunk: string) => void {
  let buf = ''
  return (chunk: string) => {
    buf += chunk
    let idx = buf.indexOf('\n')
    while (idx >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (line) {
        try {
          onMessage(JSON.parse(line) as WireMessage)
        } catch {
          // Drop malformed line rather than crashing the daemon or client.
        }
      }
      idx = buf.indexOf('\n')
    }
  }
}
