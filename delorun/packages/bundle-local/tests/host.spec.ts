/** The harness half prints Delorun's version and the DeepSeek Harness version into each page. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { DELORUN_VERSION_ENV, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { apply, harnessVersions } from '../src/index.ts'
import { VERSIONS_GLOBAL } from '../src/client/versions.ts'

describe('the versions', () => {
  it('names Delorun\'s version from delorun\'s variable and the harness version upstream reports', () => {
    expect(harnessVersions({ [DELORUN_VERSION_ENV]: '0.1.0' })).toEqual({ delorun: '0.1.0', dsh: getDshRuntimeVersion() })
  })

  it('names none for a harness that delorun did not start', () => {
    expect(harnessVersions({})).toBeUndefined()
    expect(harnessVersions({ [DELORUN_VERSION_ENV]: '' })).toBeUndefined()
  })
})

describe('the index injection', () => {
  it('prints the versions as the page global only when Delorun\'s version is known', async () => {
    const ctx = new Context()
    const previous = process.env[DELORUN_VERSION_ENV]
    try {
      await ctx.plugin({ apply }).await()
      const rows = (): IndexInjection[] => {
        const table: IndexInjection[] = []
        ctx.emit('webserver/index-inject', table, undefined as never)
        return table
      }
      process.env[DELORUN_VERSION_ENV] = '0.1.0'
      expect(rows()).toEqual([{ kind: 'global', name: VERSIONS_GLOBAL, value: { delorun: '0.1.0', dsh: getDshRuntimeVersion() } }])
      delete process.env[DELORUN_VERSION_ENV]
      expect(rows()).toEqual([])
    } finally {
      if (previous === undefined) delete process.env[DELORUN_VERSION_ENV]
      else process.env[DELORUN_VERSION_ENV] = previous
      await ctx.fiber.dispose()
    }
  })
})
