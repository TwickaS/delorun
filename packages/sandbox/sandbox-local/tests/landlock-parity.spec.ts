/**
 * Without a protected home the Landlock grants are upstream's spelling for spelling: `/tmp` is passed as written,
 * even where it resolves elsewhere, while a protected profile grants the resolved path that the launcher opens without
 * following links. The sandbox package is mocked so `/tmp` resolves to another spelling on any host.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-sandbox', async (importOriginal) => {
  const original = await importOriginal<typeof import('@deepseek-ai/dsh-sandbox')>()
  return { ...original, canonicalPath: (path: string) => path === '/tmp' ? '/private/tmp' : original.canonicalPath(path) }
})

const { NO_PROTECTION, landlockProfileArgs } = await import('../src/profiles.ts')

describe('Landlock grants and /tmp', () => {
  it('passes /tmp as written without protection, and resolved with it', () => {
    const policy = { mode: 'workspace-write', workspaceRoot: '/nonexistent-workspace' } as const
    expect(landlockProfileArgs(policy, NO_PROTECTION)).toEqual(['--ro', '/', '--rw', '/dev/null', '--rw', '/tmp', '--rw', '/nonexistent-workspace'])
    const protectedArgs = landlockProfileArgs(policy, { ...NO_PROTECTION, home: '/nonexistent-home/h' })
    const writable = protectedArgs.flatMap((arg, index) => arg === '--rw' ? [protectedArgs[index + 1]] : [])
    expect(writable).toContain('/private/tmp')
    expect(writable).not.toContain('/tmp')
  })
})
