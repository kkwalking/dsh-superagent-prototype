/** Telegram outbound channel: replies as a Telegram message under the Trigger's message, and builds chat links. */
import type { OutboundMessage } from '../core/index.ts'
import { wordCount } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { gone, sendMessage, TelegramError } from './telegram-api.ts'
import { telegramTriggerId } from './telegram-trigger.ts'

/** Telegram rejects a message longer than this, counted in UTF-16 code units. */
export const MESSAGE_LIMIT = 4096
/**
 * A reply is a person-facing summary, not a report: the same ceiling the Feishu channel applies.
 * Its length check keeps one reply short instead of splitting it, because a split loses the thread.
 */
const WORDS = 400

const replyText = (text: string): string => {
  const count = wordCount(text)
  if (count > WORDS) throw new Error(`Telegram reply has ${count} words; maximum is ${WORDS}. Rewrite as a short high-level update. Do not split it into multiple messages.`)
  if (text.length > MESSAGE_LIMIT) throw new Error(`Telegram reply is ${text.length} characters; maximum is ${MESSAGE_LIMIT}. Rewrite it shorter.`)
  return text
}

/**
 * Replies under the Trigger's message. Telegram has no idempotency key, so a retry after an ambiguous failure can
 * repeat a reply; `gone` lets the Effect drop a reply whose chat is unreachable instead of retrying it forever.
 */
export async function sendTelegram(host: Pick<SourceContext, 'commands' | 'config'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const config = host.config<{ tokenEnv: string; apiBase?: string }>('telegram')
  const token = config?.tokenEnv ? process.env[config.tokenEnv]?.trim() : undefined
  // Replies read only their own Source's token, never the global deployment, so Telegram works without GitHub setup.
  if (!token) throw new Error('The Telegram Source has no bot token')
  const { chatId, messageId, threadId } = message.channel.address
  if (!chatId) throw new Error('Missing Telegram reply chat')
  try {
    await sendMessage(config?.apiBase || 'https://api.telegram.org', token, { chatId, text: replyText(message.text),
      ...threadId !== undefined ? { threadId } : {},
      ...messageId !== undefined ? { replyToMessageId: messageId } : {} })
  } catch (error) {
    if (gone(error)) return 'gone'
    // A rate limit is retryable and keeps the Effect pending, which is what the caller wants.
    if (error instanceof TelegramError && error.code === 429) throw error
    throw error
  }
  return 'sent'
}

/** Whether a reply may still reach `address`: the chat id is all a Telegram reply needs. */
export const telegramAddressable = (address: Record<string, string>): boolean => Boolean(address.chatId)

/** The label of a Thread's chat, stored by `refreshLabels`. */
export const telegramLink = (address: Record<string, string>, links: ChannelLinks & { telegramBot?: string }): ChannelLink => ({
  url: links.telegramBot ? `https://t.me/${links.telegramBot}` : '',
  label: { zh: 'Telegram 消息', en: 'Telegram message' },
  ...address.messageId ? { triggerId: telegramTriggerId(address.chatId ?? '', Number(address.messageId)) } : {},
})
