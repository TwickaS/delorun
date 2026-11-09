/**
 * The report as a Cordis service: one build at a time, a second request for the same version joining the build that
 * runs, the version checked before anything is read, and a disposed context returning no report at all.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { UpdateReportError, UpdateReportService, type ReportSources } from '../src/index.ts'
import { GENERATED, target, sources } from './support.ts'

/** The mounted services the specs dispose. */
const mounted: { dispose: () => Promise<void> }[] = []

afterEach(async () => {
  for (const fiber of mounted.splice(0)) await fiber.dispose()
})

/**
 * Mount the service over the sources.
 * @param overrides - the readers to replace.
 * @returns the context, the service and the fiber that disposes it.
 */
async function mount(overrides: Partial<ReportSources> = {}): Promise<{ ctx: Context, service: UpdateReportService, fiber: { dispose: () => Promise<void> } }> {
  const ctx = new Context()
  const fiber = await ctx.plugin(UpdateReportService, { installation: 'cli-home', sources: sources(overrides) })
  mounted.push(fiber)
  return { ctx, service: ctx.updateReport, fiber }
}

describe('UpdateReportService', () => {
  it('builds the report and the plugin ids it disables', async () => {
    const { service } = await mount()
    const built = await service.build('1.0.0')
    expect(built.report.installation).toBe('cli-home')
    expect(built.report.generated).toBe(GENERATED)
    expect(built.disabledPlugins).toEqual(['bridge', 'calendar', 'legacy-x', 'old-exempt', 'revoked-plugin', 'weird'])
  })

  it('refuses a version that is not a semantic version before it reads anything', async () => {
    let reads = 0
    const { service } = await mount({ running: async () => { reads += 1; return sources().running() } })
    await expect(service.build('1.0')).rejects.toThrow(UpdateReportError)
    await expect(service.build('1.0')).rejects.toThrow('not a semantic version')
    expect(reads).toBe(0)
  })

  it('joins a second request for the version already building', async () => {
    let reads = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const { service } = await mount({
      running: async () => { reads += 1; await gate; return sources().running() },
    })
    const first = service.build('1.0.0')
    const second = service.build('1.0.0')
    release()
    const [left, right] = await Promise.all([first, second])
    expect(reads).toBe(1)
    expect(left.report).toBe(right.report)
  })

  it('builds one report at a time, so a second version waits for the first', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const { service } = await mount({
      target: async version => { order.push(version); await gate; return target() },
    })
    const first = service.build('1.0.0')
    const second = service.build('1.0.1')
    await Promise.resolve()
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['1.0.0', '1.0.1'])
  })

  it('returns no report from a disposed context', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const { service, fiber } = await mount({ target: async () => { await gate; return target() } })
    const pending = service.build('1.0.0')
    await fiber.dispose()
    release()
    await expect(pending).rejects.toThrow('REPORT_DISPOSED')
    await expect(service.build('1.0.0')).rejects.toThrow('REPORT_DISPOSED')
  })

  it('refuses a disposed context with its own failure, not with the target it happened to read', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    // The facts that arrive after the disposal would make the builder refuse the target; the context's disposal comes first.
    const { service, fiber } = await mount({ target: async () => { await gate; return target({ release: { ...target().release, signature: 'failed' } }) } })
    const pending = service.build('1.0.0')
    await fiber.dispose()
    release()
    const failure = await pending.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(UpdateReportError)
    expect((failure as UpdateReportError).code).toBe('REPORT_DISPOSED')
  })
})
