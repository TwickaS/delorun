import { describe, expect, it, vi } from 'vitest'
import { ADDED_CLAUDE_CODE_PERMISSION_MODE, CLAUDE_CODE_PACKAGE, setAddedAgentDefaults } from '../src/client/agent-defaults.ts'
import type { AgentRowSettings } from '../src/client/types.ts'
import { liveForm } from './fixtures.client.ts'

describe('what Delorun sets when it adds an agent', () => {
  it('gives an added Claude Code acceptEdits once its row is writable', async () => {
    const row = liveForm<AgentRowSettings>({})
    await setAddedAgentDefaults(CLAUDE_CODE_PACKAGE, row.form, 1000)
    expect(ADDED_CLAUDE_CODE_PERMISSION_MODE).toBe('acceptEdits')
    expect(row.set).toHaveBeenCalledExactlyOnceWith('permissionMode', 'acceptEdits')
  })

  it('leaves Codex and other packages alone', async () => {
    const row = liveForm<AgentRowSettings>({})
    await setAddedAgentDefaults('@deepseek-ai/dsh-subagent-codex', row.form, 1000)
    expect(row.set).not.toHaveBeenCalled()
  })

  it('logs and writes nothing when the row never becomes writable', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const row = liveForm<AgentRowSettings>({}, { writable: false })
      const done = setAddedAgentDefaults(CLAUDE_CODE_PACKAGE, row.form, 1000)
      await vi.advanceTimersByTimeAsync(1000)
      await done
      expect(row.set).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers(); warn.mockRestore() }
  })
})
