/**
 * `compare-rebuild.ts <first> <second>` over two outputs of the closure build (contract C2's
 * `c02-rebuild-difference-blocks-signing`, comparison half): it exits 0 when the outputs differ only where the
 * committed `rebuild-exceptions.json` accepts it, and 1 on any other difference, naming each one.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, type TestContext } from 'vitest'
import type { RuntimePlatform } from '@delo/contract-release-manifest'
import { archiveClosure } from '../../src/closure/archive-closure.ts'
import { readImagesRecipe } from '../../src/images/build.ts'
import { readRecipe } from '../../src/closure/config.ts'
import { compareOutputs } from '../../src/rebuild/compare.ts'
import { derSequence, peImage, runEntry, scratch, signPe, winCertificate, writeTree, type StagedContent } from '../support.ts'

const EPOCH = 1_793_981_656
const HELPER = 'app/node_modules/node-pty/prebuilds/win32-x64/conpty.node'
const UNSIGNED = peImage(Buffer.from('code section bytes'))

function tree(helper: Buffer, extra: Readonly<Record<string, StagedContent>> = {}): Record<string, StagedContent> {
  return {
    'node/node.exe': peImage(Buffer.from('node executable')),
    'app/package.json': '{"name":"@deepseek-ai/dsh"}\n',
    'app/lib/bin.js': '#!/usr/bin/env node\n',
    [HELPER]: helper,
    ...extra,
  }
}

async function output(test: TestContext, platform: RuntimePlatform, files: Readonly<Record<string, StagedContent>>): Promise<string> {
  const directory = scratch(test)
  const out = join(directory, 'out')
  mkdirSync(out)
  writeTree(join(directory, 'stage'), files)
  await archiveClosure({ stage: join(directory, 'stage'), outDir: out, version: '0.1.0', platform, epoch: EPOCH, pins: undefined })
  return out
}

/** Each case builds two outputs and runs the command as a child process, which a loaded host slows. */
const CHILD_PROCESS_TIMEOUT = { timeout: 60_000 }

describe('compare-rebuild', CHILD_PROCESS_TIMEOUT, () => {
  it('exits 0 for two outputs built from the same files in different directories', async (test) => {
    const first = await output(test, 'linux-x64', tree(UNSIGNED))
    const second = await output(test, 'linux-x64', tree(UNSIGNED))
    const result = runEntry('compare-rebuild.ts', [first, second])
    expect(result.stdout).toMatch(/compare-rebuild: match over 2 files, 0 differences accepted/u)
    expect(result.status).toBe(0)
  })

  it('exits 0 when a PE file differs only by its Authenticode signature, naming the exception', async (test) => {
    const released = await output(test, 'win32-x64', tree(signPe(UNSIGNED, winCertificate(derSequence(Buffer.from('certificate table from the release workflow'))), 0x1234)))
    const rebuilt = await output(test, 'win32-x64', tree(UNSIGNED))
    const result = runEntry('compare-rebuild.ts', [released, rebuilt])
    expect(result.stdout).toContain(`accepted: delorun-0.1.0-win32-x64.zip: ${HELPER} (rebuild exception pe-authenticode)`)
    expect(result.status).toBe(0)
  })

  it('exits 1 when a signed PE file also differs in its code', async (test) => {
    const released = await output(test, 'win32-x64', tree(signPe(peImage(Buffer.from('code section bytEs')), winCertificate(derSequence(Buffer.from('certificate'))), 1)))
    const rebuilt = await output(test, 'win32-x64', tree(UNSIGNED))
    const result = runEntry('compare-rebuild.ts', [released, rebuilt])
    expect(result.stdout).toContain(`differs: delorun-0.1.0-win32-x64.zip: ${HELPER}: content differs`)
    expect(result.stdout).toMatch(/signing refuses this rebuild/u)
    expect(result.status).toBe(1)
  })

  it('exits 1 on one changed byte in a file, naming the archive entry', async (test) => {
    const first = await output(test, 'darwin-arm64', tree(UNSIGNED))
    const second = await output(test, 'darwin-arm64', tree(UNSIGNED, { 'app/lib/bin.js': '#!/usr/bin/env nodE\n' }))
    const result = runEntry('compare-rebuild.ts', [first, second])
    expect(result.stdout).toContain('differs: delorun-0.1.0-darwin-arm64.tar.gz: app/lib/bin.js: content differs (20 and 20 bytes)')
    expect(result.status).toBe(1)
  })

  it('exits 1 on a changed mode, an added entry and a file only one output has', async (test) => {
    const first = await output(test, 'linux-arm64', tree(UNSIGNED))
    const second = await output(test, 'linux-arm64', tree(UNSIGNED, { 'app/lib/bin.js': { data: '#!/usr/bin/env node\n', executable: true }, 'app/extra.js': '' }))
    writeFileSync(join(second, 'delorun-0.1.0.spdx.json'), '{}\n')
    const result = runEntry('compare-rebuild.ts', [first, second])
    expect(result.stdout).toContain('differs: delorun-0.1.0-linux-arm64.tar.gz: app/extra.js: only in the second output')
    expect(result.stdout).toContain('differs: delorun-0.1.0-linux-arm64.tar.gz: app/lib/bin.js: mode 0644 differs from 0755')
    expect(result.stdout).toContain('differs: delorun-0.1.0.spdx.json: only in the second output')
    expect(result.status).toBe(1)
  })

  it('exits 1 when an archive is not in the deterministic form, even with the same entries', async (test) => {
    const first = await output(test, 'linux-x64', tree(UNSIGNED))
    const second = await output(test, 'linux-x64', tree(UNSIGNED))
    const archive = join(second, 'delorun-0.1.0-linux-x64.tar.gz')
    const bytes = readFileSync(archive)
    bytes[9] = 0x03
    writeFileSync(archive, bytes)
    const result = runEntry('compare-rebuild.ts', [first, second])
    expect(result.stdout).toContain('differs: delorun-0.1.0-linux-x64.tar.gz: second: the archive is not in the deterministic form')
    expect(result.status).toBe(1)
  })

  it('exits 1 when a file list does not equal the list derived from its archive', async (test) => {
    const first = await output(test, 'linux-x64', tree(UNSIGNED))
    const second = await output(test, 'linux-x64', tree(UNSIGNED))
    const list = join(second, 'delorun-0.1.0-linux-x64.files.json')
    const text = readFileSync(list, 'utf8')
    const sha = createHash('sha256').update('#!/usr/bin/env node\n').digest('hex')
    writeFileSync(list, text.replace(sha, '0'.repeat(64)))
    const result = runEntry('compare-rebuild.ts', [first, second])
    expect(result.stdout).toContain('differs: delorun-0.1.0-linux-x64.files.json: second: it does not equal the file list derived from its archive')
    expect(result.status).toBe(1)
  })

  it('exits 1 when one output lacks a platform the other has', async (test) => {
    const first = await output(test, 'linux-x64', tree(UNSIGNED))
    const second = await output(test, 'linux-x64', tree(UNSIGNED))
    renameSync(join(second, 'delorun-0.1.0-linux-x64.tar.gz'), join(second, 'unrelated.bin'))
    const result = runEntry('compare-rebuild.ts', [first, second])
    expect(result.stdout).toContain('differs: delorun-0.1.0-linux-x64.tar.gz: only in the first output')
    expect(result.stdout).toContain('differs: delorun-0.1.0-linux-x64.files.json: second: its archive delorun-0.1.0-linux-x64.tar.gz is missing')
    expect(result.status).toBe(1)
  })

  it('exits 1 when a PE file in a Linux or macOS archive differs only by a signature, which the exception does not cover there', async (test) => {
    const released = await output(test, 'linux-x64', tree(signPe(UNSIGNED, winCertificate(derSequence(Buffer.from('certificate'))), 1)))
    const rebuilt = await output(test, 'linux-x64', tree(UNSIGNED))
    const result = runEntry('compare-rebuild.ts', [released, rebuilt])
    expect(result.stdout).toContain(`differs: delorun-0.1.0-linux-x64.tar.gz: ${HELPER}: content differs`)
    expect(result.status).toBe(1)
  })

  it('exits 1 when bytes appended after a PE image do not form an Authenticode certificate table', async (test) => {
    const rebuilt = await output(test, 'win32-x64', tree(UNSIGNED))
    for (const table of [Buffer.from('appended bytes, not a certificate table'), winCertificate(derSequence(Buffer.from('certificate')), 0x0100), winCertificate(derSequence(Buffer.from('certificate')), 0x0200, 0x0001), Buffer.concat([winCertificate(derSequence(Buffer.from('certificate'))), Buffer.from('trailing bytes')])]) {
      const released = await output(test, 'win32-x64', tree(signPe(UNSIGNED, table, 1)))
      const result = runEntry('compare-rebuild.ts', [released, rebuilt])
      expect(result.stdout).toContain(`differs: delorun-0.1.0-win32-x64.zip: ${HELPER}: content differs`)
      expect(result.status).toBe(1)
    }
  })

  it('exits 1 when a certificate entry holds anything but one DER SEQUENCE, or non-zero padding', async (test) => {
    const rebuilt = await output(test, 'win32-x64', tree(UNSIGNED))
    const signature = derSequence(Buffer.from('certificate'))
    const tables = [
      winCertificate(Buffer.from('#!/bin/sh\necho payload\n')),
      winCertificate(Buffer.concat([signature, Buffer.from('#!/bin/sh\necho payload\n')])),
      winCertificate(Buffer.concat([signature, Buffer.alloc(8)])),
      winCertificate(signature.subarray(0, signature.byteLength - 1)),
      winCertificate(Buffer.concat([Buffer.from([0x30, 0x81, 0x0b]), Buffer.from('certificate')])),
      winCertificate(Buffer.concat([Buffer.from([0x30, 0x82, 0x00, 0x8c]), Buffer.alloc(0x8c, 7)])),
      winCertificate(Buffer.concat([signature, Buffer.from([1, 2, 3])])),
      winCertificate(signature, 0x0200, 0x0002, 0x41),
    ]
    for (const table of tables) {
      const released = await output(test, 'win32-x64', tree(signPe(UNSIGNED, table, 1)))
      const result = runEntry('compare-rebuild.ts', [released, rebuilt])
      expect(result.stdout).toContain(`differs: delorun-0.1.0-win32-x64.zip: ${HELPER}: content differs`)
      expect(result.status).toBe(1)
    }
    const long = await output(test, 'win32-x64', tree(signPe(UNSIGNED, winCertificate(Buffer.concat([derSequence(Buffer.alloc(300, 7)), Buffer.alloc(3)])), 1)))
    expect(runEntry('compare-rebuild.ts', [long, rebuilt]).status).toBe(0)
  })

  it('exits 1 when two archives hold the same files with a different mtime', async (test) => {
    const first = await output(test, 'linux-x64', tree(UNSIGNED))
    const directory = scratch(test)
    writeTree(join(directory, 'stage'), tree(UNSIGNED))
    await archiveClosure({ stage: join(directory, 'stage'), outDir: directory, version: '0.1.0', platform: 'linux-x64', epoch: EPOCH + 2, pins: undefined })
    const result = runEntry('compare-rebuild.ts', [first, directory])
    expect(result.stdout).toContain(`differs: delorun-0.1.0-linux-x64.tar.gz: entry mtime ${String(EPOCH)} differs from ${String(EPOCH + 2)}`)
    expect(result.status).toBe(1)
  })

  it('exits 2 without two directories', () => {
    expect(runEntry('compare-rebuild.ts', ['only-one']).status).toBe(2)
  })

  it('accepts no PE difference when the exceptions list none', async (test) => {
    const released = await output(test, 'win32-x64', tree(signPe(UNSIGNED, winCertificate(derSequence(Buffer.from('certificate'))), 1)))
    const rebuilt = await output(test, 'win32-x64', tree(UNSIGNED))
    const comparison = await compareOutputs(released, rebuilt, { ...readRecipe(), exceptions: { schema: 'delo.rebuild-exceptions/1', exceptions: [] }, images: readImagesRecipe() })
    expect(comparison.differences.map(item => item.entry)).toEqual([HELPER])
    expect(comparison.accepted).toEqual([])
  })
})

describe('rebuild-exceptions.json', () => {
  it('lists the PE Authenticode comparison first, and every exception with its reason', () => {
    const { exceptions } = readRecipe()
    expect(exceptions.exceptions[0]?.applies).toBe('pe')
    for (const exception of exceptions.exceptions) expect(exception.reason.length).toBeGreaterThanOrEqual(20)
  })
})
