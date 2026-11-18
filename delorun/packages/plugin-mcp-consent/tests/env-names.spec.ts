/** The environment names the consent shows are the names the mcp-client refuses to fill from a credential. */
import { isRunAffectingEnv } from '@deepseek-ai/dsh-mcp-client/templates'
import { describe, expect, it } from 'vitest'
import { showsEnvValue } from '../src/review.ts'

describe('run-affecting environment names', () => {
  it('match between the consent and the mcp-client template rule', () => {
    const names = ['NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PATH', 'PYTHONPATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_', 'path', 'XDYLD_X', 'TOKEN', 'HOME', 'PYTHONHOME', 'LD_AUDIT', 'BASH_ENV', 'NODE_PATH', 'GCONV_PATH', 'OPENSSL_CONF', 'JAVA_TOOL_OPTIONS', 'PERL5LIB', 'RUBYLIB', 'ENV', 'API_TOKEN']
    for (const name of names) expect(isRunAffectingEnv(name), name).toBe(showsEnvValue(name))
  })

  it('show the value of every name that loads code or a startup script, and keep other values hidden', () => {
    // Pins the shared list: each of these names loads code before the server's first line runs.
    for (const name of ['LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV', 'ENV', 'NODE_PATH', 'PYTHONHOME', 'PERL5LIB', 'RUBYOPT', 'OPENSSL_CONF', 'GCONV_PATH', 'JAVA_TOOL_OPTIONS']) {
      expect(showsEnvValue(name), name).toBe(true)
    }
    for (const name of ['API_TOKEN', 'HOME', 'LANGUAGE', 'ENVIRONMENT', 'PATHS']) expect(showsEnvValue(name), name).toBe(false)
  })
})
