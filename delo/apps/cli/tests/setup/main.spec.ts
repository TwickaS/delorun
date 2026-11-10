import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXIT } from '../../src/exit.ts'

vi.mock('../../src/setup/index.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/setup/index.ts')>(),
  runSetup: vi.fn(),
}))

const { main } = await import('../../src/main.ts')
const { runSetup } = await import('../../src/setup/index.ts')
const { SetupCancelled } = await import('../../src/setup/prompts.ts')

let osHome: string

beforeEach(() => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-main-')))
})

afterEach(() => {
  rmSync(osHome, { recursive: true, force: true })
})

describe('delorun on a new home', () => {
  it('reports a cancelled setup in one line, with the failure code and no stack', async () => {
    vi.mocked(runSetup).mockRejectedValueOnce(new SetupCancelled())
    const lines: string[] = []
    const code = await main([], { env: { DELO_HOME: join(osHome, '.delo') }, stdout: text => void lines.push(text), stderr: text => void lines.push(text) })
    expect(code).toBe(EXIT.failed)
    expect(lines.join('')).toBe('delorun setup: cancelled\n')
  })

  it('lists the setup sections in its help', async () => {
    const lines: string[] = []
    expect(await main(['--help'], { env: {}, stdout: text => void lines.push(text), stderr: () => undefined })).toBe(EXIT.ok)
    expect(lines.join('')).toContain('Set up Delorun (Quick or Full), or run one section again')
  })
})
