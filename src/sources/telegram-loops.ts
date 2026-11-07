/**
 * The Telegram Source's polling loop: a long poll over `getUpdates`, advancing an offset cursor in KV so a restart
 * resumes exactly where the previous process stopped.
 *
 * Telegram delivers each update exactly once to whoever reads it with the offset, so the cursor is the Source's
 * durability boundary. It is advanced only after every update of the batch has been handed to the Engine, so a crash
 * mid-batch re-reads that batch; `receive` deduplicates by Trigger id, which makes the re-read harmless.
 */
import { KV } from '../kv.ts'
import { setTimeout as delay } from 'node:timers/promises'
import type { SourceContext } from './host.ts'
import { health } from './host.ts'
import { getChat, getMe, getUpdates, TELEGRAM_API, TelegramError } from './telegram-api.ts'
import { telegramTrigger, type TelegramMessage, type TelegramUpdate } from './telegram-trigger.ts'

/** A long poll holds the connection this long when nothing arrives; Telegram caps it at 50 seconds. */
const POLL_SECONDS = 25
/** How many updates one batch may carry before the loop yields to the next round. */
const BATCH = 100


/** The message a `getUpdates` entry carries, or `undefined` for an update kind the Source does not ingest. */
const messageOf = (update: TelegramUpdate): TelegramMessage | undefined =>
  update.message ?? update.channel_post

/**
 * Polls Telegram until `signal` aborts. One failed round is retried with the backoff Telegram asks for; three in a row
 * report an error, which keeps a transient network failure from paging the operator.
 *
 * The Source reports one health entry per outcome because a person reading the panel needs to tell "Telegram is down"
 * from "no messages have arrived".
 */
export async function runTelegram(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  // Telegram does not depend on GitHub setup: the bot resolves itself from its own token, so a Source with only a
  // Telegram bot works while the GitHub deployment is still unconfigured.
  await ctx.ready
  let failures = 0
  let retry = 1000
  while (!signal.aborted) {
    const config = ctx.config<{ tokenEnv: string; apiBase?: string }>('telegram')
    const token = config?.tokenEnv ? process.env[config.tokenEnv]?.trim() : undefined
    if (!token) {
      ctx.report('telegram', health('error', 'telegramTokenUnset', { variable: config?.tokenEnv ?? '' }))
      await delay(30_000, undefined, { signal }).catch(() => {})
      continue
    }
    try {
      const apiBase = config?.apiBase ?? TELEGRAM_API
      const bot = await resolveBot(ctx, apiBase, token, signal)
      const offset = ctx.state.get(KV.telegram.offset)
      const { updates, next } = await getUpdates(apiBase, token, offset, POLL_SECONDS, signal)
      let received = 0
      for (const update of updates) {
        const message = messageOf(update)
        if (!message) continue
        const trigger = telegramTrigger(message, bot)
        // Events from a bot, or posted on behalf of a chat, are read but never ingested.
        if (!trigger) continue
        if (!enabled(ctx)) break
        await ctx.receive(trigger)
        received += 1
        await describeChat(ctx, token, apiBase, trigger.meta.chatId as string, trigger.meta.chatTitle as string | undefined, signal)
      }
      // The cursor moves only after the whole batch reached the Engine, so a crash re-reads it instead of losing it.
      if (next > (offset ?? 0)) ctx.state.set(KV.telegram.offset, next)
      if (received > 0) ctx.report('telegram', health('ready', 'telegramReceived', { count: String(received) }))
      else if (failures === 0) ctx.report('telegram', health('ready', 'telegramListening'))
      failures = 0
      retry = 1000
      // A batch that filled the limit means more updates are waiting; do not hold for the long poll.
      if (updates.length >= BATCH) continue
    } catch (error) {
      if (signal.aborted) break
      // A round that ends because the long poll timed out on our side is not a failure.
      if (error instanceof TelegramError && error.code === 0 && /aborted|timeout/i.test(error.message) && !ctx.configured()) break
      failures += 1
      const asked = error instanceof TelegramError ? error.retryAfter : undefined
      retry = asked ? asked * 1000 : Math.min(retry * 2, 60_000)
      if (failures >= 3) ctx.report('telegram', health('error', 'telegramUnavailable', { output: error instanceof Error ? error.message : String(error) }))
      await delay(retry, undefined, { signal }).catch(() => {})
    }
  }
}

/** Records a chat's title once per process so the panel shows `Product team` instead of a numeric id. */
async function describeChat(ctx: SourceContext, token: string, base: string, chatId: string, title: string | undefined, signal: AbortSignal): Promise<void> {
  const known = ctx.state.get(KV.telegram.chats) ?? {}
  if (chatId in known) return
  const resolved = title ?? (await getChat(base, token, chatId, signal).then(chat => chat?.title).catch(() => undefined))
  // Record even an unresolved chat so a gone one is not asked again every round.
  ctx.state.set(KV.telegram.chats, { ...known, [chatId]: resolved ?? '' })
}

/** True while the Source is switched on; a switched-off Source stops ingesting and lets the cursor stay put. */
const enabled = (ctx: SourceContext): boolean => Boolean(ctx.config('telegram'))

/** Reads the chat labels this Source resolved, for the panel's Thread names. */
export const chatLabels = (ctx: SourceContext): Record<string, string> =>
  Object.fromEntries(Object.entries(ctx.state.get(KV.telegram.chats) ?? {}).filter(([, name]) => name !== '') as [string, string][])

/** The bot identity resolved once and cached, so a poll round does not call `getMe` again. */
async function resolveBot(ctx: SourceContext, apiBase: string, token: string, signal: AbortSignal):
Promise<{ id: number; username: string }> {
  const cached = ctx.state.get(KV.telegram.bot)
  if (cached) return cached
  const me = await getMe(apiBase, token, signal)
  ctx.state.set(KV.telegram.bot, { id: me.id, username: me.username, name: me.first_name })
  return { id: me.id, username: me.username }
}
