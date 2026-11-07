import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { SettingsSchema } from '../src/policy.ts'
import { resolveWorkspace } from '../src/app/execution-environment.ts'
import { ticketExecution } from '../src/executor/dsh.ts'
import { assessmentOutcome } from '../src/policy.ts'
import type { Ticket } from '../src/core/index.ts'

const settings = (executor: Record<string, unknown> = {}) => SettingsSchema.parse({ executor })
const oneRule = (executor: Record<string, unknown> = {}) => SettingsSchema.parse({ executor,
  policy: { rules: [{ id: 'visual', name: 'Visual', enabled: true, instruction: 'Fix visual defects.' }] } })

const ticket = { id: 'ticket-0123456789abcdef', origin: { triggerId: 'tr1', triggerIds: [] },
  mandate: { strength: 'explicit', policyVersion: 'v1', basis: { rules: [] }, actor: { source: 'github', id: 'alice' }, scope: '' } } as unknown as Ticket

const accept = (extra: Record<string, unknown> = {}) => ({ kind: 'accept' as const, title: 'Fix', scope: 'the typo', reason: 'r', name: 'fix-typo', ...extra })

describe('resolveWorkspace', () => {
  it('falls back to the ticket root with a single implicit target when no workspaces are configured', () => {
    const s = settings({ directory: '/srv/work' })
    expect(resolveWorkspace(s, '/state', undefined)).toEqual({ id: '', root: '/srv/work' })
    // An id is ignored without configured workspaces.
    expect(resolveWorkspace(s, '/state', 'anything')).toEqual({ id: '', root: '/srv/work' })
  })

  it('defaults the ticket root to <stateDir>/work when directory is empty', () => {
    const s = settings({ directory: '' })
    expect(resolveWorkspace(s, '/state', undefined)).toEqual({ id: '', root: join('/state', 'work') })
  })

  it('uses the chosen workspace root, defaulting an empty directory to <root>/<id>', () => {
    const s = settings({ directory: '/srv/work', workspaces: [{ id: 'web', directory: '/code/web' }, { id: 'api', directory: '' }] })
    expect(resolveWorkspace(s, '/state', 'web')).toEqual({ id: 'web', root: '/code/web' })
    expect(resolveWorkspace(s, '/state', 'api')).toEqual({ id: 'api', root: join('/srv/work', 'api') })
    // An unknown or missing id falls back to the first configured workspace.
    expect(resolveWorkspace(s, '/state', 'missing')).toEqual({ id: 'web', root: '/code/web' })
    expect(resolveWorkspace(s, '/state', undefined)).toEqual({ id: 'web', root: '/code/web' })
  })
})

describe('ticketExecution workspaces', () => {
  it('is unchanged for a single implicit target: no workspace field, directory under the root', () => {
    const execution = ticketExecution(ticket, accept() as never, settings({ directory: '/srv/work' }), '/state')
    expect(execution.directory).toBe(join('/srv/work', 'fix-typo-ticket-01234'))
    expect(execution).not.toHaveProperty('workspace')
  })

  it('places the ticket under the chosen workspace and records its id', () => {
    const s = settings({ directory: '/srv/work', workspaces: [{ id: 'web', directory: '/code/web' }, { id: 'api', directory: '/code/api' }] })
    const execution = ticketExecution(ticket, accept({ workspace: 'api' }) as never, s, '/state')
    expect(execution.directory).toBe(join('/code/api', 'fix-typo-ticket-01234'))
    expect(execution.workspace).toBe('api')
  })
})

describe('assessmentOutcome workspace selection', () => {
  const base = { decision: 'accept' as const, direction: {}, rule_assessments: [], title: 'Fix', scope: 'x', reason: 'r',
    intent_evidence: 'quote', worktree_name: 'fix-typo' }
  const matching = { rule_assessments: [{ rule_id: 'visual', reason: 'matches', matched: true }], direction:
    { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'q' } }

  it('keeps a chosen workspace that names a configured one', () => {
    const s = oneRule({ workspaces: [{ id: 'web', directory: '/code/web' }, { id: 'api', directory: '/code/api' }] })
    const result = assessmentOutcome({ ...base, ...matching, workspace: 'api' } as never, { ...s }, 'explicit')
    expect(result).toMatchObject({ kind: 'accept', workspace: 'api' })
  })

  it('falls back to the first workspace when none or an unknown id is chosen', () => {
    const s = oneRule({ workspaces: [{ id: 'web', directory: '/code/web' }, { id: 'api', directory: '/code/api' }] })
    expect(assessmentOutcome({ ...base, ...matching } as never, { ...s }, 'explicit')).toMatchObject({ kind: 'accept', workspace: 'web' })
    expect(assessmentOutcome({ ...base, ...matching, workspace: 'nope' } as never, { ...s }, 'explicit')).toMatchObject({ workspace: 'web' })
  })

  it('omits workspace when none are configured', () => {
    const s = oneRule({})
    const result = assessmentOutcome({ ...base, ...matching } as never, { ...s }, 'explicit')
    expect(result.kind).toBe('accept')
    expect(result).not.toHaveProperty('workspace')
  })
})
