import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KV } from '../src/kv.ts'
import { runTelegram } from '../src/sources/telegram-loops.ts'
import type { SourceContext } from '../src/sources/host.ts'

/** A Bot API stand-in that answers `getUpdates` from a queue and records the offsets it was asked for. */
let server: Server
let base: string
let batches: { update_id: number; message?: unknown; edited_message?: unknown }[][]
let offsets: (number | undefined)[]

beforeEach(async () => {
  batches = []; offsets = []
  server = createServer((req, res) => {
    const method = (req.url ?? '').split('/').pop() ?? ''
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      if (method !== 'getUpdates') {
        // `getMe` returns the bot identity; `getChat` returns a chat title. Answer both so a poll round can complete.
        const result = method === 'getMe'
          ? { id: 42, is_bot: true, first_name: 'Super', username: 'SuperAgentBot' }
          : { title: 'Team' }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }))
        return
      }
      offsets.push(body.offset as number | undefined)
      const batch = batches.shift() ?? []
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result: batch }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })

interface Parts {
  ctx: SourceContext
  store: Map<string, unknown>
  received: unknown[]
  health: { entry: string; state: string }[]
}

/** A Source context with only what the loop reads; `tokenEnv` names a variable the test sets. */
function context(tokenEnv = 'TG_TOKEN'): Parts {
  const store = new Map<string, unknown>()
  const received: unknown[] = []
  const health: { entry: string; state: string }[] = []
  const ctx = {
    ready: Promise.resolve(),
    deployment: { telegram: { apiBase: base, id: 42, username: 'SuperAgentBot', name: 'Super' } },
    config: (kind: string) => kind === 'telegram' ? { tokenEnv, apiBase: base, chats: [], directMessages: true, otherChats: 'mentions', pollSeconds: 1 } : undefined,
    configured: () => true,
    receive: (trigger: unknown) => { received.push(trigger); return { duplicate: false } },
    state: {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => { if (value === undefined) store.delete(key); else store.set(key, value) },
      keys: () => [],
    },
    report: (entry: string, value: { state: string }) => { health.push({ entry, state: value.state }) },
    threads: { get: () => undefined, subscribed: () => [], describe: () => {}, patch: () => {} },
  } as unknown as SourceContext
  return { ctx, store, received, health }
}

const text = 'fix it @SuperAgentBot'
const message = (id: number) => ({
  message_id: id, date: 1_760_000_000, chat: { id: -1001, type: 'supergroup' },
  from: { id: 7, is_bot: false, first_name: 'Ada' }, text,
  entities: [{ type: 'mention', offset: text.indexOf('@SuperAgentBot'), length: 14 }],
})

/** Runs the loop until `done` holds, then aborts, so no assertion reads a round still in flight. */
async function run(tokenEnv: string, done: (parts: Parts) => boolean): Promise<Parts> {
  const parts = context(tokenEnv)
  const controller = new AbortController()
  const running = runTelegram(parts.ctx, controller.signal)
  const deadline = Date.now() + 5_000
  while (!done(parts) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  controller.abort()
  await running
  return parts
}

describe('runTelegram', () => {
  beforeEach(() => { process.env.TG_TOKEN = 'T' })
  afterEach(() => { delete process.env.TG_TOKEN })

  it('advances the offset past the whole batch, so a restart resumes after it', async () => {
    batches = [[{ update_id: 10, message: message(100) }, { update_id: 11, message: message(101) }]]
    const { store, received } = await run('TG_TOKEN', parts => parts.store.has(KV.telegram.offset))
    expect(received).toHaveLength(2)
    expect(store.get(KV.telegram.offset)).toBe(12)
  })

  it('does not advance the offset when nothing arrived', async () => {
    batches = [[]]
    const { store, received } = await run('TG_TOKEN', parts => parts.health.length > 0)
    expect(received).toHaveLength(0)
    expect(store.has(KV.telegram.offset)).toBe(false)
  })

  it('asks again from the stored offset, so Telegram never repeats a read update', async () => {
    batches = [[{ update_id: 10, message: message(100) }], [{ update_id: 11, message: message(101) }]]
    await run('TG_TOKEN', () => offsets.length >= 3)
    expect(offsets[1]).toBe(11)
  })

  it('reads an update kind it does not ingest without ingesting it', async () => {
    batches = [[{ update_id: 10, edited_message: message(100) }]]
    const { received } = await run('TG_TOKEN', () => offsets.length >= 2)
    expect(received).toHaveLength(0)
  })

  it('reports that it is listening while nothing has arrived', async () => {
    batches = [[]]
    const { health } = await run('TG_TOKEN', parts => parts.health.length > 0)
    expect(health.at(-1)).toMatchObject({ entry: 'telegram', state: 'ready' })
  })

  it('reports an error rather than reading, when the token variable is not set', async () => {
    const { health, received, store } = await run('TG_UNSET', parts => parts.health.length > 0)
    expect(received).toHaveLength(0)
    expect(health.at(-1)).toMatchObject({ entry: 'telegram', state: 'error' })
    expect(store.has(KV.telegram.offset)).toBe(false)
    expect(offsets).toHaveLength(0)
  })
})
