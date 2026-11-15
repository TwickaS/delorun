/**
 * Specs of what an allowed start is spawned with and checked against: the arguments that name pinned files written
 * by their canonical paths, and the check that pins the files again just before the spawn.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServerCommand } from '@deepseek-ai/dsh-mcp-client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { changedPin, pinsOf, spawnArgsOf, type PinnedStart } from '../src/pins.ts'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-mcp-spawn-pins-')))
  mkdirSync(join(root, 'real'))
  writeFileSync(join(root, 'real', 'server.js'), 'console.log("accepted")\n')
  writeFileSync(join(root, 'tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  symlinkSync(join(root, 'real', 'server.js'), join(root, 'link.js'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * Pin a start that runs `tool` with the arguments.
 * @param args - the configured arguments.
 * @returns the pinned start.
 */
async function pinned(args: readonly string[]): Promise<PinnedStart> {
  const command: McpServerCommand = { serverName: 'srv', command: 'tool', args, env: {}, cwd: '', resolvedCommand: join(root, 'tool'), resolvedCwd: root }
  return { ...command, files: await pinsOf(command) }
}

describe('the arguments an allowed start is spawned with', () => {
  it('write a pinned file by its canonical path, whether the argument is the path or an option value', async () => {
    const start = await pinned(['link.js', '--import=./link.js', '--verbose', 'plain'])
    // Pins the canonical rewrite: a link retargeted after the review would otherwise change the file that is opened.
    expect(await spawnArgsOf(start)).toEqual([join(root, 'real', 'server.js'), `--import=${join(root, 'real', 'server.js')}`, '--verbose', 'plain'])
  })
})

describe('the check just before the spawn', () => {
  it('finds nothing while the pinned files match', async () => {
    expect(await changedPin((await pinned(['link.js'])).files)).toBeUndefined()
  })

  it('names a file rewritten after the review, and one that is gone', async () => {
    const start = await pinned(['link.js'])
    writeFileSync(join(root, 'real', 'server.js'), 'console.log("swapped")\n')
    // Pins the digest recheck: the file the person accepted is not the file that would run.
    expect(await changedPin(start.files)).toBe(`the file ${JSON.stringify(join(root, 'real', 'server.js'))} changed after the review`)
    rmSync(join(root, 'real', 'server.js'))
    expect(await changedPin(start.files)).toContain('does not exist')
  })
})
