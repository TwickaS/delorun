import { describe, expect, it } from 'vitest'
import type { CanUseTool, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { ProgramOpenError, type JsonValue, type ProgramApprovalRequest, type ProgramHarnessTool, type ProgramOpenRequest, type SessionId } from '@delorun/external-agents/contract'
import { ClaudeCodeDriver } from '../src/driver.ts'
import { STOPPED_MESSAGE } from '../src/harness-tools.ts'
import { loadClaudeSdk } from '../src/sdk.ts'
import { FakeSdk } from './fake-sdk.ts'
import { locateSdk } from './locate-sdk.ts'

// The real SDK's in-process MCP server maker; loading the SDK starts no process.
const real = await loadClaudeSdk(locateSdk())
const signal = AbortSignal.timeout(5_000)

interface Call { readonly input: JsonValue; readonly signal: AbortSignal }

function echo(calls: Call[], finish: (signal: AbortSignal) => Promise<{ output: string; isError: boolean }> = () => Promise.resolve({ output: 'echoed', isError: false })): ProgramHarnessTool {
  return {
    name: 'echo',
    description: 'Echo the text.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    call: (input, callSignal) => { calls.push({ input, signal: callSignal }); return finish(callSignal) },
  }
}

async function opened(tools: readonly ProgramHarnessTool[], asked: ProgramApprovalRequest[] = []) {
  const sdk = new FakeSdk(() => {}, options => real.createSdkMcpServer(options))
  const request: ProgramOpenRequest = {
    sessionId: 'child' as SessionId, cwd: '/tmp/task', runRules: [], harnessTools: tools,
    spawn: () => { throw new Error('a unit spec starts no process') },
    onApproval: (question) => { asked.push(question); return Promise.resolve('reject') },
    onLimits: () => {}, signal: new AbortController().signal,
  }
  const session = await new ClaudeCodeDriver({ sdk: () => Promise.resolve(sdk), harnessToolTimeoutMs: () => 1 }).open(request)
  const servers = sdk.last.options.mcpServers ?? {}
  const [name] = Object.keys(servers)
  const canUse = sdk.last.options.canUseTool
  if (canUse === undefined) throw new Error('the driver gave no canUseTool')
  return { sdk, session, name, canUse, servers }
}

function definition(sdk: FakeSdk, name: string | undefined): SdkMcpToolDefinition {
  const found = name === undefined ? undefined : sdk.servers.get(name)?.[0]
  if (found === undefined) throw new Error('no tool was offered')
  return found
}

function ask(canUse: CanUseTool, toolName: string) {
  return canUse(toolName, { text: 'hi' }, { signal, toolUseID: 'call-1', requestId: 'r1' })
}

describe('harness tools', () => {
  it('offers no MCP server when the gate offers no harness tool', async () => {
    const { servers, session } = await opened([])
    expect(servers).toEqual({})
    await session.close()
  })

  it('offers the tools on a server with a fresh random name for each session', async () => {
    const first = await opened([echo([])])
    const second = await opened([echo([])])
    expect(first.name).toMatch(/^delorun_[0-9a-f]{12}$/)
    expect(second.name).not.toBe(first.name)
    expect(first.servers[first.name ?? '']).toMatchObject({ type: 'sdk', name: first.name })
    await first.session.close()
    await second.session.close()
  })

  it('answers the question about its own tool on its own server itself, without asking the seat', async () => {
    const asked: ProgramApprovalRequest[] = []
    const { name, canUse, session } = await opened([echo([])], asked)
    expect(await ask(canUse, `mcp__${name}__echo`)).toEqual({ behavior: 'allow', updatedInput: { text: 'hi' } })
    expect(asked).toEqual([])
    await session.close()
  })

  it.each([
    ['the same tool on a server named delorun', 'mcp__delorun__echo'],
    ['a tool it did not offer on its own server', 'mcp__SERVER__other'],
    ['a prefix of its own tool', 'mcp__SERVER__ech'],
    ['the bare tool name', 'echo'],
  ])('sends a question about %s to the seat', async (_case, toolName) => {
    const asked: ProgramApprovalRequest[] = []
    const { name, canUse, session } = await opened([echo([])], asked)
    await ask(canUse, toolName.replace('SERVER', name ?? ''))
    expect(asked).toHaveLength(1)
    await session.close()
  })

  it('runs a call with the validated input and returns the tool\'s output', async () => {
    const calls: Call[] = []
    const { sdk, name, session } = await opened([echo(calls, () => Promise.resolve({ output: 'no such file', isError: true }))])
    const result = await definition(sdk, name).handler({ text: 'hi' }, { signal: new AbortController().signal })
    expect(calls.map(call => call.input)).toEqual([{ text: 'hi' }])
    expect(result).toEqual({ content: [{ type: 'text', text: 'no such file' }], isError: true })
    await session.close()
  })

  it('aborts the call when Claude Code cancels it at its wait limit, and reports it stopped', async () => {
    const calls: Call[] = []
    const stopped = (callSignal: AbortSignal) => new Promise<{ output: string; isError: boolean }>((resolve) => {
      callSignal.addEventListener('abort', () => { resolve({ output: 'partial', isError: false }) }, { once: true })
    })
    const { sdk, name, session } = await opened([echo(calls, stopped)])
    const cancel = new AbortController()
    const running = definition(sdk, name).handler({ text: 'hi' }, { signal: cancel.signal })
    cancel.abort()
    expect(await running).toEqual({ content: [{ type: 'text', text: STOPPED_MESSAGE }], isError: true })
    expect(calls[0]?.signal.aborted).toBe(true)
    await session.close()
  })

  it('aborts running calls when the session closes', async () => {
    const { sdk, name, session } = await opened([echo([], callSignal => new Promise((_resolve, reject) => {
      callSignal.addEventListener('abort', () => { reject(callSignal.reason) }, { once: true })
    }))])
    const running = definition(sdk, name).handler({ text: 'hi' }, {})
    await session.close()
    expect(await running).toEqual({ content: [{ type: 'text', text: STOPPED_MESSAGE }], isError: true })
  })

  it.each<[string, ProgramHarnessTool[]]>([
    ['a name Claude Code would change', [{ ...echo([]), name: 'read.file' }]],
    ['a name offered twice', [echo([]), echo([])]],
    ['a schema that is not an object', [{ ...echo([]), inputSchema: { type: 'string' } }]],
    ['a schema that is not JSON Schema', [{ ...echo([]), inputSchema: 'text' }]],
  ])('refuses to open with %s', async (_case, tools) => {
    await expect(opened(tools)).rejects.toBeInstanceOf(ProgramOpenError)
  })
})
