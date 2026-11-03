import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import { CodebaseAccountsSchema, codebasePage } from '../infra/codebase.ts'
import { CliError } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { pause, pollThreads } from './poll.ts'
import { readCodebaseMessages, readMergeRequest, type CodebaseMessage } from './codebase-read.ts'
import { claimMergeRequest, codebaseThread, mergeRequestEndNotices, observeMergeRequest } from './codebase-review.ts'

export const CodebaseConfigSchema = CodebaseAccountsSchema.extend({
  pollSeconds: z.number().int().min(30).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  botAccounts: z.array(z.object({ id: z.string().min(1) })).default([]),
}).strict()
export type CodebaseConfig = z.infer<typeof CodebaseConfigSchema>

export function codebaseTrigger(ctx: SourceContext, number: number, message: CodebaseMessage): Trigger | undefined {
  const account = ctx.deployment.codebase
  if (!account || sameName(message.from, account.login)) return undefined
  const config = ctx.config<CodebaseConfig>('codebase')
  const bot = message.bot || config?.botAccounts.some(actor => sameName(actor.id, message.from))
  const id = codebaseThread(account.repositoryId, number)
  const escaped = account.login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const addressed = new RegExp(`(?:^|[^\\w@])@${escaped}(?![\\w.-])`, 'i').test(message.text)
  return { id: key('codebase-message', account.repositoryId, String(number), message.id, message.at), source: 'codebase',
    threads: [{ source: 'codebase', id }], actor: { source: 'codebase', id: message.from }, human: !bot,
    at: message.at, text: message.text, ...addressed ? { addressed: 'mention' as const } : {},
    channel: { source: 'codebase', thread: `codebase:${id}`, address: { number: String(number), repository: account.repository, url: codebasePage(account, number) } },
    url: message.url ?? codebasePage(account, number),
    meta: { number, repositoryId: account.repositoryId, repository: account.repository, messageId: message.id, kind: 'comment' } }
}

export async function sendCodebase(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host, account = commands.deployment.codebase
  const number = Number(message.channel.address.number)
  if (!account || !Number.isSafeInteger(number) || number <= 0 || !sameName(message.channel.address.repository ?? '', account.repository)) {
    throw new Error('Invalid Codebase reply target')
  }
  const marker = `<!-- dsh-superagent:${message.id} -->`
  try {
    const comments = await readCodebaseMessages(commands, number)
    if (comments.some(comment => sameName(comment.from, account.login) && comment.text.includes(marker))) return 'sent'
    await commands.codebase(['mr', 'comment', 'create', String(number), '-R', account.repository, '--body', `${message.text}\n\n${marker}`])
    return 'sent'
  } catch (error) { if (error instanceof CliError && error.code === 410) return 'gone'; throw error }
}

const field = (key: string, zh: string, en: string) => ({ key, type: 'text' as const, label: { zh, en } })
export const codebaseKind: SourceKind<CodebaseConfig> = {
  kind: 'codebase', title: { zh: 'Codebase', en: 'Codebase' },
  description: { zh: '通过 bytedcli 跟进工单关联的 MR、评审评论及合并关闭状态；可从飞书发起任务。',
    en: 'Use bytedcli to follow ticket MRs, review comments, and merge/close outcomes. Start work from Feishu.' },
  schema: CodebaseConfigSchema,
  fields: [field('repository', '仓库路径', 'Repository path'), field('cli', '智能体 bytedcli', 'Agent bytedcli'),
    field('site', '站点', 'Site'), field('profile', '独立登录配置', 'Auth profile'),
    { key: 'host', type: 'select', label: { zh: '代码站点', en: 'Code host' }, options: [
      { value: 'code.byted.org', label: { zh: 'code.byted.org', en: 'code.byted.org' } },
      { value: 'code-tx.byted.org', label: { zh: 'code-tx.byted.org', en: 'code-tx.byted.org' } }] },
    field('sshKey', '智能体 SSH 私钥绝对路径', 'Agent SSH private-key path'), field('commitEmail', '提交邮箱', 'Commit email'),
    { key: 'pollSeconds', type: 'number', min: 30, max: 3600, advanced: true, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', min: 1, max: 20, advanced: true, label: { zh: '连续失败阈值', en: 'Consecutive failure threshold' } },
    { key: 'botAccounts', type: 'rows', label: { zh: '自动评审账号', en: 'Automated reviewer accounts' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' } }] }],
  health: ['codebase'],
  scope: ({ meta }, config) => sameName(String(meta.repository ?? ''), config.repository)
    ? { listened: true, observed: false, row: 'reviews' } : { listened: false, reason: 'repository_mismatch' },
  channel: { send: sendCodebase,
    allowed: (address, config) => sameName(address.repository ?? '', config.repository),
    link: address => ({ url: address.url ?? '', label: { zh: `Codebase MR !${address.number}`, en: `Codebase MR !${address.number}` } }) },
  find: (query, deployment) => {
    const account = deployment?.codebase
    if (!account) return { threads: [], terms: [] }
    let number = /^!(\d+)$/.exec(query.trim())?.[1]
    if (!number) {
      try {
        const url = new URL(query.trim())
        const prefix = `/${account.repository}/merge_requests/`
        if (url.protocol === 'https:' && url.host === account.host && url.pathname.startsWith(prefix)) {
          number = /^(\d+)\/?$/.exec(url.pathname.slice(prefix.length))?.[1]
        }
      } catch { /* A search term need not be a URL. */ }
    }
    return { threads: number ? [`codebase:${codebaseThread(account.repositoryId, Number(number))}`] : [], terms: [] }
  },
  review: {
    prepare: async (host, ticketId, number, signal) => {
      const request = await readMergeRequest(host.commands.withSignal(signal), number)
      return () => claimMergeRequest(host, ticketId, request)
    }, endNotices: mergeRequestEndNotices,
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1) })).default([]),
      bots: z.array(z.object({ id: z.string().min(1) })).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '允许派活的 Codebase 账号', en: 'Allowed Codebase accounts' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' } }] }],
    explicit: { zh: '关联 MR 上允许名单中的账号 @ 智能体；已有任务的评审继续送给原任务。',
      en: 'An allowed account mentions the agent on a tracked MR; existing review feedback continues its ticket.' },
  },
  threadContext: {
    messageId: trigger => String(trigger.meta.messageId ?? ''),
    read: async (commands, trigger, part, cursor) => {
      const number = z.number().int().positive().parse(trigger.meta.number)
      const account = commands.deployment.codebase!
      const request = await readMergeRequest(commands, number)
      const root = { id: `mr:${number}`, from: request.CreatedBy.Username, at: request.CreatedAt ?? trigger.at,
        text: `${request.Title}\n\n${request.Description ?? ''}`, url: codebasePage(account, number) }
      if (part !== 'thread') return { messages: [root], body: { number } }
      const offset = cursor ? z.coerce.number().int().nonnegative().parse(cursor) : 0
      const messages = [root, ...await readCodebaseMessages(commands, number)]
      return { messages: messages.slice(offset, offset + 50), body: { number },
        ...offset + 50 < messages.length ? { next: String(offset + 50) } : {} }
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_CODEBASE_REPOSITORY', description: { zh: 'Codebase 仓库路径', en: 'Codebase repository path' } },
      { key: 'DSH_SUPERAGENT_CODEBASE_ACCOUNT', description: { zh: '智能体 Codebase 账号', en: 'Agent Codebase account' } },
      { key: 'DSH_SUPERAGENT_CODEBASE_COMMIT_EMAIL', description: { zh: '智能体提交邮箱', en: 'Agent commit email' } },
      { key: 'DSH_SUPERAGENT_CODEBASE_CLONE_URL', description: { zh: '用于 git fetch 的 SSH 地址', en: 'SSH clone URL for git fetch' } },
      { key: 'DSH_SUPERAGENT_CODEBASE_NUMBER', description: { zh: '来源 MR 编号；从飞书接单时为空', en: 'Origin MR number; empty for a Feishu request' } },
    ],
    values: ({ deployment, trigger }): Record<string, string> => {
      const account = deployment.codebase
      if (!account) return {}
      return { DSH_SUPERAGENT_CODEBASE_REPOSITORY: account.repository, DSH_SUPERAGENT_CODEBASE_ACCOUNT: account.login,
        DSH_SUPERAGENT_CODEBASE_COMMIT_EMAIL: account.commitEmail,
        DSH_SUPERAGENT_CODEBASE_CLONE_URL: `git@${account.host}:${account.repository}.git`,
        DSH_SUPERAGENT_CODEBASE_NUMBER: trigger?.source === 'codebase' ? String(trigger.meta.number ?? '') : '' }
    },
  },
  facts: (deployment): Record<string, string> => deployment?.codebase ? { cli: deployment.codebase.login, repository: deployment.codebase.repository } : {},
}

export async function pollCodebase(ctx: SourceContext, signal?: AbortSignal): Promise<void> {
  const account = ctx.deployment.codebase
  if (!account || !ctx.config('codebase')) return
  const commands = ctx.commands.withSignal(signal), failures: unknown[] = []
  await pollThreads(ctx, 'codebase', () => !!signal?.aborted || !ctx.config('codebase'), async thread => {
    try {
      if (thread.meta.repositoryId !== account.repositoryId) throw new Error('Tracked MR belongs to a different repository')
      const number = z.number().int().positive().parse(thread.meta.number)
      const request = await readMergeRequest(commands, number)
      for (const message of await readCodebaseMessages(commands, number)) {
        signal?.throwIfAborted()
        if (message.at < String(thread.meta.startedAt ?? thread.createdAt)) continue
        const trigger = codebaseTrigger(ctx, number, message)
        if (trigger) await ctx.receive(trigger)
      }
      observeMergeRequest(ctx, request)
    } catch (error) { failures.push(error); throw error }
  })
  if (failures.length) throw new Error(`${failures.length} Codebase MR reads failed: ${String(failures[0])}`)
}

export const name = 'dsh-superagent-codebase'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(codebaseKind), 'codebase: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, codebaseKind), controller = new AbortController()
    const running = watchCodebase(source, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) source.report('codebase', { state: 'error', detail: String(error) })
    })
    return async () => { controller.abort(); await running }
  })
}
async function watchCodebase(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report('codebase', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<CodebaseConfig>('codebase')
    try {
      if (config && ctx.deployment.codebase) {
        await pollCodebase(ctx, signal)
        ctx.report('codebase', { state: 'ready', detail: 'Following ticket merge requests' })
      } else ctx.report('codebase', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      if (++failures >= (config?.failuresBeforeError ?? 3)) ctx.report('codebase', { state: 'error', detail: String(error) })
    }
    await pause((config?.pollSeconds ?? 60) * 1000, signal)
  }
}
