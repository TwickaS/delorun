/**
 * The `rename_workspace` tool over a stand-in `deloWorkspaces` service and approval service: it checks first, asks the
 * person from inside the call, and renames only after `allowed-once`.
 */
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { describe, expect, it, vi } from 'vitest'
import { renameWorkspaceTool, RenameToolError } from '../src/rename-tool.ts'
import { WorkspaceRefusedError } from '../src/service.ts'

const ID = WorkspaceId('w1')

/**
 * A context with the stand-in services.
 * @param answer - what the approval service answers, or `undefined` for no approval service.
 * @param refusal - a refusal the service's check throws.
 * @returns the tool, the calls the services saw and the context.
 */
function setup(answer: ApprovalOutcome | undefined, refusal?: WorkspaceRefusedError) {
  const ctx = new Context()
  const calls: string[] = []
  const requests: { reason?: string, toolName: string }[] = []
  const service = {
    planRename: vi.fn((request: { workspace: string, name: string }) => {
      calls.push('plan')
      if (refusal !== undefined) return Promise.reject(refusal)
      return Promise.resolve({ workspace: ID, from: request.workspace === 'same' ? request.name : 'Old', to: request.name })
    }),
    rename: vi.fn((request: { workspace: string, name: string }) => {
      calls.push('rename')
      return Promise.resolve({ workspace: ID, from: 'Old', to: request.name })
    }),
  }
  ctx.provide('deloWorkspaces', service as never)
  if (answer !== undefined) {
    ctx.provide('approval', {
      request: (request: { reason?: string, toolName: string }) => {
        calls.push('ask')
        requests.push(request)
        return Promise.resolve(answer)
      },
    } as never)
  }
  return { tool: renameWorkspaceTool(ctx), calls, requests, service }
}

const exec = (agent: boolean): ToolRunContext => ({ name: 'rename_workspace', callId: 'c1', signal: new AbortController().signal, ...agent ? { agent: {} } : {} }) as ToolRunContext

/**
 * Run the tool.
 * @param tool - the definition.
 * @param args - the model's arguments.
 * @param withAgent - whether the call has an agent.
 * @returns the tool's result.
 */
function run(tool: ToolDefinition, args: Record<string, unknown>, withAgent = true): Promise<unknown> {
  return tool.execute(args as never, exec(withAgent)) as Promise<unknown>
}

describe('rename_workspace', () => {
  it('describes itself as the way to rename, instead of editing files', () => {
    const { tool } = setup('allowed-once')
    expect(tool.description).toBe('Rename a workspace. Use it instead of editing any file to rename one. It asks the person first.')
    expect(tool.presentCall?.({ workspace: 'Old', name: 'New' } as never)).toMatchObject({ card: 'generic', title: 'Rename the workspace Old to New' })
  })

  it('checks, asks, then renames and returns the new name', async () => {
    const { tool, calls, requests } = setup('allowed-once')
    expect(await run(tool, { workspace: 'Old', name: ' New ' })).toBe('Renamed the workspace "Old" to "New".')
    expect(calls).toEqual(['plan', 'ask', 'rename'])
    expect(requests[0]).toMatchObject({ toolName: 'rename_workspace', reason: 'rename_workspace: rename the workspace "Old" to "New".' })
  })

  it.each(['rejected', 'cancelled', 'unavailable'] as const)('changes nothing when the answer is %s', async (answer) => {
    const { tool, calls } = setup(answer)
    await expect(run(tool, { workspace: 'Old', name: 'New' })).rejects.toMatchObject({ code: 'WORKSPACE_RENAME_DECLINED' })
    expect(calls).toEqual(['plan', 'ask'])
  })

  it('does not rename without an approval service or an agent to ask for', async () => {
    const none = setup(undefined)
    await expect(run(none.tool, { workspace: 'Old', name: 'New' })).rejects.toBeInstanceOf(RenameToolError)
    expect(none.calls).toEqual(['plan'])
    const orphan = setup('allowed-once')
    await expect(run(orphan.tool, { workspace: 'Old', name: 'New' }, false)).rejects.toMatchObject({ code: 'WORKSPACE_RENAME_DECLINED' })
    expect(orphan.calls).toEqual(['plan'])
  })

  it('refuses what the studio would refuse before it asks, in the service\'s words', async () => {
    const { tool, calls } = setup('allowed-once', new WorkspaceRefusedError('conflict', 'the name "X" is already in use by another workspace'))
    await expect(run(tool, { workspace: 'Old', name: 'X' })).rejects.toMatchObject({
      code: 'WORKSPACE_RENAME_REFUSED',
      message: 'Delo refused it (conflict): the name "X" is already in use by another workspace',
    })
    expect(calls).toEqual(['plan'])
  })

  it('refuses arguments that are not a workspace and a name, and asks nothing', async () => {
    const { tool, calls } = setup('allowed-once')
    await expect(run(tool, { workspace: '', name: 'New' })).rejects.toMatchObject({ code: 'WORKSPACE_RENAME_INVALID' })
    await expect(run(tool, { workspace: 'Old', name: '   ' })).rejects.toMatchObject({ code: 'WORKSPACE_RENAME_INVALID' })
    await expect(run(tool, { workspace: 'Old', name: 'x'.repeat(201) })).rejects.toMatchObject({ code: 'WORKSPACE_RENAME_INVALID' })
    expect(calls).toEqual([])
  })

  it('says so, without asking, when the name is already the workspace\'s', async () => {
    const { tool, calls } = setup('allowed-once')
    expect(await run(tool, { workspace: 'same', name: 'Same' })).toBe('The workspace is already named "Same".')
    expect(calls).toEqual(['plan'])
  })

  it('lets a failure that is not a refusal through unchanged', async () => {
    const { tool, service } = setup('allowed-once')
    service.planRename.mockRejectedValueOnce(new RangeError('broke'))
    await expect(run(tool, { workspace: 'Old', name: 'New' })).rejects.toBeInstanceOf(RangeError)
  })
})
