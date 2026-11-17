/**
 * The Claude Agent SDK as upstream's Claude Code package brings it, for specs. Its `package.json` is not exported, so
 * the folder is found from the entry.
 * @module @delorun/agent-claude-code/tests/locate-sdk
 */
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The worktree root. */
export const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

/**
 * Find the SDK upstream's package pins.
 * @returns its entry file and version.
 */
export function locateSdk(): { entry: string, version: string } {
  const entry = realpathSync(createRequire(join(REPO, 'packages/subagent/subagent-claude-code/package.json')).resolve('@anthropic-ai/claude-agent-sdk'))
  const manifest = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')) as { version: string }
  return { entry, version: manifest.version }
}
