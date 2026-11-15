import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startFailure } from '../src/start.ts'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'delorun-start-failure-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function logWith(text: string): string {
  const log = join(directory, 'home.log')
  writeFileSync(log, `${text}\n`)
  return log
}

describe('startFailure', () => {
  it('names the build commands when the log says a built lib/ file is missing', () => {
    const report = startFailure('default', 'Delorun stopped with exit code 1 before it was running', logWith("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/src/lib/typert.host.js' imported from /src/x.js"))
    expect(report).toContain('pnpm run build:artifacts')
  })

  it('adds no build hint for another failure', () => {
    const report = startFailure('default', 'Delorun stopped with exit code 1 before it was running', logWith('something else went wrong'))
    expect(report).not.toContain('build:artifacts')
    expect(report).toContain('Run delorun logs to see why')
  })
})
