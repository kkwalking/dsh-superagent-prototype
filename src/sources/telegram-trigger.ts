/**
 * Telegram Bot API update types, the mapping from an update onto a Trigger, and the Thread id scheme.
 *
 * Telegram identifies a conversation by a chat id and a message by a message id that is unique within that chat, so a
 * Trigger's Thread is the chat and the message id names the message the agent must reply to.
 */
import { key } from '../core/ids.ts'
import type { ChannelRef, Trigger } from '../core/model.ts'

export const SOURCE = 'telegram'
/** The Trigger id of one message: a chat id plus a message id name it on its own. */
export const telegramTriggerId = (chatId: string, messageId: number): string => key('telegram', chatId, String(messageId))

/** One Telegram user or bot as the Bot API reports it. */
export interface TelegramUser { id: number; is_bot: boolean; first_name: string; last_name?: string; username?: string }

/** A Telegram chat: private, group, supergroup, or channel. */
export interface TelegramChat { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string; username?: string }

/** A `message` entity in an update. Fields not needed for a Trigger are omitted. */
export interface TelegramMessage {
  message_id: number
  date: number
  chat: TelegramChat
  from?: TelegramUser
  text?: string
  caption?: string
  /** Present when this message replies to one; the replied-to message names the parent of the Trigger. */
  reply_to_message?: { message_id: number }
  /** A `@bot` mention arrives as an entity over these offsets; Telegram leaves the raw mention in `text`. */
  entities?: { type: string; offset: number; length: number; user?: TelegramUser }[]
  /** Present when the message was posted on behalf of a chat rather than by one person. */
  sender_chat?: { id: number }
  /** Present when the message was forwarded from somewhere else. */
  forward_origin?: { type: string; chat?: unknown }
  /** A forum topic's thread id, present for messages in a topic. */
  message_thread_id?: number
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  channel_post?: TelegramMessage
}

/**
 * The chat a message belongs to, as a Thread key. A forum topic is part of the conversation: two topics of one
 * supergroup carry unrelated work, so the topic is in the Thread id and Triggers in each stay apart.
 */
export const telegramThreadId = (chatId: number, threadId?: number): string =>
  threadId === undefined ? String(chatId) : `${chatId}:${threadId}`

/** The `@username` mention entities in `text` that name `bot`. */
const botMentions = (text: string, message: TelegramMessage, bot: string): NonNullable<TelegramMessage['entities']> =>
  (message.entities ?? []).filter(entity => entity.type === 'mention'
    && text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === `@${bot.toLowerCase()}`)

/** True when the message addresses the bot by mention. */
export const mentionsBot = (message: TelegramMessage, bot: string): boolean =>
  botMentions(message.text ?? '', message, bot).length > 0

/** The text an agent reads: the message's text, or an attachment's caption, without the bot's own mention. */
export function readableText(message: TelegramMessage, bot: string): string {
  // An attachment's message carries an empty `text` and its words in `caption`, so an empty string must not win.
  const raw = message.text || message.caption || ''
  if (!raw) return ''
  // Removing from the end keeps the earlier offsets valid.
  return [...botMentions(raw, message, bot)].sort((a, b) => b.offset - a.offset)
    .reduce((text, entity) => `${text.slice(0, entity.offset)}${text.slice(entity.offset + entity.length)}`, raw)
    .trim()
}

/** The display name of a Telegram user: the full name, or the username when the name is empty. */
export const displayName = (user: TelegramUser): string =>
  [user.first_name, user.last_name].filter(Boolean).join(' ') || (user.username ? `@${user.username}` : String(user.id))

/**
 * A deep link that opens the message. Telegram publishes a public link only for a group or supergroup with a username
 * and a forum topic; a private chat and a private group have none, so they fall back to the bot's own link.
 */
export const telegramMessageLink = (chat: TelegramChat, messageId: number, botUsername: string): string =>
  chat.username && (chat.type === 'supergroup' || chat.type === 'channel')
    ? `https://t.me/${chat.username}/${messageId}`
    : `https://t.me/${botUsername}`

/** The channel a reply goes to: the chat, its forum topic when there is one, and the message to reply under. */
export const telegramChannel = (message: TelegramMessage, thread: string): ChannelRef => ({
  source: SOURCE,
  thread,
  address: { chatId: String(message.chat.id), messageId: String(message.message_id),
    ...message.message_thread_id !== undefined ? { threadId: String(message.message_thread_id) } : {} },
})

/**
 * Maps one Telegram message onto a Trigger, or returns `undefined` for a message the Source must never ingest.
 *
 * A message from another bot carries no person's request, and one posted on behalf of a chat names no person. Telegram
 * lets any group member add a bot and forward content, so ingesting those would let a third party inject work.
 */
export function telegramTrigger(message: TelegramMessage, bot: { id: number; username: string }): Trigger | undefined {
  const sender = message.from
  if (!sender || sender.is_bot || message.sender_chat) return undefined
  // A forwarded message carries the text of someone who never spoke here; the person forwarding it is not the sender.
  if (message.forward_origin) return undefined
  const text = readableText(message, bot.username)
  if (!text) return undefined
  const threadId = telegramThreadId(message.chat.id, message.message_thread_id)
  const direct = message.chat.type === 'private'
  const mentioned = mentionsBot(message, bot.username)
  // A direct message reaches the agent even without a mention; elsewhere only a mention addresses it.
  const addressed = direct ? (mentioned ? 'mention' as const : 'direct' as const) : mentioned ? 'mention' as const : undefined
  return {
    id: telegramTriggerId(String(message.chat.id), message.message_id),
    source: SOURCE,
    threads: [{ source: SOURCE, id: threadId }],
    actor: { source: SOURCE, id: String(sender.id) },
    human: true,
    ...addressed ? { addressed } : {},
    at: new Date(message.date * 1000).toISOString(),
    text,
    channel: telegramChannel(message, threadId),
    url: telegramMessageLink(message.chat, message.message_id, bot.username),
    meta: { chatId: String(message.chat.id), chatType: message.chat.type, messageId: message.message_id,
      ...message.chat.title ? { chatTitle: message.chat.title } : {},
      ...message.message_thread_id !== undefined ? { threadId: message.message_thread_id } : {},
      ...message.reply_to_message ? { parentId: message.reply_to_message.message_id } : {},
      direct, mentioned },
  }
}

/** The Trigger whose message this message replies to, when it replies to one. */
export const telegramParent = (trigger: Trigger): string | undefined => {
  const { chatId, parentId } = trigger.meta as { chatId?: string; parentId?: number }
  return trigger.source === SOURCE && chatId && typeof parentId === 'number' ? telegramTriggerId(chatId, parentId) : undefined
}

/** The string a person can type to name this Thread (`chatId`, or `chatId:topicId`), used by the panel's search. */
export const telegramRef = (trigger: Trigger): string | undefined => {
  if (trigger.source !== SOURCE) return undefined
  const { chatId } = trigger.meta as { chatId?: string }
  return chatId ?? trigger.threads[0]?.id
}
