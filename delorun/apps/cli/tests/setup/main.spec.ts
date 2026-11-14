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
const { HomeProcessError } = await import('@delorun/home-process')

let osHome: string

beforeEach(() => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-main-')))
})

afterEach(() => {
  rmSync(osHome, { recursive: true, force: true })
})

describe('delorun on a new home', () => {
  it('reports a cancelled setup in one line, says nothing was saved, exits 130 and prints no stack', async () => {
    vi.mocked(runSetup).mockRejectedValueOnce(new SetupCancelled())
    const lines: string[] = []
    const code = await main([], { env: { DELORUN_HOME: join(osHome, '.delorun') }, stdout: text => void lines.push(text), stderr: text => void lines.push(text) })
    expect(code).toBe(EXIT.interrupted)
    expect(lines.join('')).toBe('Setup cancelled. Nothing was saved. Run delorun to start again.\n')
  })

  it('reports any other failure as what Delorun did, without a stack, and exits 1', async () => {
    const lines: string[] = []
    const context = { env: { DELORUN_HOME: join(osHome, '.delorun') }, stdout: (text: string) => void lines.push(text), stderr: (text: string) => void lines.push(text) }
    vi.mocked(runSetup).mockRejectedValueOnce(new TypeError('x is undefined'))
    expect(await main([], context)).toBe(EXIT.failed)
    expect(lines.join('')).toBe('Delorun stopped: x is undefined\n')
    lines.length = 0
    vi.mocked(runSetup).mockRejectedValueOnce(new HomeProcessError('ROLLBACK_NEEDS_DATA_COPY', 'the data differs and no copy exists'))
    expect(await main(['--profile', 'work'], context)).toBe(EXIT.failed)
    expect(lines.join('')).toBe([
      'Delorun did not roll back: going back would hand newer chat data to an older release, and no copy of the older data exists.',
      'Why: ROLLBACK_NEEDS_DATA_COPY: the data differs and no copy exists',
      'What you can do:',
      '  Restore the profile and keep this release: delorun recover rollback --profile-only --profile work',
      '  Start in safe mode: delorun recover safe-mode --profile work',
      '',
    ].join('\n'))
  })

  it('lists the setup sections in its help', async () => {
    const lines: string[] = []
    expect(await main(['--help'], { env: {}, stdout: text => void lines.push(text), stderr: () => undefined })).toBe(EXIT.ok)
    expect(lines.join('')).toContain('Set up Delorun by how you use it, or run one section again')
  })
})
