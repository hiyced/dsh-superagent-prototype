import { z } from 'zod'
import { codebasePage, codebaseTime } from '../infra/codebase.ts'
import type { Commands } from '../infra/commands.ts'
import type { ContextMessage } from './kind.ts'

export const CodebaseId = z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String)
const Time = z.union([z.string(), z.number()]).transform(codebaseTime)
const User = z.object({ Username: z.string().min(1), IsBot: z.boolean().optional() })
export const MergeRequestSchema = z.object({
  Number: z.number().int().positive(), Title: z.string(), Description: z.string().nullish(),
  Status: z.enum(['open', 'merged', 'closed']), CreatedBy: User,
  SourceBranchName: z.string().optional(), SourceBranch: z.object({ Name: z.string() }).nullish(),
  SourceRepoId: CodebaseId.optional(), SourceRepository: z.object({ Id: CodebaseId }).nullish(),
  TargetRepoId: CodebaseId.optional(), CreatedAt: Time.optional(), UpdatedAt: Time.optional(),
  MergedAt: Time.nullish(), ClosedAt: Time.nullish(),
})
export type MergeRequest = z.infer<typeof MergeRequestSchema>
export const mergeRequestBranch = (request: MergeRequest) => request.SourceBranchName ?? request.SourceBranch?.Name ?? ''
export const mergeRequestRepository = (request: MergeRequest) => request.SourceRepoId ?? request.SourceRepository?.Id

export async function readMergeRequest(commands: Commands, number: number): Promise<MergeRequest> {
  const account = commands.deployment.codebase
  if (!account) throw new Error('Codebase is not configured')
  const value = z.object({ repository: z.object({ id: CodebaseId }), merge_request: MergeRequestSchema })
    .parse(await commands.codebase(['mr', 'get', String(number), '-R', account.repository]))
  if (value.repository.id !== account.repositoryId || value.merge_request.Number !== number
    || (value.merge_request.TargetRepoId && value.merge_request.TargetRepoId !== account.repositoryId)) {
    throw new Error('Codebase returned a merge request from another repository')
  }
  return value.merge_request
}

const CommentSchema = z.object({ Id: CodebaseId, Content: z.string(), CreatedBy: User,
  CreatedAt: Time, UpdatedAt: Time.optional() })
const ReviewNoteSchema = z.object({ Id: CodebaseId, Content: z.string(), Author: User,
  CreatedAt: Time, UpdatedAt: Time.optional() })
export interface CodebaseMessage extends ContextMessage { bot?: true }
export async function readCodebaseMessages(commands: Commands, number: number): Promise<CodebaseMessage[]> {
  const account = commands.deployment.codebase
  if (!account) throw new Error('Codebase is not configured')
  const value = z.object({ repository: z.object({ id: CodebaseId }),
    threads: z.array(z.object({ Comments: z.array(CommentSchema).nullish() })),
    review_notes: z.array(ReviewNoteSchema).optional() })
    .parse(await commands.codebase(['mr', 'comment', 'list', String(number), '-R', account.repository]))
  if (value.repository.id !== account.repositoryId) throw new Error('Codebase returned comments from another repository')
  const url = codebasePage(account, number)
  return [
    ...value.threads.flatMap(thread => (thread.Comments ?? []).map(comment => ({
      id: `comment:${comment.Id}`, from: comment.CreatedBy.Username, at: comment.UpdatedAt ?? comment.CreatedAt,
      text: comment.Content, url: `${url}#comment_${comment.Id}`, ...comment.CreatedBy.IsBot ? { bot: true as const } : {},
    }))),
    ...(value.review_notes ?? []).map(note => ({ id: `review:${note.Id}`, from: note.Author.Username,
      at: note.UpdatedAt ?? note.CreatedAt, text: note.Content, url, ...note.Author.IsBot ? { bot: true as const } : {} })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
}
