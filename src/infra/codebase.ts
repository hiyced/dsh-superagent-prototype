import { z } from 'zod'

export const CodebaseAccountsSchema = z.object({
  repository: z.string().trim().regex(/^(?:[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)?$/).default(''),
  cli: z.string().trim().default(''),
  site: z.string().trim().regex(/^(?:[a-z][a-z0-9-]*)?$/).default(''),
  profile: z.string().trim().default(''),
  host: z.enum(['code.byted.org', 'code-tx.byted.org']).default('code.byted.org'),
  sshKey: z.string().trim().default(''),
  commitEmail: z.union([z.email(), z.literal('')]).default(''),
})
export type CodebaseAccounts = z.infer<typeof CodebaseAccountsSchema>

export function codebaseArgs(account: Pick<CodebaseAccounts, 'site' | 'profile'>, args: readonly string[]): string[] {
  return ['--no-auto-upgrade', '--json', '--site', account.site,
    ...account.profile ? ['--profile', account.profile] : [], 'codebase', ...args]
}

export function codebaseData(text: string): unknown {
  const result = z.object({ status: z.literal('success'), data: z.unknown() }).parse(JSON.parse(text))
  return result.data
}

export function codebasePage(account: Pick<CodebaseAccounts, 'repository' | 'host'>, number: number): string {
  return `https://${account.host}/${account.repository}/merge_requests/${number}`
}

export function codebaseTime(value: string | number): string {
  const numeric = typeof value === 'number' || /^\d+$/.test(value) ? Number(value) : undefined
  const time = numeric === undefined ? Date.parse(String(value)) : numeric < 1e12 ? numeric * 1000 : numeric
  if (!Number.isFinite(time)) throw new Error('Codebase returned an invalid timestamp')
  return new Date(time).toISOString()
}
