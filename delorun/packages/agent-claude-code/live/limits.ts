/**
 * The real Claude Code limits check: one "Check now" through the gate over the pinned Agent SDK, under the person's
 * own sign-in.
 *
 *   node --import tsx/esm delorun/packages/agent-claude-code/live/limits.ts
 * @module @delorun/agent-claude-code/live/limits
 */
import { runLimitsCheck } from '../../external-agents/live/limits-check.ts'
import { driver } from './common.ts'

process.exitCode = await runLimitsCheck(driver())
