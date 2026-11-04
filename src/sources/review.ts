import type { Ticket } from '../core/index.ts'

export function reviewOf(ticket: Pick<Ticket, 'follows'>): { source: 'github' | 'codebase'; number: number } | undefined {
  const follows = (ticket.follows ?? []).filter(item => /^(github|codebase):(?:[^:]+:)?\d+$/.test(item.thread))
  const follow = follows.filter(item => !item.closed).at(-1) ?? follows.at(-1)
  const match = follow && /^(github|codebase):(?:[^:]+:)?(\d+)$/.exec(follow.thread)
  return match ? { source: match[1] as 'github' | 'codebase', number: Number(match[2]) } : undefined
}
