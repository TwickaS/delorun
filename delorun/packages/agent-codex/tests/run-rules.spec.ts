import type { ProgramRunRule } from '@delorun/external-agents/contract'
import { describe, expect, it } from 'vitest'
import { commandRunRule, ruleCovers, shellWords, type CommandQuestion } from '../src/run-rules.ts'

const ASKED: CommandQuestion = { threadId: 'thread-1', kind: 'command', command: "/bin/bash -lc 'touch a.txt'", cwd: '/work', environmentId: 'local' }

describe('shellWords', () => {
  it.each([
    ["/bin/bash -lc 'touch a.txt'", ['/bin/bash', '-lc', 'touch a.txt']],
    ['/bin/bash -lc touch a.txt', ['/bin/bash', '-lc', 'touch', 'a.txt']],
    ['echo "a \\"b\\" $c" d\\ e', ['echo', 'a "b" $c', 'd e']],
    ["echo ''", ['echo', '']],
    ["a'b'\"c\"", ['abc']],
    ['', []],
  ])('splits %j', (command, words) => {
    expect(shellWords(command)).toEqual(words)
  })

  it.each(["echo 'open", 'echo "open', 'echo \\'])('refuses %j', (command) => {
    expect(shellWords(command)).toBeUndefined()
  })
})

describe('commandRunRule', () => {
  it('holds the thread, the argv, the folder and the environment, with the command as its summary', () => {
    expect(commandRunRule(ASKED)).toEqual({
      provider: 'codex',
      summary: "/bin/bash -lc 'touch a.txt'",
      data: { kind: 'command', threadId: 'thread-1', argv: ['/bin/bash', '-lc', 'touch a.txt'], cwd: '/work', environmentId: 'local' },
    })
  })

  it.each<[string, Partial<CommandQuestion>]>([
    ['input to a running terminal', { kind: 'writeStdin' }],
    ['a sub-command callback', { approvalId: 'b5a1' }],
    ['an escalation reason', { reason: 'Needs network access.' }],
    ['a network question', { networkApprovalContext: { host: 'example.com' } }],
    ['a network amendment', { proposedNetworkPolicyAmendments: [{ host: 'example.com', action: 'allow' }] }],
    ['no command', { command: null }],
    ['an empty command', { command: '   ' }],
    ['an unclosed quote', { command: "bash -lc 'touch" }],
    ['no folder', { cwd: null }],
  ])('offers none for %s', (_name, change) => {
    expect(commandRunRule({ ...ASKED, ...change })).toBeUndefined()
  })
})

describe('ruleCovers (D4)', () => {
  const rule = commandRunRule(ASKED) as ProgramRunRule

  it('covers the identical question', () => {
    expect(ruleCovers(rule, { ...ASKED })).toBe(true)
  })

  it.each<[string, Partial<CommandQuestion>]>([
    ['another folder', { cwd: '/work/sub' }],
    ['another argv split of the same text', { command: '/bin/bash -lc touch a.txt' }],
    ['another command', { command: "/bin/bash -lc 'touch b.txt'" }],
    ['another shell', { command: "/bin/zsh -lc 'touch a.txt'" }],
    ['an extra argument', { command: "/bin/bash -lc 'touch a.txt' x" }],
    ['another thread', { threadId: 'thread-2' }],
    ['another environment', { environmentId: 'remote' }],
    ['an escalation reason', { reason: 'Needs to write outside the workspace.' }],
    ['a network question', { networkApprovalContext: { host: 'example.com' } }],
    ['input to a running terminal', { kind: 'writeStdin' }],
  ])('does not cover %s', (_name, change) => {
    expect(ruleCovers(rule, { ...ASKED, ...change })).toBe(false)
  })

  it('ignores a rule of another driver or with data it did not write', () => {
    expect(ruleCovers({ ...rule, provider: 'claude-code' }, ASKED)).toBe(false)
    expect(ruleCovers({ ...rule, data: { kind: 'command', command: "/bin/bash -lc 'touch a.txt'", cwd: '/work' } }, ASKED)).toBe(false)
    expect(ruleCovers({ ...rule, data: { kind: 'command', threadId: 'thread-1', argv: [], cwd: '/work', environmentId: 'local' } }, ASKED)).toBe(false)
  })
})
