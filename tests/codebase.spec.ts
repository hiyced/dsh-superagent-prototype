/** Codebase CLI boundary and a Feishu → worker → MR → review → merge lifecycle. No internal service calls. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Runtime } from '../src/app/runtime.ts'
import { testMachine } from './fixtures/deployment.ts'
import { resolveCodebase, resolveRepository } from '../src/deployment.ts'
import { codebaseArgs, codebaseData, codebaseTime } from '../src/infra/codebase.ts'
import { agentVariables, codebaseSshCommand, workerBin, workerGitConfig } from '../src/infra/environment.ts'
import { Commands } from '../src/infra/commands.ts'
import { codebaseKind, codebaseTrigger, pollCodebase, sendCodebase } from '../src/sources/codebase.ts'
import { readCodebaseMessages, readMergeRequest, type MergeRequest } from '../src/sources/codebase-read.ts'
import { claimMergeRequest, mergeRequestEndNotices } from '../src/sources/codebase-review.ts'
import { reviewOf } from '../src/sources/review.ts'
import { sourceContext } from '../src/sources/host.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime(undefined, 'codebase') })
afterEach(async () => { await h.stop() })
const context = () => sourceContext(h.runtime, codebaseKind)
const account = () => h.runtime.deployment.codebase!
const envelope = (data: unknown) => JSON.stringify({ status: 'success', data })
const at = (seconds = 0) => new Date(Date.now() + seconds * 1000).toISOString()
function request(branch: string, overrides: Partial<MergeRequest> = {}): MergeRequest {
  return { Number: 7, Title: 'Repair regression', Status: 'open', CreatedBy: { Username: 'agent-bot' },
    SourceBranchName: `agent/${branch}`, SourceRepoId: '42', TargetRepoId: '42', ...overrides }
}
function messages(text = '@agent-bot please fix the test', from = 'alice', time = at()) {
  return { repository: { id: '42' }, threads: [{ Comments: [{ Id: 1, Content: text, CreatedBy: { Username: from }, CreatedAt: time }] }], review_notes: [] }
}
function mockMr(value: MergeRequest, comments = messages()) {
  return vi.spyOn(Commands.prototype, 'codebase').mockImplementation(async args => args[2] === 'list' ? comments :
    { repository: { id: '42' }, merge_request: value })
}

it('starts a Codebase-only deployment without gh authentication and selects its skill and isolated SSH environment', async () => {
  expect(h.runtime.configured()).toBe(true)
  expect(h.runtime.deployment.github).toBeUndefined()
  expect(account()).toMatchObject({ login: 'agent-bot', repositoryId: '42', repository: 'example/widgets' })
  const invocations = h.subprocess.spawn.mock.calls.map(([spec]) => spec.argv.join(' '))
  expect(invocations.some(argv => argv.includes('agent-gh api'))).toBe(false)
  expect(invocations.some(argv => argv.includes('ls-remote git@code.byted.org:example/widgets.git HEAD'))).toBe(true)
  const skills = new Map(h.runtime.prompts.skills(h.runtime.prompts.current().config))
  expect([...skills.keys()]).toEqual(['feishu', 'codebase'])
  expect(skills.get('codebase')).toContain('mr_number')
  const git = readFileSync(workerGitConfig(h.directory), 'utf8')
  expect(git).toContain('IdentitiesOnly=yes')
  expect(git).not.toContain('github.com')
  expect(readFileSync(join(workerBin(h.directory), 'bytedcli'), 'utf8')).toContain("'--profile' 'superagent'")
  expect(readFileSync(join(workerBin(h.directory), 'gh'), 'utf8')).toContain('GitHub is not configured')
  expect(agentVariables(h.directory)).toMatchObject({ GIT_SSH: undefined, GIT_SSH_COMMAND: undefined })
})

it('pins site/profile, validates JSON envelopes and passes multiline comment text as one argument', async () => {
  const run = vi.spyOn(Commands.prototype, 'run').mockResolvedValue(envelope({ created: true }))
  const body = 'First line\n`literal $(value)`\n最后一行'
  await h.runtime.commands.codebase(['mr', 'comment', 'create', '7', '-R', account().repository, '--body', body])
  expect(run).toHaveBeenLastCalledWith(account().cli,
    ['--no-auto-upgrade', '--json', '--site', 'cn', '--profile', 'superagent', 'codebase', 'mr', 'comment', 'create', '7', '-R', 'example/widgets', '--body', body])
  expect(codebaseArgs({ site: 'cn', profile: '' }, ['user', 'get', '@me'])).not.toContain('--profile')
  expect(() => codebaseData('{"status":"error","data":{}}')).toThrow()
  expect(codebaseTime(1770000000)).toBe(codebaseTime(1770000000000))
  expect(() => codebaseTime('invalid')).toThrow('invalid timestamp')
})

describe('setup checks', () => {
  const probe = (changes: { user?: unknown; repository?: unknown; member?: unknown; sshError?: boolean } = {}) => vi.fn(async (args: string[]) => {
    if (args[0] === 'git') { if (changes.sshError) throw new Error('SSH denied'); return 'abc\tHEAD' }
    if (args.includes('@me')) return envelope(changes.user ?? { User: { Username: 'agent-bot', Email: 'agent@example.test' } })
    if (args.includes('member')) return envelope(changes.member ?? { member: { canPush: true, user: { username: 'agent-bot' } } })
    return envelope(changes.repository ?? { Repository: { Id: 42, Path: 'example/widgets' } })
  })
  it('verifies the CLI identity, repository membership and exact SSH key without reading its contents', async () => {
    const run = probe()
    const deployment = await resolveCodebase(h.runtime.deployment, account(), run)
    expect(deployment.codebase?.repositoryId).toBe('42')
    expect(run).toHaveBeenLastCalledWith(['git', '-c', `core.sshCommand=${codebaseSshCommand(account().sshKey)}`,
      'ls-remote', 'git@code.byted.org:example/widgets.git', 'HEAD'])
  })
  it.each([
    { user: {} }, { repository: { Repository: { Path: 'example/widgets' } } },
    { repository: { Repository: { Id: 42, Path: 'example/other' } } },
    { member: { member: { canPush: false, user: { username: 'agent-bot' } } } },
    { member: { member: { canPush: true, user: { username: 'someone-else' } } } }, { sshError: true },
  ])('reports structured setup failures instead of starting with invalid access: %j', async changes => {
    await expect(resolveCodebase(h.runtime.deployment, account(), probe(changes))).rejects.toMatchObject({ code: 'codebaseSetup' })
  })
  it('rejects missing prerequisites and conflicting configured code platforms', async () => {
    await expect(resolveCodebase(h.runtime.deployment, { ...account(), site: '' }, probe())).rejects.toMatchObject({ code: 'codebaseSetup' })
    await expect(resolveCodebase(h.runtime.deployment, { ...account(), sshKey: '/missing/key' }, probe())).rejects.toMatchObject({ code: 'codebaseSetup' })
    const settings = h.runtime.store.settings()
    await expect(resolveRepository(h.runtime.deployment, { ...settings, sources: { ...settings.sources,
      github: { enabled: true, config: { repository: 'example/widgets', cli: 'gh' } } } }, probe())).rejects.toMatchObject({ code: 'repositoryConflict' })
  })
})

it('normalizes comments and review notes, retains edits, and rejects mismatched repository payloads', async () => {
  const time = at(), edited = at(1)
  const comments = { ...messages('first', 'alice', time), review_notes: [{ Id: 2, Content: 'review', Author: { Username: 'bob' }, CreatedAt: edited }] }
  const read = vi.spyOn(Commands.prototype, 'codebase').mockResolvedValue(comments)
  expect((await readCodebaseMessages(h.runtime.commands, 7)).map(item => item.id)).toEqual(['comment:1', 'review:2'])
  read.mockResolvedValue({ ...comments, threads: [{ Comments: [{ ...comments.threads[0]!.Comments[0], UpdatedAt: edited }] }] })
  expect((await readCodebaseMessages(h.runtime.commands, 7))[0]?.at).toBe(edited)
  read.mockResolvedValue({ ...comments, repository: { id: '999' } })
  await expect(readCodebaseMessages(h.runtime.commands, 7)).rejects.toThrow('another repository')
  read.mockResolvedValue({ repository: { id: '42' }, merge_request: request('branch', { TargetRepoId: '999' }) })
  await expect(readMergeRequest(h.runtime.commands, 7)).rejects.toThrow('another repository')
})

it('deduplicates unchanged comments, treats edited comments as new input and never treats bots or self as human authority', () => {
  const msg = { id: 'comment:1', from: 'alice', at: at(), text: '@agent-bot fix it' }
  const first = codebaseTrigger(context(), 7, msg)!
  expect(first).toMatchObject({ human: true, addressed: 'mention', meta: { repositoryId: '42' } })
  expect(codebaseTrigger(context(), 7, msg)?.id).toBe(first.id)
  expect(codebaseTrigger(context(), 7, { ...msg, at: at(2) })?.id).not.toBe(first.id)
  expect(codebaseTrigger(context(), 7, { ...msg, from: 'AGENT-BOT' })).toBeUndefined()
  expect(codebaseTrigger(context(), 7, { ...msg, bot: true })?.human).toBe(false)
  expect(codebaseTrigger(context(), 7, { ...msg, text: '@agent-bot-other do it' })).not.toHaveProperty('addressed')
  expect(codebaseKind.find?.('!7', h.runtime.deployment)?.threads).toEqual(['codebase:42:7'])
  expect(codebaseKind.find?.('https://code.byted.org/other/repo/merge_requests/7', h.runtime.deployment)?.threads).toEqual([])
})

it('binds only this ticket branch, repository and agent account, and leaves failed reports atomic', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  for (const overrides of [{ CreatedBy: { Username: 'alice' } }, { SourceBranchName: 'agent/other' }, { SourceRepoId: '999' }]) {
    mockMr(request(ticket.execution!.name, overrides))
    await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Draft', mr_number: 7 })).rejects.toThrow('does not belong')
    expect(h.runtime.store.tickets.get(ticket.id)?.follows ?? []).toEqual([])
  }
  await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Draft', pr_number: 7 })).rejects.toThrow('different code platform')
  await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Draft', pr_number: 7, mr_number: 7 })).rejects.toThrow('only one')
  mockMr(request(ticket.execution!.name))
  expect(await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'MR ready for checks', mr_number: 7 })).toMatchObject({ reported: true })
  expect(h.runtime.store.tickets.get(ticket.id)?.follows).toEqual([{ thread: 'codebase:42:7', own: true }])
  const other = await h.acceptedTicket(feishu('2', '@bot 再修一个'))
  h.runtime.store.tickets.save({ ...other.ticket, execution: ticket.execution })
  expect(claimMergeRequest(context(), other.ticket.id, request(ticket.execution!.name))).toContain('another active ticket')
})

it('delivers review once to the original worker, follows edits and sends one Feishu notice when a ready MR merges', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const mr = request(ticket.execution!.name)
  const read = mockMr(mr, messages('please fix this regression', 'alice', at(1)))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Bound MR', mr_number: 7 })
  await pollCodebase(context()); await h.runtime.idle()
  const count = h.runtime.store.read.triggers({}).items.filter(trigger => trigger.source === 'codebase').length
  expect(count).toBe(1)
  await pollCodebase(context()); await h.runtime.idle()
  expect(h.runtime.store.read.triggers({}).items.filter(trigger => trigger.source === 'codebase')).toHaveLength(count)
  expect(h.relays(sessionId).some(item => JSON.stringify(item).includes('codebase'))).toBe(true)
  read.mockImplementation(async args => args[2] === 'list' ? messages('updated review', 'alice', at(2)) : { repository: { id: '42' }, merge_request: mr })
  await pollCodebase(context()); await h.runtime.idle()
  expect(h.runtime.store.read.triggers({}).items.filter(trigger => trigger.source === 'codebase')).toHaveLength(2)
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Fixed and tested', mr_number: 7 })
  const merged = { ...mr, Status: 'merged' as const, MergedAt: at(3) }
  read.mockImplementation(async args => args[2] === 'list' ? { repository: { id: '42' }, threads: [] } : { repository: { id: '42' }, merge_request: merged })
  await pollCodebase(context()); await h.runtime.idle()
  const ended = h.runtime.store.tickets.get(ticket.id)!
  expect(ended.ended?.outcome).toBe('merged')
  const notices = mergeRequestEndNotices(ended, '修一下回归', h.runtime.deployment)
  expect(notices).toHaveLength(1)
  expect(notices[0]).toMatchObject({ channel: { source: 'feishu' }, text: expect.stringContaining('已合并') })
  await pollCodebase(context()); await h.runtime.idle()
  expect(mergeRequestEndNotices(h.runtime.store.tickets.get(ticket.id)!, '修一下回归', h.runtime.deployment).map(item => item.id)).toEqual(notices.map(item => item.id))
})

it('recovers the same MR subscription and deduplication after a process restart', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  mockMr(request(ticket.execution!.name), messages('review after restart', 'alice', at(1)))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'MR bound', mr_number: 7 })
  await pollCodebase(context()); await h.runtime.idle()
  const before = h.runtime.store.read.triggers({ source: 'codebase' }).items.map(item => item.id)
  await h.runtime.stop()
  const fresh = new Context()
  for (const [name, service] of Object.entries(h.services)) fresh.reflect.provide(name, service)
  const restarted = new Runtime(fresh, testMachine({ stateDir: h.directory }), vi.fn())
  try {
    await restarted.ready
    restarted.sources.register(codebaseKind)
    expect(restarted.configured()).toBe(true)
    expect(restarted.store.threads.get('codebase:42:7')?.subscriptions).toEqual([ticket.id])
    expect(restarted.store.tickets.get(ticket.id)?.follows).toEqual([{ thread: 'codebase:42:7', own: true }])
    await pollCodebase(sourceContext(restarted, codebaseKind)); await restarted.idle()
    expect(restarted.store.read.triggers({ source: 'codebase' }).items.map(item => item.id)).toEqual(before)
  } finally { await restarted.stop() }
})

it('keeps delivery idempotent using a bot-authored marker and rejects a reply to a different repository', async () => {
  const marker = '<!-- dsh-superagent:reply-1 -->'
  const run = vi.spyOn(Commands.prototype, 'codebase').mockResolvedValue(messages(marker, 'agent-bot'))
  const message = { id: 'reply-1', kind: 'notice' as const, text: 'Ready', channel: { source: 'codebase', thread: 'codebase:42:7', address: { number: '7', repository: 'example/widgets' } } }
  expect(await sendCodebase(context(), message)).toBe('sent')
  expect(run).toHaveBeenCalledOnce()
  run.mockResolvedValue(messages('no marker', 'alice'))
  await sendCodebase(context(), message)
  expect(run.mock.calls.at(-1)?.[0]).toEqual(['mr', 'comment', 'create', '7', '-R', 'example/widgets', '--body', `Ready\n\n${marker}`])
  await expect(sendCodebase(context(), { ...message, channel: { ...message.channel, address: { number: '7', repository: 'other/repo' } } })).rejects.toThrow('Invalid Codebase reply target')
})

it('shows the review number even when the ticket follows a later Feishu thread', () => {
  expect(reviewOf({ follows: [{ thread: 'codebase:42:7', own: true }, { thread: 'feishu:chat:root', own: false }] })).toEqual({ source: 'codebase', number: 7 })
})
