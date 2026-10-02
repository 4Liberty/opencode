// Native messaging host for Open Extension. The browser starts it per request; it answers with the
// opencode background service's URL and password, starting the service when it is not running.
// Framing: each message is a 4-byte little-endian length followed by that many bytes of JSON.

export {}

const opencode = process.env.OPENCODE_BIN || "opencode"

const reader = Bun.stdin.stream().getReader()
let buffer = new Uint8Array(0)

while (true) {
  const message = await read()
  if (message === undefined) break
  write(await respond(message))
}

async function respond(message: unknown) {
  if (typeof message !== "object" || message === null || !("type" in message) || message.type !== "service")
    return { ok: false, error: "Unknown request." }
  // `service start` returns the running service's URL, electing one first when none is running.
  const started = run(["service", "start"])
  if (!started.ok) return { ok: false, error: `Could not start opencode: ${started.output || "no output"}` }
  const url = started.output.split("\n").findLast((line) => /^https?:\/\//.test(line.trim()))?.trim()
  if (!url) return { ok: false, error: `opencode did not report a service URL: ${started.output}` }
  const password = run(["service", "get", "password"])
  if (!password.ok || !password.output) return { ok: false, error: "Could not read the opencode service password." }
  return { ok: true, url: reachable(url), password: password.output }
}

function run(args: string[]) {
  const result = Bun.spawnSync([opencode, ...args], { stdout: "pipe", stderr: "pipe", timeout: 30_000 })
  const output = result.stdout.toString().trim()
  return { ok: result.exitCode === 0, output: output || result.stderr.toString().trim() }
}

/** A service bound to every interface is reached on loopback; browsers refuse to fetch 0.0.0.0. */
function reachable(input: string) {
  const url = new URL(input)
  if (url.hostname === "0.0.0.0" || url.hostname === "[::]") url.hostname = "127.0.0.1"
  return url.origin
}

async function read(): Promise<unknown> {
  while (buffer.length < 4) if (!(await fill())) return undefined
  const length = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0, true)
  while (buffer.length < 4 + length) if (!(await fill())) return undefined
  const body = buffer.slice(4, 4 + length)
  buffer = buffer.slice(4 + length)
  return JSON.parse(new TextDecoder().decode(body))
}

async function fill() {
  const chunk = await reader.read()
  if (chunk.done) return false
  const next = new Uint8Array(buffer.length + chunk.value.length)
  next.set(buffer)
  next.set(chunk.value, buffer.length)
  buffer = next
  return true
}

function write(message: unknown) {
  const body = new TextEncoder().encode(JSON.stringify(message))
  const header = new Uint8Array(4)
  new DataView(header.buffer).setUint32(0, body.length, true)
  process.stdout.write(header)
  process.stdout.write(body)
}
