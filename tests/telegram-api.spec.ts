import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { call, getChat, getUpdates, sendMessage, TelegramError } from '../src/sources/telegram-api.ts'

/** A Bot API stand-in that answers `method` from `handlers` and records every call it received. */
interface Hit { method: string; body: Record<string, unknown> }
let server: Server
let base: string
let hits: Hit[]
let handlers: Record<string, (body: Record<string, unknown>) => unknown>

beforeEach(async () => {
  hits = []; handlers = {}
  server = createServer((req, res) => {
    const method = (req.url ?? '').split('/').pop() ?? ''
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      hits.push({ method, body })
      const handler = handlers[method]
      // An unanswered method is a failure the test will notice through the error it raises.
      if (!handler) { res.writeHead(404).end('{}'); return }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(handler(body)))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
})
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })

const ok = (result: unknown) => ({ ok: true, result })
const fail = (error_code: number, description: string, parameters?: unknown) => ({ ok: false, error_code, description, ...parameters ? { parameters } : {} })

describe('call', () => {
  it('posts the body and returns the result the schema accepts', async () => {
    handlers.getMe = () => ok({ id: 1, is_bot: true, first_name: 'Bot', username: 'bot' })
    const me = await call(base, 'getMe', { probe: 1 }, z.object({ username: z.string() }), { token: 'T' })
    expect(me.username).toBe('bot')
    expect(hits[0]).toMatchObject({ method: 'getMe', body: { probe: 1 } })
  })

  it('raises TelegramError carrying the error_code', async () => {
    handlers.getMe = () => fail(401, 'Unauthorized')
    await expect(call(base, 'getMe', {}, z.unknown(), { token: 'T' })).rejects.toThrow(TelegramError)
    const error = await call(base, 'getMe', {}, z.unknown(), { token: 'T' }).catch((thrown: unknown) => thrown)
    expect((error as TelegramError).code).toBe(401)
    expect((error as TelegramError).message).toBe('Unauthorized')
  })

  it('keeps the retry_after of a rate limit so the caller can wait as long as asked', async () => {
    handlers.sendMessage = () => fail(429, 'Too Many Requests', { retry_after: 7 })
    const error = await call(base, 'sendMessage', {}, z.unknown(), { token: 'T' }).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(TelegramError)
    expect((error as TelegramError).code).toBe(429)
    expect((error as TelegramError).retryAfter).toBe(7)
  })

  it('raises a retryable error, code 0, when the answer is not the envelope', async () => {
    handlers.getMe = () => ({ unexpected: true })
    const error = await call(base, 'getMe', {}, z.unknown(), { token: 'T' }).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(TelegramError)
    expect((error as TelegramError).code).toBe(0)
  })
})

describe('getUpdates', () => {
  it('asks for the long poll with the offset and returns the next one past the batch', async () => {
    handlers.getUpdates = () => ok([{ update_id: 10, message: { message_id: 1, date: 1, chat: { id: 1, type: 'private' } } }, { update_id: 11 }])
    const { updates, next } = await getUpdates(base, 'T', 10, 25)
    expect(updates).toHaveLength(2)
    // The next call must acknowledge 11 as well, so Telegram never hands it out again.
    expect(next).toBe(12)
    expect(hits[0]?.body).toMatchObject({ offset: 10, timeout: 25 })
  })

  it('sends no offset on the first round, so Telegram hands out what it still holds', async () => {
    handlers.getUpdates = () => ok([])
    const { next } = await getUpdates(base, 'T', undefined, 25)
    expect(hits[0]?.body).not.toHaveProperty('offset')
    expect(next).toBe(0)
  })
})

describe('sendMessage', () => {
  it('replies under the message inside its forum topic', async () => {
    handlers.sendMessage = () => ok({ message_id: 5 })
    await sendMessage(base, 'T', { chatId: '-1001', text: 'done', threadId: '9', replyToMessageId: '100' })
    expect(hits[0]?.body).toMatchObject({ chat_id: '-1001', text: 'done', message_thread_id: 9,
      reply_parameters: { message_id: 100, allow_sending_without_reply: true } })
  })

  it('omits the thread outside a forum topic', async () => {
    handlers.sendMessage = () => ok({ message_id: 5 })
    await sendMessage(base, 'T', { chatId: '7', text: 'done' })
    expect(hits[0]?.body).not.toHaveProperty('message_thread_id')
  })
})

describe('getChat', () => {
  it('returns the title a chat is labelled with', async () => {
    handlers.getChat = () => ok({ type: 'supergroup', title: 'Product' })
    await expect(getChat(base, 'T', '-1001')).resolves.toEqual({ title: 'Product' })
  })

  it('returns undefined when the bot is no longer in the chat, which is not worth failing a round over', async () => {
    handlers.getChat = () => fail(403, 'Forbidden: bot was kicked from the group chat')
    await expect(getChat(base, 'T', '-1001')).resolves.toBeUndefined()
  })
})
