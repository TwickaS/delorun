/** The environment names the consent shows are the names the mcp-client refuses to fill from a credential. */
import { isRunAffectingEnv } from '@deepseek-ai/dsh-mcp-client'
import { describe, expect, it } from 'vitest'
import { showsEnvValue } from '../src/wire.ts'

describe('run-affecting environment names', () => {
  it('match between the consent and the mcp-client template rule', () => {
    const names = ['NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PATH', 'PYTHONPATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_', 'path', 'XDYLD_X', 'TOKEN', 'HOME', 'PYTHONHOME']
    for (const name of names) expect(isRunAffectingEnv(name), name).toBe(showsEnvValue(name))
  })
})
