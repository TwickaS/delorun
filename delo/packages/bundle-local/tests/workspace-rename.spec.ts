/**
 * The `rename_workspace` tool over a stand-in workspace registry and approval service: it checks first, asks the
 * person from inside the call, and renames only after `allowed-once`. With the switch off the tool is absent.
 */
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, vi } from 'vitest'
import { apply, Config, renameWorkspaceTool, RenameToolError } from '../src/workspace-rename.ts'

/** One stand-in workspace. */
interface Stand { id: string, title: string, setTitle: ReturnType<typeof vi.fn> }

/**
 * A context with the stand-in services.
 * @param answer - what the approval service answers, or `undefined` for no approval service.
 * @param titles - the titles of the registry's workspaces, in order; their ids are `w1`, `w2`, and so on.
 * @returns the tool, the calls the services saw and the workspaces.
 */
function setup(answer: ApprovalOutcome | undefined, titles: readonly string[] = ['Old', 'Other']) {
  const ctx = new Context()
  const calls: string[] = []
  const requests: { reason?: string, toolName: string }[] = []
  const workspaces: Stand[] = titles.map((title, index) => {
    const stand: Stand = {
      id: `w${String(index + 1)}`,
      title,
      setTitle: vi.fn((next: string) => {
        calls.push('rename')
        stand.title = next
        return Promise.resolve()
      }),
    }
    return stand
  })
  ctx.provide('workspaceRegistry', { list: () => workspaces } as never)
  if (answer !== undefined) {
    ctx.provide('approval', {
      request: (request: { reason?: string, toolName: string }) => {
        calls.push('ask')
        requests.push(request)
        return Promise.resolve(answer)
      },
    } as never)
  }
  return { tool: renameWorkspaceTool(ctx), calls, requests, workspaces }
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

  it('asks, then renames by current name and returns the new name', async () => {
    const { tool, calls, requests, workspaces } = setup('allowed-once')
    const value = await run(tool, { workspace: 'Old', name: ' New ' })
    expect(value).toEqual({ from: 'Old', to: 'New', changed: true })
    expect(tool.output?.render?.({} as never, value as never)).toEqual([{ type: 'text', text: 'Renamed the workspace "Old" to "New".' }])
    expect(tool.output?.presentationMeta?.({} as never, value as never)).toEqual({ from: 'Old', to: 'New' })
    expect(calls).toEqual(['ask', 'rename'])
    expect(workspaces[0]?.title).toBe('New')
    expect(requests[0]).toMatchObject({ toolName: 'rename_workspace', reason: 'rename_workspace: rename the workspace "Old" to "New".' })
  })

  it('names the workspace by its id too', async () => {
    const { tool, workspaces } = setup('allowed-once')
    expect(await run(tool, { workspace: 'w2', name: 'Docs' })).toEqual({ from: 'Other', to: 'Docs', changed: true })
    expect(workspaces[1]?.title).toBe('Docs')
  })

  it.each(['rejected', 'cancelled', 'unavailable'] as const)('changes nothing when the answer is %s', async (answer) => {
    const { tool, calls, workspaces } = setup(answer)
    await expect(run(tool, { workspace: 'Old', name: 'New' })).rejects.toMatchObject({ code: 'WORKSPACE_RENAME_DECLINED' })
    expect(calls).toEqual(['ask'])
    expect(workspaces[0]?.title).toBe('Old')
  })

  it('does not rename without an approval service or an agent to ask for', async () => {
    const none = setup(undefined)
    await expect(run(none.tool, { workspace: 'Old', name: 'New' })).rejects.toBeInstanceOf(RenameToolError)
    expect(none.calls).toEqual([])
    const orphan = setup('allowed-once')
    await expect(run(orphan.tool, { workspace: 'Old', name: 'New' }, false)).rejects.toMatchObject({ code: 'WORKSPACE_RENAME_DECLINED' })
    expect(orphan.calls).toEqual([])
  })

  it('refuses a name another workspace has, before it asks', async () => {
    const { tool, calls } = setup('allowed-once')
    await expect(run(tool, { workspace: 'Old', name: 'Other' })).rejects.toMatchObject({
      code: 'WORKSPACE_RENAME_REFUSED',
      message: 'Delo refused it (conflict): the name "Other" is already in use by another workspace',
    })
    expect(calls).toEqual([])
  })

  it('refuses an unknown workspace and an ambiguous name, before it asks', async () => {
    const { tool, calls } = setup('allowed-once', ['Same', 'Same'])
    await expect(run(tool, { workspace: 'missing', name: 'X' })).rejects.toMatchObject({ code: 'WORKSPACE_RENAME_REFUSED', message: expect.stringContaining('(not-found)') })
    await expect(run(tool, { workspace: 'Same', name: 'X' })).rejects.toMatchObject({ code: 'WORKSPACE_RENAME_REFUSED', message: expect.stringContaining('name one by its id: w1, w2') })
    expect(calls).toEqual([])
  })

  it('refuses a name another workspace took while the person decided', async () => {
    const { workspaces } = setup('allowed-once')
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { list: () => workspaces } as never)
    ctx.provide('approval', {
      request: () => {
        ;(workspaces[1] as Stand).title = 'New'
        return Promise.resolve('allowed-once' as const)
      },
    } as never)
    await expect(run(renameWorkspaceTool(ctx), { workspace: 'w1', name: 'New' })).rejects.toMatchObject({ code: 'WORKSPACE_RENAME_REFUSED' })
    expect(workspaces[0]?.title).toBe('Old')
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
    const value = await run(tool, { workspace: 'Old', name: 'Old' })
    expect(value).toEqual({ from: 'Old', to: 'Old', changed: false })
    expect(tool.output?.render?.({} as never, value as never)).toEqual([{ type: 'text', text: 'The workspace is already named "Old".' }])
    expect(calls).toEqual([])
  })
})

describe('the rename_workspace_tool switch', () => {
  /**
   * Apply the plugin to a context that has the services it needs.
   * @param config - the plugin's config.
   * @returns the names of the tools it registered.
   */
  function registered(config: unknown): string[] {
    const ctx = new Context()
    const names: string[] = []
    ctx.provide('tools', { register: (tool: { name: string }) => { names.push(tool.name); return () => {} } } as never)
    ctx.provide('workspaceRegistry', { list: () => [] } as never)
    apply(ctx, Config(config))
    return names
  }

  it('registers the tool with the switch on', () => {
    expect(registered({ enabled: true })).toEqual(['rename_workspace'])
  })

  it('registers nothing with the switch off, which is its default', () => {
    expect(registered({ enabled: false })).toEqual([])
    expect(registered({})).toEqual([])
  })
})
