import { key, liveTicket, type OutboundMessage, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { codebasePage } from '../infra/codebase.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { mergeRequestBranch, mergeRequestRepository, type MergeRequest } from './codebase-read.ts'

export const codebaseThread = (repositoryId: string, number: number) => `${repositoryId}:${number}`
export function mergeRequestsOf(ticket: Pick<Ticket, 'follows'>, repositoryId: string, open = false): number[] {
  const prefix = `codebase:${repositoryId}:`
  return (ticket.follows ?? []).filter(follow => (!open || !follow.closed) && follow.thread.startsWith(prefix))
    .flatMap(follow => /^\d+$/.test(follow.thread.slice(prefix.length)) ? Number(follow.thread.slice(prefix.length)) : [])
}

export function claimMergeRequest(ctx: SourceContext, ticketId: string, request: MergeRequest): string | undefined {
  const account = ctx.deployment.codebase
  if (!account) return 'Codebase is not configured'
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket has ended'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === 'codebase' && source.meta.repositoryId === account.repositoryId && source.meta.number === request.Number
  const opened = sameName(request.CreatedBy.Username, account.login) && mergeRequestRepository(request) === account.repositoryId
    && !!ticket.execution?.name && mergeRequestBranch(request).split('/').at(-1) === ticket.execution.name
  if (!started && !opened) return 'MR does not belong to this ticket: use its source MR or the agent account and ticket branch'
  if (request.Status !== 'open') return 'Only an open MR can be associated with a ticket'
  const owner = ctx.tickets.open().find(item => mergeRequestsOf(item, account.repositoryId, true).includes(request.Number))
  if (owner && owner.id !== ticketId) return 'MR already belongs to another active ticket'
  ctx.tickets.bindThread(ticketId, { source: 'codebase', id: codebaseThread(account.repositoryId, request.Number) }, opened)
  ctx.threads.patch(`codebase:${codebaseThread(account.repositoryId, request.Number)}`,
    { number: request.Number, repositoryId: account.repositoryId, repository: account.repository, url: codebasePage(account, request.Number),
      startedAt: ctx.threads.get(`codebase:${codebaseThread(account.repositoryId, request.Number)}`)?.meta.startedAt ?? ticket.createdAt })
  ctx.threads.describe(`codebase:${codebaseThread(account.repositoryId, request.Number)}`,
    { label: `!${request.Number} ${request.Title}`, url: codebasePage(account, request.Number) })
  return undefined
}

export function observeMergeRequest(ctx: SourceContext, request: MergeRequest): void {
  const account = ctx.deployment.codebase
  if (!account) return
  if (request.Status === 'open') {
    const thread = { source: 'codebase', id: codebaseThread(account.repositoryId, request.Number) }
    for (const ticket of ctx.tickets.open()) {
      const follow = ticket.follows?.find(item => item.thread === `codebase:${thread.id}`)
      if (follow?.closed) ctx.tickets.bindThread(ticket.id, thread, follow.own)
    }
    return
  }
  ctx.tickets.threadClosed({ source: 'codebase', id: codebaseThread(account.repositoryId, request.Number) },
    request.Status === 'merged' ? 'merged' : 'closed', request.MergedAt ?? request.ClosedAt ?? request.UpdatedAt ?? new Date().toISOString())
}

export function mergeRequestEndNotices(ticket: Ticket, request: string, deployment: Deployment): OutboundMessage[] {
  const account = deployment.codebase, outcome = ticket.ended?.outcome
  if (!account || (outcome !== 'merged' && outcome !== 'closed')) return []
  const prefix = `codebase:${account.repositoryId}:`
  const follows = (ticket.follows ?? []).filter(follow => follow.closed && follow.thread.startsWith(prefix))
  const latest = (own: boolean) => follows.filter(follow => !own || follow.own).sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(true) ?? latest(false)
  if (!follow) return []
  const number = Number(follow.thread.slice(prefix.length)), url = codebasePage(account, number)
  const chinese = /\p{Script=Han}/u.test(request)
  const text = chinese ? `[MR !${number}](${url}) ${outcome === 'merged' ? '已合并。' : '已关闭，未合并。'}`
    : `[MR !${number}](${url}) ${outcome === 'merged' ? 'has merged.' : 'was closed without merging.'}`
  return ticket.channels.filter(channel => channel.source !== 'codebase').map(channel => ({
    id: key('mr-terminal', account.repositoryId, String(number), JSON.stringify(channel), outcome), channel, text, kind: 'notice', ticketId: ticket.id,
  }))
}
