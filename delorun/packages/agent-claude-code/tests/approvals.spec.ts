import { describe, expect, it } from 'vitest'
import type { CanUseTool, PermissionRuleValue, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import { allowedToolsFor, CANCELLED_MESSAGE, exactRunRules, REJECTED_MESSAGE, ruleText, rulesOf } from '../src/approvals.ts'
import { ClaudeCodeDriver } from '../src/driver.ts'
import type { ProgramApprovalAnswer, ProgramApprovalRequest, ProgramEvent, ProgramOpenRequest, ProgramRunRule, SessionId } from '@delorun/external-agents/contract'
import { assistant, FakeSdk, result, TOUCH_SUGGESTIONS } from './fake-sdk.ts'

const signal = AbortSignal.timeout(5_000)

function allow(...rules: PermissionRuleValue[]): PermissionUpdate {
  return { type: 'addRules', rules, behavior: 'allow', destination: 'localSettings' }
}

async function opened(answer: (request: ProgramApprovalRequest) => Promise<ProgramApprovalAnswer>, extra: Partial<ProgramOpenRequest> = {}) {
  const sdk = new FakeSdk()
  const session = await new ClaudeCodeDriver({
    sdk: () => Promise.resolve(sdk),
    harnessToolTimeoutMs: () => 1,
    spawnOption: () => () => { throw new Error('a unit spec starts no process') },
  }).open({
    sessionId: 'child' as SessionId, cwd: '/tmp/task', level: 'standard', runRules: [], harnessTools: [], sharesFolder: () => false,
    spawn: () => { throw new Error('a unit spec starts no process') },
    onApproval: answer, onLimits: () => {}, signal: new AbortController().signal, ...extra,
  })
  const ask = sdk.last.options.canUseTool
  if (ask === undefined) throw new Error('the driver gave no canUseTool')
  return { sdk, session, ask }
}

function question(ask: CanUseTool, abort = new AbortController()) {
  return ask('Bash', { command: 'touch a.txt' }, {
    signal: abort.signal, suggestions: TOUCH_SUGGESTIONS, toolUseID: 'call-1', requestId: 'r1', title: 'Claude wants to run touch a.txt',
  })
}

describe('Claude Code questions', () => {
  it('asks the seat about the recorded call, offering only the suggested allow rule as the run rule', async () => {
    const asked: ProgramApprovalRequest[] = []
    const { ask, session } = await opened((request) => { asked.push(request); return Promise.resolve('allow-once') })
    await question(ask)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({
      callId: 'call-1', toolName: 'Bash', reason: 'Claude wants to run touch a.txt',
      runRule: { provider: 'claude-code', summary: 'Bash(touch a.txt)', data: { rules: [{ toolName: 'Bash', ruleContent: 'touch a.txt' }] } },
    })
    await session.close()
  })

  it('maps allow once to allow without any rule', async () => {
    const { ask, session } = await opened(() => Promise.resolve('allow-once'))
    expect(await question(ask)).toEqual({ behavior: 'allow', updatedInput: { command: 'touch a.txt' } })
    await session.close()
  })

  it('maps allow for this run to the suggested allow rules as session rules, never a mode change or a folder grant', async () => {
    const { ask, session } = await opened(() => Promise.resolve('allow-run'))
    const answer = await question(ask)
    expect(answer).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'touch a.txt' },
      updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch a.txt' }], behavior: 'allow', destination: 'session' }],
    })
    const types = answer?.behavior === 'allow' ? (answer.updatedPermissions ?? []).map(update => update.type) : []
    expect(types).not.toContain('setMode')
    expect(types).not.toContain('addDirectories')
    await session.close()
  })

  it('builds the run rule from a Bash call when the program suggests no allow rule, and never takes a mode or folder', async () => {
    const asked: ProgramApprovalRequest[] = []
    const { ask, session } = await opened((request) => { asked.push(request); return Promise.resolve('allow-run') })
    const answer = await ask('Bash', { command: 'mkdir c' }, {
      signal, toolUseID: 'call-2', requestId: 'r2',
      suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }, { type: 'addDirectories', directories: ['/'], destination: 'session' }],
    })
    expect(asked[0]?.runRule?.summary).toBe('Bash(mkdir c)')
    expect(asked[0]?.reason).toBe('Bash: mkdir c')
    expect(answer).toEqual({
      behavior: 'allow', updatedInput: { command: 'mkdir c' },
      updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'mkdir c' }], behavior: 'allow', destination: 'session' }],
    })
    await session.close()
  })

  it('maps reject to a denial that lets the turn go on', async () => {
    const { ask, session } = await opened(() => Promise.resolve('reject'))
    expect(await question(ask)).toEqual({ behavior: 'deny', message: REJECTED_MESSAGE })
    await session.close()
  })

  it('maps cancel to a denial that stops the turn, which ends interrupted', async () => {
    const { ask, session, sdk } = await opened(() => Promise.resolve('cancel'))
    await session.send('touch it', 'start')
    expect(await question(ask)).toEqual({ behavior: 'deny', message: CANCELLED_MESSAGE, interrupt: true })
    sdk.last.emit(result({ subtype: 'error_during_execution', is_error: true }))
    expect(await session.next(signal)).toMatchObject({ kind: 'turn-end', outcome: 'interrupted' })
    await session.close()
  })

  it('never takes the reason from the program model\'s own description of the call', async () => {
    const asked: ProgramApprovalRequest[] = []
    const { ask, session } = await opened((request) => { asked.push(request); return Promise.resolve('reject') })
    await ask('Bash', { command: 'rm -rf build', description: 'Tidy up harmlessly' }, { signal, toolUseID: 'call-3', requestId: 'r3', description: 'Tidy up harmlessly' })
    expect(asked[0]?.reason).toBe('Bash: rm -rf build')
    await session.close()
  })

  it.each([
    ['Edit', { file_path: 'sum.js', old_string: 'SECRET OLD', new_string: 'SECRET NEW' }, 'Edit sum.js'],
    ['Write', { file_path: 'test/sum.test.js', content: 'SECRET CONTENT' }, 'Write test/sum.test.js'],
    ['NotebookEdit', { notebook_path: 'a.ipynb', new_source: 'SECRET' }, 'NotebookEdit a.ipynb'],
    ['Bash', { command: 'x'.repeat(400) }, `Bash: ${'x'.repeat(300)}…`],
    ['Glob', { path: 'p'.repeat(400) }, `Glob ${'p'.repeat(300)}…`],
    ['Mystery', { payload: 'SECRET' }, 'Mystery'],
  ])('words a question about %s as its tool with its command or path, never the call\'s other fields', async (tool, input, reason) => {
    const asked: ProgramApprovalRequest[] = []
    const { ask, session } = await opened((request) => { asked.push(request); return Promise.resolve('reject') })
    await ask(tool, input, { signal, toolUseID: 'call-4', requestId: 'r4' })
    expect(asked[0]?.reason).toBe(reason)
    expect(asked[0]?.reason).not.toContain('SECRET')
    await session.close()
  })

  it('stops the turn when the seat cannot answer', async () => {
    const { ask, session } = await opened(() => Promise.reject(new Error('seat gone')))
    expect(await question(ask)).toEqual({ behavior: 'deny', message: CANCELLED_MESSAGE, interrupt: true })
    await session.close()
  })

  it('passes the program\'s withdrawal of a question on as the request\'s abort', async () => {
    const withdraw = new AbortController()
    let seen: AbortSignal | undefined
    const { ask, session } = await opened(request => new Promise((resolve) => {
      seen = request.signal
      request.signal.addEventListener('abort', () => { resolve('cancel') }, { once: true })
    }))
    const answer = question(ask, withdraw)
    withdraw.abort()
    await answer
    expect(seen?.aborted).toBe(true)
    await session.close()
  })

  it('ends the program\'s open message before the question goes to the seat', async () => {
    let events: ProgramEvent[] = []
    const { ask, session, sdk } = await opened(async () => {
      events = [await session.next(signal), await session.next(signal)]
      return 'allow-once'
    })
    await session.send('touch it', 'start')
    sdk.last.emit(assistant('m1', [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'touch a.txt' } }]))
    await new Promise(resolve => setTimeout(resolve, 10))
    await question(ask)
    expect(events.map(event => event.kind)).toEqual(['tool-call', 'message-end'])
    await session.close()
  })

  it('re-applies the exact run rules the person allowed earlier when the program starts again, and no other', async () => {
    const rules: ProgramRunRule[] = [
      { provider: 'claude-code', summary: 'Bash(touch a.txt)', data: { rules: [{ toolName: 'Bash', ruleContent: 'touch a.txt' }] } },
      { provider: 'claude-code', summary: 'Bash(touch a.txt)', data: { rules: [{ toolName: 'Bash', ruleContent: 'touch a.txt' }] } },
      { provider: 'claude-code', summary: 'Read', data: { rules: [{ toolName: 'Read' }] } },
      { provider: 'codex', summary: 'not ours', data: { rules: [{ toolName: 'Bash' }] } },
    ]
    const { sdk, session } = await opened(() => Promise.resolve('reject'), { runRules: rules, resume: 'program-1' })
    expect(sdk.last.options.allowedTools).toEqual(['Bash(touch a.txt)'])
    await session.close()
  })
})

describe('run rules', () => {
  it('takes the one suggested allow rule whose content is the exact command asked about', () => {
    expect(exactRunRules('Bash', { command: 'touch a.txt' }, TOUCH_SUGGESTIONS)).toEqual([{ toolName: 'Bash', ruleContent: 'touch a.txt' }])
    expect(exactRunRules('PowerShell', { command: 'make' }, [allow({ toolName: 'PowerShell', ruleContent: 'make' })])).toEqual([{ toolName: 'PowerShell', ruleContent: 'make' }])
  })

  it.each<[string, Record<string, unknown>, PermissionUpdate[] | undefined]>([
    ['no suggestion', { command: 'touch a.txt' }, undefined],
    ['a prefix suggestion', { command: 'rm -rf build' }, [allow({ toolName: 'Bash', ruleContent: 'rm:*' })]],
    ['a wildcard suggestion', { command: 'echo run' }, [allow({ toolName: 'Bash', ruleContent: 'echo run *' })]],
    ['a bare tool suggestion', { command: 'make' }, [allow({ toolName: 'Bash' })]],
    ['a suggestion for another command', { command: 'make test' }, [allow({ toolName: 'Bash', ruleContent: 'make' })]],
    ['two suggested rules', { command: 'make' }, [allow({ toolName: 'Bash', ruleContent: 'make' }, { toolName: 'Bash', ruleContent: 'ls' })]],
    ['a mode change', { command: 'make' }, [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }]],
    ['a folder grant', { command: 'make' }, [{ type: 'addDirectories', directories: ['/'], destination: 'session' }]],
  ])('builds the exact Bash rule from the call for %s', (_case, input, suggestions) => {
    expect(exactRunRules('Bash', input, suggestions)).toEqual([{ toolName: 'Bash', ruleContent: input.command }])
  })

  it.each<[string, string, Record<string, unknown>, PermissionUpdate[]]>([
    ['a wildcard in the command', 'Bash', { command: 'rm *.txt' }, [allow({ toolName: 'Bash', ruleContent: 'rm *.txt' })]],
    ['a multi-line command', 'Bash', { command: 'make\nmake install' }, []],
    ['an opening parenthesis', 'Bash', { command: 'echo (a' }, []],
    ['a closing parenthesis', 'Bash', { command: 'echo a)' }, []],
    ['an output redirect', 'Bash', { command: 'echo run > run.txt' }, [allow({ toolName: 'Bash', ruleContent: 'echo run *' })]],
    ['an input redirect', 'Bash', { command: 'sort < names.txt' }, []],
    ['a pipe', 'Bash', { command: 'ls | head' }, [allow({ toolName: 'Bash', ruleContent: 'ls:*' })]],
    ['a command with a carriage return', 'Bash', { command: 'make\rrm -rf /' }, []],
    ['a Bash call without a command', 'Bash', { description: 'nothing' }, []],
    ['a path glob', 'Edit', { file_path: '/w/src/a.ts' }, [allow({ toolName: 'Edit', ruleContent: '/w/src/**' })]],
    ['an exact path', 'Edit', { file_path: '/w/src/a.ts' }, [allow({ toolName: 'Edit', ruleContent: '/w/src/a.ts' })]],
    ['another tool with a prefix suggestion', 'PowerShell', { command: 'make' }, [allow({ toolName: 'PowerShell', ruleContent: 'make:*' })]],
    ['another tool with no suggestion', 'PowerShell', { command: 'make' }, []],
    ['a suggestion for another tool', 'PowerShell', { command: 'make' }, [allow({ toolName: 'Bash', ruleContent: 'make' })]],
  ])('offers no run rule for %s', (_case, toolName, input, suggestions) => {
    expect(exactRunRules(toolName, input, suggestions)).toEqual([])
  })

  it('asks a multi-line question with no run rule, so the card offers only Reject and Allow once', async () => {
    const asked: ProgramApprovalRequest[] = []
    const { ask, session } = await opened((request) => { asked.push(request); return Promise.resolve('allow-once') })
    await ask('Bash', { command: 'make\nrm -rf build' }, { signal, toolUseID: 'call-4', requestId: 'r4', suggestions: [allow({ toolName: 'Bash', ruleContent: 'make:*' })] })
    expect(asked[0]?.runRule).toBeUndefined()
    await session.close()
  })

  it('writes rules in Claude Code\'s syntax, escaping parentheses and backslashes', () => {
    expect(ruleText({ toolName: 'Read' })).toBe('Read')
    expect(ruleText({ toolName: 'Bash', ruleContent: 'echo (a) \\n' })).toBe('Bash(echo \\(a\\) \\\\n)')
  })

  it('reads no rule from data another driver or a malformed record made', () => {
    expect(rulesOf({ provider: 'codex', summary: '', data: { rules: [{ toolName: 'Bash' }] } })).toEqual([])
    expect(rulesOf({ provider: 'claude-code', summary: '', data: 'Bash' })).toEqual([])
    expect(rulesOf({ provider: 'claude-code', summary: '', data: { rules: 'Bash' } })).toEqual([])
    expect(rulesOf({ provider: 'claude-code', summary: '', data: { rules: [7, { toolName: 3 }, { toolName: 'Edit', ruleContent: 5 }, { toolName: 'Bash' }, { toolName: 'Bash', ruleContent: 'rm:*' }, { toolName: 'Bash', ruleContent: 'ls' }] } }))
      .toEqual([{ toolName: 'Bash', ruleContent: 'ls' }])
    expect(rulesOf({ provider: 'claude-code', summary: '', data: { rules: [{ toolName: 'Bash', ruleContent: 'ls\nrm -rf /' }] } })).toEqual([])
    expect(allowedToolsFor([])).toEqual([])
  })
})
