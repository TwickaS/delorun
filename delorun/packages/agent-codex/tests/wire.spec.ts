import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { commandRunRule, limitResetsAt, observationOf, toolCall, toolResult, turnFailure, usageOf } from '../src/mapping.ts'
import { RateLimitSnapshot, TESTED_CODEX_VERSION, TurnError } from '../src/protocol.ts'
import { CodexClosedError, CodexRpc, CodexRpcError, CodexWireError } from '../src/rpc.ts'
import { FakeAppServer, settle } from './fake-app-server.ts'
import { COMMAND, TASK, initializeResult, modelNotFound, rateLimits } from './recorded.ts'

describe('the pinned version', () => {
  it('is the version upstream\'s Codex pack pins', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../../packages/subagent/subagent-codex/package.json', import.meta.url), 'utf8')) as { readonly dependencies: Readonly<Record<string, string>> }
    expect(manifest.dependencies['@openai/codex']).toBe(TESTED_CODEX_VERSION)
  })
})

describe('the JSON-RPC client', () => {
  function connect() {
    const codex = new FakeAppServer()
    const rpc = new CodexRpc(codex.stdout, codex.stdin)
    const violations: CodexWireError[] = []
    rpc.start({ notification: () => {}, request: () => Promise.resolve(null), violation: (error) => { violations.push(error) } })
    return { codex, rpc, violations }
  }

  it('sends numbered JSON-RPC 2.0 requests and resolves the validated result', async () => {
    const { codex, rpc } = connect()
    codex.answer('initialize', { result: initializeResult })
    await expect(rpc.request('initialize', { clientInfo: {} }, AbortSignal.timeout(1_000))).resolves.toMatchObject({ userAgent: initializeResult.userAgent })
    expect(codex.received[0]).toEqual({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: {} } })
  })

  it('rejects a result whose fields have the wrong type', async () => {
    const { codex, rpc } = connect()
    codex.answer('turn/start', { result: { turn: { id: 7, status: 'inProgress' } } })
    await expect(rpc.request('turn/start', {}, AbortSignal.timeout(1_000))).rejects.toBeInstanceOf(CodexWireError)
  })

  it('rejects a JSON-RPC error with its method and code', async () => {
    const { codex, rpc } = connect()
    codex.answer('thread/resume', { error: { code: -32600, message: 'no rollout found' } })
    const error: unknown = await rpc.request('thread/resume', {}, AbortSignal.timeout(1_000)).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(CodexRpcError)
    expect(error).toMatchObject({ method: 'thread/resume', code: -32600 })
  })

  it('rejects waiting and later requests once Codex\'s output ends', async () => {
    const { codex, rpc } = connect()
    const waiting = rpc.request('model/list', {}, AbortSignal.timeout(1_000))
    await settle()
    codex.end({ exitCode: 0, signal: null })
    await expect(waiting).rejects.toBeInstanceOf(CodexClosedError)
    await expect(rpc.request('model/list', {}, AbortSignal.timeout(1_000))).rejects.toBeInstanceOf(CodexClosedError)
  })

  it('reports a line that is not JSON and a known notification it cannot read, without their content', async () => {
    const { codex, violations } = connect()
    codex.stdout.write('secret-looking text\n')
    codex.notify('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'paused' } })
    codex.notify('mcpServer/startupStatus/updated', { anything: true })
    await settle()
    expect(violations.map(error => error.message)).toEqual(['Codex wrote a line that is not JSON', "turn/completed: Codex's notification has fields Delorun cannot read"])
  })

  it('refuses a server request it cannot read', async () => {
    const { codex, violations } = connect()
    const reply = await codex.ask(1, 'item/commandExecution/requestApproval', { threadId: 'thread' })
    expect(reply.error).toMatchObject({ code: -32602 })
    expect(violations).toHaveLength(1)
  })
})

describe('mappings', () => {
  it('names tools as the person knows them and MCP tools as Claude Code does', () => {
    expect(toolCall({ type: 'commandExecution', id: 'e', command: COMMAND, cwd: TASK, status: 'inProgress' })).toEqual({ name: 'shell', input: JSON.stringify({ command: COMMAND, cwd: TASK }) })
    expect(toolCall({ type: 'mcpToolCall', id: 'm', server: 'delorun', tool: 'send_message', status: 'inProgress', arguments: { to: 'lead' } })).toEqual({ name: 'mcp__delorun__send_message', input: '{"to":"lead"}' })
    expect(toolCall({ type: 'webSearch', id: 'w', query: 'codex' }).name).toBe('web_search')
    expect(toolCall({ type: 'fileChange', id: 'f', status: 'inProgress', changes: [{ path: 'a.txt', kind: { type: 'add' }, diff: '+a' }] })).toEqual({ name: 'apply_patch', input: '{"changes":[{"path":"a.txt","diff":"+a"}]}' })
  })

  it('reports a declined, failed or non-zero command as an error result', () => {
    expect(toolResult({ type: 'commandExecution', id: 'e', command: 'x', cwd: '/', status: 'declined' })).toEqual({ output: 'The command was not run: it was declined.', isError: true })
    expect(toolResult({ type: 'commandExecution', id: 'e', command: 'x', cwd: '/', status: 'completed', exitCode: 2, aggregatedOutput: 'no' })).toEqual({ output: 'no', isError: true })
    expect(toolResult({ type: 'mcpToolCall', id: 'm', server: 's', tool: 't', status: 'completed', arguments: null, result: { content: [{ type: 'text', text: 'echo: hi' }] } })).toEqual({ output: 'echo: hi', isError: false })
    expect(toolResult({ type: 'mcpToolCall', id: 'm', server: 's', tool: 't', status: 'failed', arguments: null, error: { message: 'timed out awaiting tools/call after 300s' } })).toEqual({ output: 'timed out awaiting tools/call after 300s', isError: true })
  })

  it('counts cached input apart from fresh input', () => {
    expect(usageOf({ totalTokens: 150, inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 10, outputTokens: 50, reasoningOutputTokens: 20 }))
      .toEqual({ inputTokens: 30, outputTokens: 50, totalTokens: 150, cacheReadTokens: 60, cacheWriteTokens: 10, reasoningTokens: 20 })
  })

  it('keeps the model_not_found message for the person, as a program failure', () => {
    expect(turnFailure(TurnError.parse(modelNotFound), undefined)).toEqual({ category: 'program', detail: modelNotFound.message })
    expect(turnFailure(undefined, undefined)).toEqual({ category: 'program', detail: 'Codex ended the turn without saying why.' })
  })

  it('finds a sign-in failure in Codex\'s own words', () => {
    expect(turnFailure({ message: 'Your access token could not be refreshed because your refresh token has expired', codexErrorInfo: 'other' }, undefined)).toEqual({ category: 'signed-out' })
  })

  it('maps rateLimitExceeded to a limit, unlike upstream\'s one-shot provider', () => {
    expect(turnFailure({ message: 'rate limited', codexErrorInfo: 'rateLimitExceeded' }, undefined)).toEqual({ category: 'limit' })
  })

  it('takes a limit\'s reset time from the reached windows only', () => {
    expect(limitResetsAt({ primary: { usedPercent: 100, resetsAt: 10 }, secondary: { usedPercent: 50, resetsAt: 99 } })).toBe(10_000)
    expect(limitResetsAt({ primary: { usedPercent: 40, resetsAt: 10 } })).toBeUndefined()
  })

  it('marks a window at 100 % as reached', () => {
    const observation = observationOf({ snapshot: RateLimitSnapshot.parse(rateLimits(100, 'rate_limit_reached')), source: 'run' })
    expect(observation.windows[0]).toMatchObject({ status: 'reached' })
  })

  it('builds a run rule only for one plain command', () => {
    expect(commandRunRule({ command: 'touch a.txt', cwd: '/w' })).toEqual({ provider: 'codex', summary: 'touch a.txt', data: { kind: 'command', command: 'touch a.txt', cwd: '/w' } })
    expect(commandRunRule({ kind: 'writeStdin', command: 'y' })).toBeUndefined()
    expect(commandRunRule({ command: '  ' })).toBeUndefined()
    expect(commandRunRule({ command: 'curl x', networkApprovalContext: { host: 'x' } })).toBeUndefined()
  })
})
