/** What each record's card says: commands, searches, edits and the rest. */
import { describe, expect, it } from 'vitest'
import { isRecordName, toolCard } from '../src/client/tool-model.ts'

const done = (text: string, isError = false, seconds: number | null = 8.2) => ({ text, isError, seconds })

describe('seat record cards', () => {
  it('recognises only prefixed record names', () => {
    expect(isRecordName('claude_code.Bash')).toBe(true)
    expect(isRecordName('codex.commandExecution')).toBe(true)
    expect(isRecordName('bash')).toBe(false)
  })

  it('shows a command with its exit state and time', () => {
    const card = toolCard({ name: 'claude_code.Bash', argsRaw: '{"command":"pnpm vitest run"}', result: done('1 failed\nexit 1') })
    expect(card).toMatchObject({ kind: 'ran', subject: 'pnpm vitest run', state: 'failed', exitCode: 1, seconds: 8.2 })
  })

  it('shows a passing command as ok and a running one as running', () => {
    expect(toolCard({ name: 'codex.commandExecution', argsRaw: '{"command":"ls"}', result: done('a\nb') }).state).toBe('ok')
    expect(toolCard({ name: 'codex.commandExecution', argsRaw: '{"command":"ls"}', result: null }).state).toBe('running')
  })

  it('counts a search\'s matches and names where it looked', () => {
    const card = toolCard({ name: 'claude_code.Grep', argsRaw: '{"pattern":"toISOString","path":"src/export"}', result: done('a.ts:1\nb.ts:2\nc.ts:3') })
    expect(card).toMatchObject({ kind: 'searched', subject: 'toISOString', where: 'src/export', matches: 3 })
  })

  it('counts an edit\'s added and removed lines', () => {
    const card = toolCard({ name: 'claude_code.Edit', argsRaw: JSON.stringify({ file_path: 'src/a.ts', old_string: 'x', new_string: 'a\nb\nc' }), result: done('') })
    expect(card).toMatchObject({ kind: 'edited', subject: 'src/a.ts', diff: { added: 3, removed: 1 } })
  })

  it('falls back to a generic card for an unknown tool or unreadable arguments', () => {
    expect(toolCard({ name: 'claude_code.Task', argsRaw: '{"half', result: null })).toMatchObject({ kind: 'generic', subject: 'Task' })
    expect(toolCard({ name: 'claude_code.Bash', argsRaw: '[1]', result: null }).subject).toBe('Bash')
  })

  it('marks a tool error as failed without an exit code', () => {
    expect(toolCard({ name: 'codex.mcpToolCall', argsRaw: '{}', result: done('boom', true) }).state).toBe('failed')
  })

  it('reads the other argument names and program spellings of each look', () => {
    expect(toolCard({ name: 'codex.shell', argsRaw: '{"cmd":"ls -a"}', result: null })).toMatchObject({ kind: 'ran', subject: 'ls -a' })
    expect(toolCard({ name: 'claude_code.Bash', argsRaw: '{}', result: null }).subject).toBe('Bash')
    expect(toolCard({ name: 'claude_code.Glob', argsRaw: '{"query":"*.ts","glob":"src"}', result: null })).toMatchObject({ kind: 'searched', subject: '*.ts', where: 'src', matches: null })
    expect(toolCard({ name: 'codex.webSearch', argsRaw: '{"term":"vitest"}', result: null })).toMatchObject({ kind: 'searched', subject: 'vitest' })
    expect(toolCard({ name: 'codex.search', argsRaw: '{}', result: null })).toMatchObject({ kind: 'searched', subject: 'search', where: null })
    expect(toolCard({ name: 'claude_code.Write', argsRaw: '{"path":"b.ts","content":"one"}', result: null })).toMatchObject({ kind: 'edited', subject: 'b.ts', diff: { added: 1, removed: 0 } })
    expect(toolCard({ name: 'claude_code.MultiEdit', argsRaw: '{}', result: null })).toMatchObject({ kind: 'edited', subject: 'MultiEdit', diff: { added: 0, removed: 0 } })
    expect(toolCard({ name: 'codex.fileChange', argsRaw: '{"file_path":"c.ts","new_string":"","old_string":"a\\nb"}', result: null })).toMatchObject({ kind: 'edited', diff: { added: 0, removed: 2 } })
  })

  it('counts a search\'s non-empty output lines, and none for an empty output', () => {
    expect(toolCard({ name: 'claude_code.Grep', argsRaw: '{}', result: done('a\n\nb\n') }).matches).toBe(2)
    expect(toolCard({ name: 'claude_code.Grep', argsRaw: '{}', result: done('') }).matches).toBe(0)
  })

  it('reads an exit line in either spelling and fails only on a non-zero code', () => {
    expect(toolCard({ name: 'claude_code.Bash', argsRaw: '{}', result: done('ok\nexit code: 0') })).toMatchObject({ state: 'ok', exitCode: 0 })
    expect(toolCard({ name: 'claude_code.Bash', argsRaw: '{}', result: done('exit -2') })).toMatchObject({ state: 'failed', exitCode: -2 })
    expect(toolCard({ name: 'claude_code.Bash', argsRaw: '{}', result: done('no code') })).toMatchObject({ state: 'ok', exitCode: null })
  })

  it('keeps an unrecorded duration null and treats non-object JSON as no arguments', () => {
    expect(toolCard({ name: 'claude_code.Bash', argsRaw: '{}', result: done('x', false, null) }).seconds).toBeNull()
    expect(toolCard({ name: 'claude_code.Bash', argsRaw: 'null', result: null }).subject).toBe('Bash')
  })
})
