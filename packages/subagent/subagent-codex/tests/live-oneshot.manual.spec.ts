import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'
import { startExternalActivation } from '../../subagent/tests/external-activation-helpers.ts'
import { appendFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as codex from '../src/index.ts'

/**
 * Manual live check against the person's own Codex sign-in; never part of a normal run.
 * `P2_CODEX_LIVE=<task folder>` runs it, appending the result to `P2_CODEX_LOG`, with `P2_CODEX_MODEL` optionally fixing the model.
 */
const folder = process.env.P2_CODEX_LIVE
const log = process.env.P2_CODEX_LOG as string
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

describe.skipIf(folder === undefined)('live one-shot Codex run', () => {
  it('runs one tiny task and prints the result', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(codex, {
      env: { HOME: process.env.HOME as string },
      permissionMode: 'approve-for-me',
      ...process.env.P2_CODEX_MODEL === undefined ? {} : { model: process.env.P2_CODEX_MODEL },
      disposeGraceMs: 3_000,
    })
    const parent = { id: 'live-parent', session: { header: { cwd: folder } } } as unknown as Agent
    try {
      const run = await startExternalActivation(ctx, 'codex', {
        prompt: [{ type: 'text', text: 'Create a file named hello.txt containing the single word hi, then reply done.' }],
        parent,
        signal: AbortSignal.timeout(240_000),
      })
      const result = await run.result
      appendFileSync(log, `RESULT ${JSON.stringify(result)}\n`)
      await run.dispose()
    } catch (error: unknown) {
      appendFileSync(log, `START FAILURE ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }, 300_000)
})
