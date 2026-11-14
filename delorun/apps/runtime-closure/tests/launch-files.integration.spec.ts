/**
 * The closure the release build archives and the launcher's runtime store agree on what a launch needs: the build's list
 * of launch protocol 1's files equals the runtime store's, and the files of a closure the build accepts are the ones
 * the store's launch command names, for every platform.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RUNTIME_PLATFORMS } from '@delorun/contract-release-manifest'
import { launchFiles } from '@delorun/runtime-store'
import { launchProtocolFiles } from '../../release/src/closure/launch.ts'
import { archiveClosure } from '../../release/src/closure/archive-closure.ts'
import { readEnvelope } from '@delorun/release-formats/sign/schemas'
import { scratch, writeTree } from '../../release/tests/support.ts'

describe('launch protocol 1 files', () => {
  for (const platform of RUNTIME_PLATFORMS) {
    it(`are the same list in the release build and the runtime store for ${platform}`, () => {
      const store = launchFiles(platform)
      expect(launchProtocolFiles(platform)).toEqual([store.node, store.entry])
    })
  }

  it('are in the file list of a closure the build archives, so the store can build its launch command from it', async (test) => {
    const directory = scratch(test)
    const stage = join(directory, 'stage')
    writeTree(stage, {
      'node/bin/node': { data: '#!/bin/sh\n', executable: true },
      'app/node_modules/@delorun/cli/src/bin.js': 'console.log("delorun")\n',
    })
    const closure = await archiveClosure({ stage, outDir: directory, version: '0.1.0', platform: 'linux-x64', epoch: 1_793_981_656, pins: undefined, requireLaunchFiles: true })
    const listed = new Set(readEnvelope('files', readFileSync(join(directory, closure.files.name))).signed.files.map(file => file.path))
    for (const path of Object.values(launchFiles('linux-x64'))) expect(listed.has(path), path).toBe(true)
  })
})
