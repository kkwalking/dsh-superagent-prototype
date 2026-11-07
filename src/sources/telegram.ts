/** Telegram source kind definition, the polling loop entry, and the Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { TelegramBotSchema } from '../deployment.ts'
import { TELEGRAM_API } from './telegram-api.ts'
import { sendTelegram, telegramAddressable, telegramLink } from './telegram-channel.ts'
import { chatLabels, runTelegram } from './telegram-loops.ts'
import { SOURCE, telegramParent, telegramRef, telegramTriggerId } from './telegram-trigger.ts'
import { sourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import type { SourceRegistry } from './registry.ts'

export { SOURCE, displayName, telegramMessageLink, telegramParent, telegramRef, telegramThreadId, telegramTrigger, telegramTriggerId }
  from './telegram-trigger.ts'
export type { TelegramChat, TelegramMessage, TelegramUpdate, TelegramUser } from './telegram-trigger.ts'
export { MESSAGE_LIMIT, sendTelegram } from './telegram-channel.ts'
export { BotInfoSchema, getUpdates, TELEGRAM_API, TelegramError } from './telegram-api.ts'
export { chatLabels, runTelegram } from './telegram-loops.ts'

/** Senders are Telegram users, so the Policy lists numeric ids without a display name of their own. */
const AllowedSchema = z.object({ id: z.string(), name: z.string().optional() })

const TelegramConfigSchema = TelegramBotSchema.extend({
  /** Chats the bot receives from, keyed by Telegram chat id; `chatId` may also name a forum topic as `chat:topic`. */
  chats: z.array(z.object({
    chatId: z.string().regex(/^-?\d+$/),
    name: z.string().trim().max(80).optional(),
    listen: z.enum(['mentions', 'all']).default('mentions'),
  }).strict())
    .refine(chats => new Set(chats.map(chat => chat.chatId)).size === chats.length, 'Duplicate chat IDs')
    .default([]),
  /** Private messages reach the agent without a mention, so this switch is the only thing that admits them. */
  directMessages: z.boolean().default(true),
  /** What to do in a group the list above does not name: ignore it, or receive only mentions. */
  otherChats: z.enum(['none', 'mentions']).default('mentions'),
  /** How long a long poll may hold the connection; Telegram caps it at 50 seconds. */
  pollSeconds: z.number().int().min(1).max(50).default(25),
}).strict()
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>

export const telegramKind: SourceKind<TelegramConfig> = {
  kind: SOURCE,
  title: { zh: 'Telegram', en: 'Telegram' },
  description: { zh: '接收下列 Telegram 会话中发给机器人的消息；要工作不需要 GitHub 通知，直接发消息即可。',
    en: 'Receives messages to the bot in these Telegram chats. Work needs no GitHub notification: sending a message is enough.' },
  schema: TelegramConfigSchema,
  fields: [
    { key: 'tokenEnv', type: 'text', label: { zh: '机器人 token 的环境变量', en: 'Bot token environment variable' },
      hint: { zh: '写环境变量名，不写 token。把 token 放进 ~/.dsh/.env，例如 TELEGRAM_BOT_TOKEN=123:ABC。保存时校验它能否登录机器人，然后重启 dsh-superagent。',
        en: 'Name the variable, never paste the token. Put it in ~/.dsh/.env, for example TELEGRAM_BOT_TOKEN=123:ABC. Saving checks it against the bot, then restarts dsh-superagent.' } },
    { key: 'chats', type: 'rows', label: { zh: '接收的会话', en: 'Chats' },
      hint: { zh: '“仅 @”只接收 @ 机器人的消息；“全部消息”也接收其余消息，评估可以按规则从中推断工作，这需要机器人关闭隐私模式。',
        en: '"@ only" receives messages that mention the bot; "All" also receives the rest, from which Eval may infer work, and needs the bot\'s privacy mode off.' },
      columns: [
        { key: 'chatId', type: 'text', label: { zh: '会话 id', en: 'Chat id' }, pattern: '-?\\d+' },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [{ value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
      ] },
    { key: 'otherChats', type: 'select', label: { zh: '其他会话', en: 'Other chats' },
      options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }],
      hint: { zh: '机器人已加入、但没列在上面的会话。“仅 @”接收那里 @ 机器人的消息；谁的消息能发起工作看策略里的准入。',
        en: 'Chats the bot has joined that are not listed above. "@ only" receives messages there that mention the bot; whose messages may originate work is the Policy\'s admission.' } },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 1, max: 50, label: { zh: '长轮询 / 秒', en: 'Long poll / seconds' },
      hint: { zh: '没有消息时连接保持多久；越长越省请求，消息到达也越及时。', en: 'How long the connection waits when nothing arrives; longer spends fewer requests and still delivers at once.' } },
  ],
  health: ['telegram'],
  /**
   * A private message reaches the agent even without a mention, so `direct` is its own row. A group needs a mention
   * unless the chat is listed with `listen: all`, which is what makes Eval able to infer work from it.
   */
  scope({ meta }, config) {
    const chatId = String(meta.chatId ?? '')
    const direct = meta.direct === true
    if (direct) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    const chat = config.chats.find(item => item.chatId === chatId)
    if (chat) return { listened: true, observed: chat.listen === 'all', row: chatId }
    return config.otherChats === 'mentions' ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'chat_not_allowed' }
  },
  // A reply goes only to a chat the Source still receives, so switching a chat off silences it too.
  channel: { allowed: telegramAddressable, send: sendTelegram, link: telegramLink },
  /** Telegram has no server-side history search, so a 12-digit id in the search box looks up a message by its chat. */
  find: query => {
    const chat = /^(-?\d+)(?::(\d+))?$/.exec(query.trim())?.[0]
    return { threads: chat ? [`${SOURCE}:${chat}`] : [], terms: [] }
  },
  repliesTo: telegramParent,
  policy: {
    schema: z.object({ allowed: z.array(AllowedSchema).default([]) }),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '可以发起工作的 Telegram 用户', en: 'Telegram users who may request work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '用户 id', en: 'User id' } },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' } }] }],
    explicit: { zh: '在私聊里说话，或在群里 @ 机器人', en: 'Speaking in a direct message, or mentioning the bot in a group' },
    unnamed: { person: { zh: 'Telegram 用户', en: 'Telegram user' }, bot: { zh: 'Telegram 机器人', en: 'Telegram bot' } },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_TELEGRAM_BOT', description: { zh: 'Telegram 机器人用户名，不带 @', en: 'The Telegram bot username, without the @' } },
      { key: 'DSH_SUPERAGENT_TELEGRAM_CHAT', description: { zh: '接下工单的 Telegram 会话 id；工单不是从 Telegram 来的时为空', en: 'Chat id of the Telegram conversation that started the ticket; empty when the ticket did not start on Telegram' } },
    ],
    // Only the chat id comes from the Trigger; the bot username is optional and read from the deployment when there is
    // one, so a Telegram-only install changes nothing for workers.
    values: ({ deployment, trigger }) => ({ DSH_SUPERAGENT_TELEGRAM_BOT: deployment?.telegram?.username ?? '',
      DSH_SUPERAGENT_TELEGRAM_CHAT: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '' }),
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.telegram
    ? { bot: { zh: `当前机器人 @${deployment.telegram.username}`, en: `Current bot @${deployment.telegram.username}` } } : {},
}

/** Returns the Telegram Source's settings, falling back to schema defaults while the Telegram plugin is disabled. */
export const telegramSettings = (sources: SourceRegistry): TelegramConfig =>
  sources.instance<TelegramConfig>(SOURCE)?.config ?? TelegramConfigSchema.parse({})

/** The chat titles the Source resolved, exposed for the panel's Thread labels. */
export { TELEGRAM_API as defaultApiBase }

export const name = 'dsh-superagent-telegram'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(telegramKind), 'telegram: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runTelegram(sourceContext(ctx.orchestrator, telegramKind), controller.signal)
    return async () => { controller.abort(); await running }
  })
}
