/**
 * The environment an update's successor starts with: the predecessor's, without the variables that load code into a
 * Node or its dynamic loader, which the predecessor may have taken from a `.env` file after the launcher dropped them,
 * and without the record of the predecessor's own start check.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion, StartId } from '@delorun/contract-home-layout'
import { startSuccessor, successorEnvironment, type HandoverLine } from '../src/index.ts'
import { REPOSITORY } from './support.ts'

/** Variables a predecessor may hold that no successor inherits. */
const DROPPED = {
  NODE_OPTIONS: '--require /tmp/x.js',
  node_path: '/tmp/modules',
  OPENSSL_CONF: '/tmp/openssl.cnf',
  OPENSSL_MODULES: '/tmp/ossl',
  NODE_ICU_DATA: '/tmp/icu',
  NODE_COMPILE_CACHE: '/tmp/cache',
  GCONV_PATH: '/tmp/gconv',
  DYLD_INSERT_LIBRARIES: '/tmp/x.dylib',
  LD_LIBRARY_PATH: '/tmp/lib',
  DELORUN_START_CHECK: '{"schema":"delorun.start-check/1"}',
}

describe('the successor\'s environment', () => {
  it('drops the loader variables and the start-check record, and keeps the rest', () => {
    expect(successorEnvironment({ ...DROPPED, PATH: '/bin', DELORUN_LAUNCHER_ROOTS: '/launcher/roots', UNSET: undefined })).toEqual({ PATH: '/bin', DELORUN_LAUNCHER_ROOTS: '/launcher/roots' })
  })

  it('reaches a real successor without the dropped variables', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'delorun-successor-env-'))
    onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
    const out = join(directory, 'env.json')
    // Only the variables a process can carry without changing this test's own Node: no NODE_OPTIONS or loader paths.
    for (const name of ['OPENSSL_CONF', 'GCONV_PATH', 'DELORUN_START_CHECK'] as const) vi.stubEnv(name, DROPPED[name])
    vi.stubEnv('DELORUN_SUCCESSOR_PROBE', 'kept')
    onTestFinished(() => { vi.unstubAllEnvs() })
    const handover: HandoverLine = {
      type: 'handover', v: 1, home: directory, profile: 'default', from: brandString<RuntimeVersion>('0.1.0'), to: brandString<RuntimeVersion>('0.2.0'),
      startId: brandString<StartId>('a'.repeat(32)), health: { disabledPlugins: [], namedRows: [], previousFailures: [], previousRows: [] }, startedAt: '2026-11-11T00:00:00Z',
    }
    const script = `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env)); process.exit(0)`
    const successor = startSuccessor({ command: process.execPath, args: ['-e', script], cwd: REPOSITORY }, handover, 10_000)
    await successor.result
    await successor.stop()
    const seen = JSON.parse(readFileSync(out, 'utf8')) as Record<string, string>
    expect(seen['DELORUN_SUCCESSOR_PROBE']).toBe('kept')
    expect([seen['OPENSSL_CONF'], seen['GCONV_PATH'], seen['DELORUN_START_CHECK']]).toEqual([undefined, undefined, undefined])
  })
})
