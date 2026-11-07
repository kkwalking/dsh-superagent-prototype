/** Web chat Source kind: a panel chat whose messages become Triggers, and whose replies are recorded back into the chat log. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key } from '../core/ids.ts'
import type { OutboundMessage } from '../core/index.ts'
import { SOURCE, webChannel } from './web-trigger.ts'
import { appendChat } from './web-store.ts'
import { sourceContext } from './host.ts'
import type { Localized, SourceChannel, SourceKind } from './kind.ts'
import type { SourceRegistry } from './registry.ts'

export { SOURCE, webChannel, webThreadId, webTrigger, webTriggerId } from './web-trigger.ts'
export type { WebChatMessage } from './web-trigger.ts'
export { appendChat, CHAT_LOG_LIMIT, readChat } from './web-store.ts'

/** The web chat Source has no transport of its own, so its configuration is just a display name for the operator's own turns. */
const WebConfigSchema = z.object({
  /** The actor id the operator's messages carry, shown as the sender in the panel and the Policy's allowed list. */
  actor: z.string().trim().min(1).max(80).default('operator'),
}).strict()
export type WebConfig = z.infer<typeof WebConfigSchema>

const link = (address: Record<string, string>): { url: string; label: Localized } =>
  ({ url: '', label: { zh: '面板对话', en: 'Panel chat' } })

/**
 * Records the agent's reply into the conversation's chat log. There is no external transport: the panel reads the log back.
 * A reply is always deliverable, so this never returns `gone`.
 */
export async function sendWeb(host: Pick<import('./host.ts').SourceContext, 'state'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const conversation = message.channel.address.conversation
  if (!conversation) return 'gone'
  appendChat(host, conversation, { id: key('webmsg', message.id), role: 'agent', text: message.text, at: new Date().toISOString() })
  return 'sent'
}

const channel: SourceChannel<WebConfig> = { send: sendWeb as SourceChannel<WebConfig>['send'], link }

export const webKind: SourceKind<WebConfig> = {
  kind: SOURCE,
  title: { zh: '面板对话', en: 'Panel chat' },
  description: { zh: '在面板里直接对话：发一条消息就等于发起一次请求，不需要 GitHub 通知或 Telegram。适合手动触发的即时任务。',
    en: 'Chat directly in the panel: sending a message is a request, with no GitHub notification or Telegram needed. Good for on-demand, manually triggered work.' },
  schema: WebConfigSchema,
  fields: [
    { key: 'actor', type: 'text', label: { zh: '你的名字', en: 'Your name' },
      hint: { zh: '你在对话里发的消息以此作为发送者 id。要让工作被接单，请把它加到策略的准入名单里。',
        en: 'Your chat messages carry this as the sender id. To have work accepted, add it to the Policy admission list.' } },
  ],
  health: ['web'],
  // A person's direct message always addresses the agent, so every web Trigger is listened to.
  scope: () => ({ listened: true, observed: false }),
  channel,
  environment: {
    variables: [],
    values: () => ({}),
  },
  facts: (): Record<string, Localized | string> => ({}),
}

export const name = 'dsh-superagent-web'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => (ctx.orchestrator.sources as SourceRegistry).register(webKind), 'web: source kind')
  // The web chat Source has no polling loop; the chat endpoint feeds Triggers and the panel reads the log. Keep its health ready.
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, webKind)
    source.report('web', { state: 'ready', detail: 'Listening for panel chat', at: new Date().toISOString() })
    return () => {}
  })
}
