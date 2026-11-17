/**
 * A pack's imports resolve through symlinks to the release's runtime (Node's default realpath behaviour). A launcher
 * that set `--preserve-symlinks` or `NODE_PRESERVE_SYMLINKS` would resolve them from the link's own path and break
 * every installed pack, so neither the launch command nor the source that builds it may name either.
 */
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { launchCommand } from '../src/launch.ts'
import { StorePaths } from '../src/paths.ts'
import { parseRuntimeVersion } from '../src/paths.ts'
import { PLATFORM, REPOSITORY } from './support.ts'

describe('launching a runtime that has packs', () => {
  it('passes neither --preserve-symlinks nor NODE_PRESERVE_SYMLINKS to Node', () => {
    const command = launchCommand(new StorePaths('/home/test/.delorun', PLATFORM), parseRuntimeVersion('0.1.0')!, 'default', ['start'])
    expect(command.args.join(' ')).not.toMatch(/preserve-symlinks/u)
    expect(Object.keys(command.env)).not.toContain('NODE_PRESERVE_SYMLINKS')
    expect(Object.keys(command.env)).not.toContain('NODE_OPTIONS')
  })

  it('names the flag nowhere in the launcher, the supervisor or the Host\'s source', () => {
    const grep = spawnSync('git', ['grep', '-il', '-e', 'preserve-symlinks', '-e', 'PRESERVE_SYMLINKS', '--', 'delorun/packages/*/src', 'delorun/apps/*/src', 'packages/*/*/src'], { cwd: REPOSITORY, encoding: 'utf8' })
    // git grep exits 1 when nothing matches.
    expect({ status: grep.status, found: grep.stdout.trim() }).toEqual({ status: 1, found: '' })
  })
})
