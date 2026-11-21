// Minimal Node API declarations so `tsc` passes without @types/node (zero npm dependencies).
declare module 'node:child_process' {
  export function execFile(
    file: string,
    args: readonly string[],
    options: { cwd?: string | undefined; timeout?: number; maxBuffer?: number; env?: Record<string, string | undefined> },
    callback: (error: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void
  ): unknown
  export type ChildProcess = {
    pid?: number
    unref(): void
    on(event: string, cb: (...args: any[]) => void): ChildProcess
  }
  export function spawn(
    file: string,
    args: readonly string[],
    options?: {
      cwd?: string
      env?: Record<string, string | undefined>
      detached?: boolean
      stdio?: 'ignore' | 'inherit' | 'pipe' | readonly ('ignore' | 'inherit' | 'pipe' | number)[]
    }
  ): ChildProcess
}
declare module 'node:fs' {
  export function existsSync(path: string): boolean
  export function realpathSync(path: string): string
  export function mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): unknown
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function writeFileSync(path: string, data: string, options?: { mode?: number; encoding?: 'utf8' }): void
  export function appendFileSync(path: string, data: string, options?: { mode?: number; encoding?: 'utf8' }): void
  export function openSync(path: string, flags: string, mode?: number): number
  export function closeSync(fd: number): void
  export function renameSync(from: string, to: string): void
  export function unlinkSync(path: string): void
  export function chmodSync(path: string, mode: number): void
  export function mkdtempSync(prefix: string): string
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void
  export function readdirSync(path: string): string[]
  export function symlinkSync(target: string, path: string): void
  export function statSync(path: string): { mode: number; size: number }
  export type FSWatcher = { close(): void; on(event: string, cb: () => void): unknown }
  export function watch(path: string, listener: () => void): FSWatcher
}
declare module 'node:net' {
  export type Socket = {
    write(data: string): boolean
    end(): void
    destroy(): void
    unref(): void
    on(event: 'data', cb: (chunk: { toString(enc?: string): string }) => void): Socket
    on(event: 'error', cb: (err: Error & { code?: string }) => void): Socket
    on(event: 'close' | 'connect' | 'end', cb: () => void): Socket
    setEncoding(encoding: 'utf8'): Socket
  }
  export type Server = {
    listen(path: string, cb?: () => void): Server
    close(cb?: (err?: Error) => void): Server
    on(event: 'error', cb: (err: Error & { code?: string }) => void): Server
    on(event: 'connection', cb: (socket: Socket) => void): Server
  }
  export function createServer(listener?: (socket: Socket) => void): Server
  export function createConnection(path: string, listener?: () => void): Socket
}
declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
}
declare module 'node:path' {
  export function dirname(path: string): string
  export function join(...parts: string[]): string
  export function resolve(...parts: string[]): string
}
declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string
}
declare module 'node:test' {
  export default function test(name: string, fn: () => unknown | Promise<unknown>): void
}
declare module 'node:assert/strict' {
  const assert: {
    ok(value: unknown, message?: string): asserts value
    equal<T>(actual: T, expected: T, message?: string): void
    deepEqual(actual: unknown, expected: unknown, message?: string): void
    match(actual: string, regexp: RegExp, message?: string): void
    throws(fn: () => unknown, error?: RegExp | ((err: unknown) => boolean)): void
  }
  export default assert
}
declare const process: {
  argv: string[]
  cwd(): string
  env: Record<string, string | undefined>
  platform: string
  execPath: string
  pid: number
  stdout: { write(data: string): boolean; isTTY?: boolean }
  stderr: { write(data: string): boolean; isTTY?: boolean }
  exit(code?: number): never
  kill(pid: number, signal?: number | string): boolean
  on(event: string, cb: (...args: any[]) => void): unknown
}
declare const Buffer: {
  from(data: string, encoding?: 'utf8' | 'base64' | 'base64url'): { toString(encoding?: 'utf8' | 'base64' | 'base64url'): string; length: number }
}
declare function require(id: string): any
