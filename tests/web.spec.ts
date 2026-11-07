import { describe, expect, it } from 'vitest'
import { webChannel, webTrigger, webTriggerId, webThreadId } from '../src/sources/web-trigger.ts'
import { appendChat, CHAT_LOG_LIMIT, readChat } from '../src/sources/web-store.ts'
import { sendWeb, webKind } from '../src/sources/web.ts'
import { KV } from '../src/kv.ts'

/** A SourceContext stand-in carrying only the KV `state` the web Source reads and writes. */
function stateful(initial: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(initial))
  const state = {
    get: <V>(key: string): V | undefined => map.get(key) as V | undefined,
    set: <V>(key: string, value: V | undefined): void => { value === undefined ? map.delete(key) : map.set(key, value) },
    keys: (): string[] => [],
  }
  return { state } as unknown as Pick<import('../src/sources/host.ts').SourceContext, 'state'>
}

describe('web Trigger mapping', () => {
  it('maps a person\'s chat message to a direct, human Trigger on the conversation Thread with a reply channel', () => {
    const trigger = webTrigger({ conversation: 'conv-1', messageId: 'm1', text: 'fix the bug', actor: 'alice', at: '2026-01-01T00:00:00.000Z' })
    expect(trigger).toMatchObject({ source: 'web', human: true, addressed: 'direct', text: 'fix the bug', at: '2026-01-01T00:00:00.000Z' })
    expect(trigger.actor).toEqual({ source: 'web', id: 'alice' })
    expect(trigger.threads).toEqual([{ source: 'web', id: 'conv-1' }])
    expect(trigger.channel).toEqual({ source: 'web', thread: 'conv-1', address: { conversation: 'conv-1' } })
    expect(trigger.id).toBe(webTriggerId('conv-1', 'm1'))
  })

  it('names a Thread by the conversation and a distinct Trigger per message', () => {
    expect(webThreadId('c')).toBe('c')
    expect(webTriggerId('c', 'a')).not.toBe(webTriggerId('c', 'b'))
    expect(webChannel('c')).toEqual({ source: 'web', thread: 'c', address: { conversation: 'c' } })
  })
})

describe('web chat log', () => {
  it('appends person and agent turns oldest first and reads them back', () => {
    const host = stateful()
    appendChat(host, 'c', { id: '1', role: 'person', text: 'hi', at: 't1' })
    appendChat(host, 'c', { id: '2', role: 'agent', text: 'hello', at: 't2' })
    expect(readChat(host, 'c').map(m => [m.role, m.text])).toEqual([['person', 'hi'], ['agent', 'hello']])
    // Conversations are independent.
    expect(readChat(host, 'other')).toEqual([])
  })

  it('keeps only the newest messages bounded per conversation', () => {
    const host = stateful()
    for (let i = 0; i < CHAT_LOG_LIMIT + 25; i++) appendChat(host, 'c', { id: `m${i}`, role: 'person', text: String(i), at: 't' })
    const log = readChat(host, 'c')
    expect(log).toHaveLength(CHAT_LOG_LIMIT)
    expect(log.at(-1)!.text).toBe(String(CHAT_LOG_LIMIT + 24))
    expect(log[0]!.text).toBe(String(25))
  })

  it('records the agent\'s reply through the Channel into the conversation log', async () => {
    const host = stateful()
    const result = await sendWeb(host, { id: 'reply-1', kind: 'reply', text: 'Done', channel: webChannel('c') })
    expect(result).toBe('sent')
    const log = readChat(host, 'c')
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ role: 'agent', text: 'Done' })
    // The stored id derives from the outbound message id, so a repeated send of the same message is a distinct entry (dedup is the Outbox's job).
    expect(log[0]!.id).toBeTruthy()
  })

  it('drops a reply whose address names no conversation', async () => {
    const host = stateful()
    const result = await sendWeb(host, { id: 'x', kind: 'reply', text: 'nope', channel: { source: 'web', thread: 'c', address: {} } })
    expect(result).toBe('gone')
  })
})

describe('web Source kind', () => {
  it('declares a trimmed actor default and listens to every direct message', () => {
    expect(webKind.schema.parse({}).actor).toBe('operator')
    expect(webKind.scope?.({ meta: {} }, webKind.schema.parse({}))).toEqual({ listened: true, observed: false })
    expect(webKind.health).toEqual(['web'])
    expect(webKind.kind).toBe('web')
    // The web Source contributes no environment variables and needs no git.
    expect(webKind.environment?.variables).toEqual([])
  })

  it('reads a stored chat log through its KV key', () => {
    const log = [{ id: '1', role: 'person', text: 'hi', at: 't' }]
    const host = stateful({ [KV.web.messages('c')]: log })
    expect(readChat(host, 'c')).toEqual(log)
  })
})
