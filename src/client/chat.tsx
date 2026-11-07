/** The panel chat page: a plain conversation with the agent, backed by the `web` Source's chat log. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { usePanel } from './provider.tsx'

/** The browser-side conversation id, kept in localStorage so reopening the chat continues the same conversation. */
const CONV_KEY = 'dsh-superagent/chat-conversation'
function conversationId(): string {
  try {
    const stored = localStorage.getItem(CONV_KEY)
    if (stored) return stored
    const fresh = `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    localStorage.setItem(CONV_KEY, fresh)
    return fresh
  } catch { return `chat-${Math.random().toString(36).slice(2, 10)}` }
}

interface ChatMessage { id: string; role: 'person' | 'agent' | 'notice'; text: string; at: string }

export function ChatPanel() {
  const { t, call, notify } = usePanel()
  const conversation = useMemo(conversationId, [])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const log = usePoll(() => call('GET chat/log', { query: { conversation } }), [conversation], 3000)
  const messages = (log.data?.messages ?? []) as ChatMessage[]
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages.length])

  const send = async () => {
    const body = text.trim()
    if (!body || sending) return
    setSending(true)
    try {
      const messageId = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      await call('POST chat/send', { body: { conversation, messageId, text: body } })
      setText('')
      await log.reload()
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : String(failure))
    } finally { setSending(false) }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter inserts a newline; Command+Enter (⌘↵ on macOS, Ctrl+Enter elsewhere) sends, so a stray Enter never submits a
    // half-typed message — especially while toggling an input method.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send() }
  }

  return <div className="sa-chat" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
    <div className="dt-block-title" style={{ padding: '12px 16px', borderBottom: '1px solid var(--dt-color-border, #e5e7eb)' }}>
      {t('chatTitle')}
    </div>
    <div className="sa-chat-log" style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {messages.length === 0 && <div style={{ color: 'var(--dt-color-text-secondary, #6b7280)', fontSize: 13 }}>{t('chatEmpty')}</div>}
      {messages.map(message => <div key={message.id} style={{ display: 'flex', justifyContent: message.role === 'person' ? 'flex-end' : 'flex-start' }}>
        <div style={{ maxWidth: '78%', padding: '8px 12px', borderRadius: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 14,
          background: message.role === 'person' ? 'var(--dt-color-accent, #2563eb)' : 'var(--dt-color-fill, #f3f4f6)',
          color: message.role === 'person' ? '#fff' : 'inherit', opacity: message.role === 'notice' ? 0.75 : 1 }}>
          {message.text}
        </div>
      </div>)}
      <div ref={endRef} />
    </div>
    <div className="sa-chat-input" style={{ display: 'flex', gap: 8, alignItems: 'flex-end', padding: '12px 16px', borderTop: '1px solid var(--dt-color-border, #e5e7eb)' }}>
      <textarea className="dt-textarea" rows={2} value={text} placeholder={t('chatPlaceholder')} spellCheck={false}
        style={{ flex: 1, resize: 'none' }} onChange={event => setText(event.target.value)} onKeyDown={onKeyDown} />
      <Button variant="primary" size="md" onClick={() => void send()} disabled={sending || !text.trim()}>{t('chatSend')}</Button>
    </div>
  </div>
}
