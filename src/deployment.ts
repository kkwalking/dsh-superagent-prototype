/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/**
 * The Telegram Source names where its bot token lives, never the token itself: the settings store and the management
 * API return a Source's config verbatim, so a token kept here would be written to the database in clear text and
 * served to every panel reader. `tokenEnv` names an environment variable `~/.dsh/.env` already provides; `apiBase` is
 * for a local stand-in in tests.
 */
export const TelegramBotSchema = z.object({
  tokenEnv: z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/, 'An environment variable name').default(''),
  apiBase: z.string().trim().url().default('https://api.telegram.org'),
}).strict()
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: Object.keys(GithubAccountsSchema.shape), feishu: Object.keys(FeishuBotSchema.shape),
  telegram: Object.keys(TelegramBotSchema.shape) }

export interface Deployment extends Machine {
  /** The primary GitHub repository (owner/name), or empty when no GitHub Source is configured. Kept for the GitHub Source. */
  repository: string
  /**
   * The agent's GitHub identity, verified from the configured CLI. Absent when no GitHub Source is configured, in which
   * case the GitHub Source stays off and workspaces are plain directories prepared however the operator's `prepare`
   * command chooses (local, Gitee, GitLab, a bare repo, or nothing at all).
   */
  github?: { cli: string; login: string; noreply: string }
  feishu?: FeishuBot
  telegram?: TelegramBot
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }
/** The agent's Telegram identity, resolved from the token `resolveTelegramBot` read out of the environment. */
export interface TelegramBot { apiBase: string; id: number; username: string; name: string }

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/**
 * Resolve the GitHub identity when a repository is configured. A GitHub Source is optional: with no repository configured
 * this returns `{ repository: '', github: undefined }` so the rest of dsh-superagent (workspaces, Feishu, Telegram, chat)
 * runs without any Git hosting. With a repository it verifies the agent CLI's account can push, as before.
 */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  // No GitHub Source: valid deployment, GitHub stays off. Nothing else needs Git hosting.
  if (!remote) return { ...machine, repository: '' }
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return { ...machine, repository, github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}

/** The `getMe` answer: the bot's identity, which decides which mentions address it and which message to reply to. */
const TelegramMe = z.object({ id: z.number().int(), is_bot: z.literal(true), first_name: z.string(), username: z.string() })
/**
 * Verify the Telegram bot token the configured environment variable holds, and return the bot's identity.
 *
 * The token is read from the environment on every setup run rather than stored, so a rotated token takes effect
 * without writing it anywhere. A missing variable or a token Telegram rejects is a setup problem the operator fixes in
 * `~/.dsh/.env`, not in the panel.
 */
export async function resolveTelegramBot(telegram: unknown): Promise<TelegramBot | undefined> {
  // The caller passes the Source's whole config, which carries fields this check does not read (chats, poll
  // settings); only the token variable and the API base matter here, so the strict schema must not reject the rest.
  const raw = (telegram ?? {}) as { tokenEnv?: unknown; apiBase?: unknown }
  // An empty token variable means "not configured yet", not a malformed value: the check is skipped, exactly as an
  // unset Feishu CLI is, so the Source simply stays out until an operator names the variable.
  if (typeof raw.tokenEnv !== 'string' || raw.tokenEnv.trim() === '') return undefined
  const { tokenEnv, apiBase } = TelegramBotSchema.parse({ tokenEnv: raw.tokenEnv.trim(), ...raw.apiBase !== undefined ? { apiBase: raw.apiBase } : {} })
  const token = process.env[tokenEnv]?.trim()
  if (!token) throw new SetupError('telegramTokenUnset', { variable: tokenEnv })
  const deadline = AbortSignal.timeout(15_000)
  let answer: Response
  try { answer = await fetch(`${apiBase}/bot${token}/getMe`, { signal: deadline }) }
  catch (error) { throw new SetupError('telegramUnreachable', { output: reason(error) }) }
  const body = await answer.json().catch(() => undefined) as { ok?: boolean; result?: unknown; description?: string } | undefined
  if (!body?.ok) throw new SetupError('telegramTokenRejected', { output: body?.description ?? `HTTP ${answer.status}` })
  const me = TelegramMe.safeParse(body.result)
  if (!me.success) throw new SetupError('telegramNoBot', { output: JSON.stringify(body.result).slice(0, 200) })
  return { apiBase, id: me.data.id, username: me.data.username, name: me.data.first_name }
}
