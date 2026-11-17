/**
 * The real Codex limits check: one "Check now" through the gate over the pinned Codex, under the person's own sign-in.
 * The Codex launcher is found beside upstream's Codex package in the repository, since a source checkout has no profile
 * with the pack added.
 *
 *   node --import tsx/esm delorun/packages/agent-codex/live/limits.ts
 * @module @delorun/agent-codex/live/limits
 */
import { join } from 'node:path'
import { locatePackage, type LocatedCodex } from '@delorun/external-agents/locate'
import { runLimitsCheck } from '../../external-agents/live/limits-check.ts'
import { CodexDriver } from '../src/driver.ts'
import { REPO } from './common.ts'

/**
 * @returns the pinned Codex launcher from upstream's Codex package.
 */
function pinned(): LocatedCodex {
  const upstream = join(REPO, 'packages/subagent/subagent-codex/package.json')
  const codex = locatePackage(upstream, '@openai/codex')
  if (codex === undefined) throw new Error('@openai/codex is not installed beside upstream\'s Codex package')
  return { ...codex, script: join(codex.directory, 'bin', 'codex.js') }
}

process.exitCode = await runLimitsCheck(new CodexDriver({
  locate: pinned, requestTimeoutMs: 120_000, closeWaitMs: 5_000, harnessToolTimeoutSeconds: 900, level: 'standard', onLateHarnessResult: () => {},
}))
