import { describe, expect, it } from 'vitest'
import { SOURCE, readableText, telegramParent, telegramThreadId, telegramTrigger, telegramTriggerId } from '../src/sources/telegram-trigger.ts'

const bot = { id: 42, username: 'SuperAgentBot' }
const user = { id: 7, is_bot: false, first_name: 'Ada', last_name: 'Lovelace', username: 'ada' }
const at = 1_760_000_000

/** A message in `chat`, with `entities` describing the `@SuperAgentBot` mention when `mention` is set. */
function message(over: Partial<Parameters<typeof telegramTrigger>[0]> & { mention?: boolean } = {}) {
  const { mention, text: given, ...rest } = over
  const text = given ?? (mention ? 'fix the typo @SuperAgentBot' : 'fix the typo')
  const offset = text.indexOf(`@${bot.username}`)
  return { message_id: 100, date: at, chat: { id: -1001, type: 'supergroup' as const, title: 'Team' }, from: user, text,
    ...mention && offset >= 0 ? { entities: [{ type: 'mention', offset, length: bot.username.length + 1 }] } : {}, ...rest }
}

describe('readableText', () => {
  it('removes the bot mention and keeps the rest', () => {
    expect(readableText(message({ mention: true }), bot.username)).toBe('fix the typo')
  })

  it('falls back to an attachment caption when there is no text', () => {
    expect(readableText({ ...message({ text: '' }), caption: 'the screenshot' }, bot.username)).toBe('the screenshot')
  })

  it('leaves a mention of another bot in place', () => {
    const other = message({ text: 'ask @OtherBot about it' })
    expect(readableText(other, bot.username)).toBe('ask @OtherBot about it')
  })
})

describe('telegramTrigger', () => {
  it('maps a mentioned group message onto a Trigger on the chat', () => {
    const trigger = telegramTrigger(message({ mention: true }), bot)
    expect(trigger).toMatchObject({ source: SOURCE, id: telegramTriggerId('-1001', 100), addressed: 'mention', human: true,
      threads: [{ source: SOURCE, id: '-1001' }], actor: { source: SOURCE, id: '7' }, text: 'fix the typo' })
    expect(trigger?.at).toBe('2025-10-09T08:53:20.000Z')
  })

  it('keeps a forum topic apart, so two topics of one group carry unrelated work', () => {
    const trigger = telegramTrigger(message({ mention: true, message_thread_id: 9 }), bot)
    expect(trigger?.threads).toEqual([{ source: SOURCE, id: '-1001:9' }])
    expect(trigger?.channel?.address).toMatchObject({ chatId: '-1001', threadId: '9' })
  })

  it('treats a private message as addressed even without a mention, by direct message', () => {
    const trigger = telegramTrigger({ ...message({ text: 'fix the typo' }), chat: { id: 7, type: 'private' } }, bot)
    expect(trigger?.addressed).toBe('direct')
  })

  it('leaves a group message that mentions nobody unaddressed', () => {
    expect(telegramTrigger(message({ text: 'just chatting' }), bot)?.addressed).toBeUndefined()
  })

  it('names the Trigger before the agent, which Telegram leaves in the raw text', () => {
    const direct = telegramTrigger({ ...message({ mention: true }), chat: { id: 7, type: 'private' } }, bot)
    expect(direct?.addressed).toBe('mention')
    expect(direct?.text).toBe('fix the typo')
  })

  it('never ingests a message from another bot', () => {
    expect(telegramTrigger(message({ mention: true, from: { id: 9, is_bot: true, first_name: 'Helper' } }), bot)).toBeUndefined()
  })

  it('never ingests a message posted on behalf of a chat, which names no person', () => {
    expect(telegramTrigger(message({ mention: true, sender_chat: { id: -1001 } }), bot)).toBeUndefined()
  })

  it('never ingests a message forwarded from a channel, which carries no sender request', () => {
    expect(telegramTrigger(message({ mention: true, forward_origin: { type: 'channel', chat: {} } }), bot)).toBeUndefined()
  })

  it('never ingests a message with neither text nor caption', () => {
    expect(telegramTrigger({ ...message(), text: undefined }, bot)).toBeUndefined()
  })

  it('reads a reply as naming its parent Trigger', () => {
    const reply = telegramTrigger(message({ mention: true, reply_to_message: { message_id: 99 } }), bot)
    expect(reply).toBeDefined()
    expect(telegramParent(reply!)).toBe(telegramTriggerId('-1001', 99))
  })
})

describe('telegramThreadId', () => {
  it('is the chat alone without a topic, and `chat:topic` with one', () => {
    expect(telegramThreadId(-1001)).toBe('-1001')
    expect(telegramThreadId(-1001, 9)).toBe('-1001:9')
  })
})
