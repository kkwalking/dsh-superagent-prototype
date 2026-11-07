/**
 * The web chat Source's Trigger mapping and Thread id scheme.
 *
 * A conversation is one panel chat, named by an opaque id the client keeps. A person's message in it becomes a Trigger on
 * that conversation's Thread, exactly as a Telegram chat's message does, so the whole Eval → Ticket → reply pipeline runs
 * unchanged. This Source needs no git or hosting: a workspace is just a directory (see the executor workspaces).
 */
import { key } from '../core/ids.ts'
import type { ChannelRef, Trigger } from '../core/model.ts'

export const SOURCE = 'web'

/** One stored chat message: a person's turn or the agent's reply, oldest first within a conversation. */
export interface WebChatMessage {
  id: string
  /** `person` for the operator's message, `agent` for the agent's reply, `notice` for a status line. */
  role: 'person' | 'agent' | 'notice'
  text: string
  at: string
}

/** The Thread id of a conversation: its opaque id, so Triggers in one chat stay together and apart from other chats. */
export const webThreadId = (conversation: string): string => conversation

/** The Trigger id of one person's message: the conversation plus the client-supplied message id name it on its own. */
export const webTriggerId = (conversation: string, messageId: string): string => key('web', conversation, messageId)

/** The ChannelRef a reply to this conversation goes to. */
export const webChannel = (conversation: string): ChannelRef => ({ source: SOURCE, thread: webThreadId(conversation), address: { conversation } })

/**
 * Maps one person's message in a chat onto a Trigger. The message is a direct request to the agent (the operator typed it
 * into the agent's own panel), so it is `human` and `addressed: 'direct'`.
 */
export function webTrigger(input: { conversation: string; messageId: string; text: string; actor: string; at?: string }): Trigger {
  const at = input.at ?? new Date().toISOString()
  return {
    id: webTriggerId(input.conversation, input.messageId),
    source: SOURCE,
    threads: [{ source: SOURCE, id: webThreadId(input.conversation) }],
    actor: { source: SOURCE, id: input.actor },
    human: true,
    addressed: 'direct',
    at,
    text: input.text,
    channel: webChannel(input.conversation),
    meta: { conversation: input.conversation, messageId: input.messageId },
  }
}
