/**
 * The web chat Source's conversation log: reading and appending the person and agent turns the panel shows.
 *
 * A log is a bounded ring of the latest messages in one conversation, keyed in KV. It is written by the chat endpoint
 * (a person's turn) and by the Channel's `send` (the agent's reply), and read by the panel's chat page. Keeping it in KV
 * rather than only in the Engine means the panel can show a plain conversation even before an assessment or ticket exists.
 */
import { KV } from '../kv.ts'
import type { SourceContext } from './host.ts'
import type { WebChatMessage } from './web-trigger.ts'

/** Newest messages kept per conversation; older turns scroll out so one chat cannot grow the database without bound. */
export const CHAT_LOG_LIMIT = 500

/** The stored messages of `conversation`, oldest first. */
export function readChat(state: Pick<SourceContext, 'state'>, conversation: string): WebChatMessage[] {
  return state.state.get(KV.web.messages(conversation)) ?? []
}

/** Appends one message to `conversation`'s log, trimming to the newest `CHAT_LOG_LIMIT`, and returns the new log. */
export function appendChat(state: Pick<SourceContext, 'state'>, conversation: string, message: WebChatMessage): WebChatMessage[] {
  const log = [...readChat(state, conversation), message].slice(-CHAT_LOG_LIMIT)
  state.state.set(KV.web.messages(conversation), log)
  return log
}
