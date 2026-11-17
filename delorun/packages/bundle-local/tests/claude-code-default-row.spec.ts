/** The Claude Code pack's row starts with edits accepted, and a value the person set in the profile's own patch wins. */
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { composeEntries, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { DELORUN_PROFILE_BUNDLES } from '../src/profile.ts'
import { createTestHome, DELORUN_PROFILE, INSTALL_ANCHOR, type TestHome } from './profiles.ts'

const CLAUDE = '@deepseek-ai/dsh-subagent-claude-code'
const CLAUDE_DIR = fileURLToPath(new URL('../../../../packages/subagent/subagent-claude-code/', import.meta.url))

let home: TestHome | undefined
afterEach(() => { home?.remove(); home = undefined })

function withClaudeBundle(): TestHome {
  const made = createTestHome()
  const profile = join(made.dir, 'profiles', DELORUN_PROFILE)
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
  manifest.dsh.profile.bundles = [...DELORUN_PROFILE_BUNDLES, CLAUDE]
  writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest))
  const link = join(profile, 'node_modules', CLAUDE)
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(CLAUDE_DIR, link, 'junction')
  home = made
  return made
}

/** The row as boot composes it: the bundles' layers, then the profile's own patch. */
const rowOf = (made: TestHome) => {
  const profile = loadProfileDirectory('dsh', join(made.dir, 'profiles', DELORUN_PROFILE), INSTALL_ANCHOR)
  return composeEntries([...profile.layers.map(layer => layer.patches), profile.patches]).find(row => row.id === 'subagent-claude-code')
}

describe('the Claude Code pack\'s row', () => {
  it('starts with edits accepted, whichever way the plugin was added', () => {
    expect(rowOf(withClaudeBundle())?.config).toMatchObject({ permissionMode: 'acceptEdits' })
  })

  it('keeps a value the person set in the profile\'s own patch, which is read after the bundle\'s', () => {
    const made = withClaudeBundle()
    writeFileSync(join(made.dir, 'profiles', DELORUN_PROFILE, 'cordis.patch.yml'), '- id: subagent-claude-code\n  config:\n    permissionMode: plan\n')
    expect(rowOf(made)?.config).toMatchObject({ permissionMode: 'plan' })
  })
})
