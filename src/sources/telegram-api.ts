/**
 * Minimal Telegram Bot API client over `fetch`.
 *
 * The Source talks to Telegram directly rather than through a CLI, so every call goes through `call`: it builds the
 * method URL, maps a Bot API error onto a typed failure, and enforces a timeout so a stalled request cannot hold a
 * polling round open.
 */
import { z } from 'zod'

/** The Bot API root; tests point it at a local server. */
export const TELEGRAM_API = 'https://api.telegram.org'

/** A Bot API failure that the caller can act on: `code` is Telegram's `error_code`, or 0 when it never answered. */
export class TelegramError extends Error {
  constructor(message: string, readonly code: number, readonly retryAfter?: number) {
    super(message)
    this.name = 'TelegramError'
  }
}

/** Telegram wraps every answer in this envelope; `ok: false` carries the reason. */
const Envelope = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
  error_code: z.number().optional(),
  parameters: z.looseObject({ retry_after: z.number().optional(), migrate_to_chat_id: z.number().optional() }).optional(),
})

export interface CallOptions {
  /** The bot token; the URL carries it, as the Bot API has no other authentication. */
  token: string
  /** Overrides the default timeout; a long poll asks Telegram to hold the connection, so it must exceed it. */
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * Calls one Bot API method and returns its `result`.
 * @throws TelegramError when Telegram reports `ok: false`, when the request times out, or when it cannot connect.
 */
export async function call<T>(base: string, method: string, body: unknown, schema: z.ZodType<T>, options: CallOptions): Promise<T> {
  const { token } = options
  const { timeoutMs = 20_000, signal } = options
  const deadline = AbortSignal.timeout(timeoutMs)
  let response: Response
  try {
    response = await fetch(`${base.replace(/\/$/, '')}/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    })
  } catch (error) {
    // A timeout or a connection failure is retried by the caller on its next round, so it stays a retryable error.
    throw new TelegramError(`Telegram ${method} failed: ${error instanceof Error ? error.message : String(error)}`, 0)
  }
  let parsed: z.infer<typeof Envelope>
  try { parsed = Envelope.parse(await response.json()) }
  // An answer the envelope cannot read is a proxy or edge failure, not a rejection of the request: code 0 stays retryable.
  catch { throw new TelegramError(`Telegram ${method} returned an unreadable answer (HTTP ${response.status})`, 0) }
  if (!parsed.ok) {
    throw new TelegramError(parsed.description ?? `Telegram ${method} failed`, parsed.error_code ?? response.status,
      parsed.parameters?.retry_after)
  }
  const result = schema.safeParse(parsed.result)
  if (!result.success) throw new TelegramError(`Telegram ${method} returned an unexpected result`, 0)
  return result.data
}

/** The bot's own identity, which decides which mentions address it and which messages to reply to. */
export const BotInfoSchema = z.object({
  id: z.number().int(),
  is_bot: z.literal(true),
  first_name: z.string(),
  username: z.string(),
})
export type BotInfo = z.infer<typeof BotInfoSchema>

/** Reads the bot's own identity; the Source caches it so a poll round does not ask again. */
export async function getMe(base: string, token: string, signal?: AbortSignal): Promise<BotInfo> {
  return call(base, 'getMe', {}, BotInfoSchema, { token, signal })
}

/**
 * The parts of a `message` the Source reads. Everything else the Bot API sends (stickers, polls, service messages)
 * is ignored, and a message carrying no text or caption is dropped by the Trigger mapping instead of failing the round.
 */
export const MessageSchema = z.object({
  message_id: z.number().int(),
  date: z.number().int(),
  chat: z.object({ id: z.number().int(), type: z.enum(['private', 'group', 'supergroup', 'channel']), title: z.string().optional(), username: z.string().optional() }).strip(),
  from: z.object({ id: z.number().int(), is_bot: z.boolean(), first_name: z.string(), last_name: z.string().optional(), username: z.string().optional() }).strip().optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  reply_to_message: z.object({ message_id: z.number().int() }).strip().optional(),
  entities: z.array(z.object({ type: z.string(), offset: z.number().int(), length: z.number().int() }).strip()).optional(),
  sender_chat: z.object({ id: z.number().int() }).strip().optional(),
  forward_origin: z.object({ type: z.string(), chat: z.unknown().optional() }).strip().optional(),
  message_thread_id: z.number().int().optional(),
}).strip()

/** One update as `getUpdates` returns it, before it is mapped onto a Trigger. */
export const UpdateSchema = z.object({
  update_id: z.number().int(),
  message: MessageSchema.optional(),
  edited_message: MessageSchema.optional(),
  channel_post: MessageSchema.optional(),
}).strip()

/**
 * Reads pending updates. With `timeout` Telegram holds the request until an update arrives, so a long poll trades a
 * slow round for fewer requests; an empty `offset` asks for everything Telegram still holds.
 */
export async function getUpdates(base: string, token: string, offset: number | undefined, timeoutSeconds: number, signal?: AbortSignal): Promise<{ updates: z.infer<typeof UpdateSchema>[]; next: number }> {
  const updates = await call(base, 'getUpdates', {
    ...offset !== undefined ? { offset } : {},
    timeout: timeoutSeconds,
    // Reply and edit events are not ingested: Telegram does not report a reliable edit history, and a reply already
    // arrives with `reply_to_message`.
    allowed_updates: ['message', 'channel_post'],
    limit: 100,
  }, z.array(UpdateSchema), { token, timeoutMs: (timeoutSeconds + 10) * 1000, signal })
  const next = updates.reduce((highest, update) => Math.max(highest, update.update_id + 1), offset ?? 0)
  return { updates, next }
}

/** Sends a message, optionally as a reply inside a forum topic. */
export async function sendMessage(base: string, token: string, input: {
  chatId: string
  text: string
  threadId?: string
  replyToMessageId?: string
}, signal?: AbortSignal): Promise<void> {
  await call(base, 'sendMessage', {
    chat_id: input.chatId,
    text: input.text,
    // Telegram rejects Markdown the agent did not escape, and the panel already renders plain text.
    link_preview_options: { is_disabled: true },
    ...input.threadId !== undefined ? { message_thread_id: Number(input.threadId) } : {},
    ...input.replyToMessageId !== undefined ? { reply_parameters: { message_id: Number(input.replyToMessageId), allow_sending_without_reply: true } } : {},
  }, z.unknown(), { token, signal })
}

/** Reads a chat's title, which the panel shows as the Thread's label. */
export async function getChat(base: string, token: string, chatId: string, signal?: AbortSignal): Promise<{ title: string } | undefined> {
  try {
    const chat = await call(base, 'getChat', { chat_id: chatId },
      z.looseObject({ type: z.string(), title: z.string().optional(), username: z.string().optional(), first_name: z.string().optional() }), { token, signal })
    const title = chat.title ?? chat.username ?? chat.first_name
    return title ? { title } : undefined
  } catch (error) {
    // A chat the bot left or was removed from is not an error worth failing a round over; the label is only cosmetic.
    if (error instanceof TelegramError && (error.code === 400 || error.code === 403)) return undefined
    throw error
  }
}

/** True when Telegram permanently rejects the target: the chat is gone or the bot was removed from it. */
export const gone = (error: unknown): boolean => error instanceof TelegramError && (error.code === 400 || error.code === 403)
