/**
 * Specs of the files an accepted MCP server start is pinned to: the pins that follow every symbolic link and hash the
 * executable and each file an argument names, and the denial cases of the add-time consent — a
 * rewritten executable, a retargeted `.bin` link, a rewritten, removed or newly named script argument and an
 * unreadable file are each reviewed again with the change `contents`, an answer to a review whose file changed
 * after it was shown records nothing, and an unchanged start still starts without asking.
 */
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { McpServerCommand } from '@deepseek-ai/dsh-mcp-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeloMcpConsent } from '../src/index.ts'
import { FilePinError, pinFile, pinsOf } from '../src/pins.ts'
import { acceptanceStorePath, filesChangeOf, parseAcceptanceStore } from '../src/store.ts'
import { chatWritableRoots, writableByChats } from '../src/writable.ts'

let root: string

/**
 * The digest a pin holds of a file's contents.
 * @param path - the file.
 * @returns `sha256:` and the hexadecimal digest.
 */
function digestOf(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
}

/**
 * Write a file, creating its directory.
 * @param path - the file.
 * @param text - its contents.
 * @param mode - its mode.
 */
function file(path: string, text: string, mode = 0o644): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, { mode })
}

/**
 * A start of an interpreter in the root's `work` directory.
 * @param args - its arguments.
 * @returns the start.
 */
function startOf(args: readonly string[] = ['server.js']): McpServerCommand {
  return {
    serverName: 'files',
    command: join(root, 'bin', 'node'),
    args,
    env: {},
    cwd: join(root, 'work'),
    resolvedCommand: join(root, 'bin', 'node'),
    resolvedCwd: join(root, 'work'),
  }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'delo-mcp-pins-')))
  file(join(root, 'bin', 'node'), '#!/bin/sh\nexit 0\n', 0o755)
  file(join(root, 'work', 'server.js'), 'console.log("accepted")\n')
  mkdirSync(join(root, 'work', 'data'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the file pins', () => {
  it('pins the executable and each argument that names a regular file, by canonical path and contents', async () => {
    file(join(root, 'lib', 'cli.js'), 'cli\n')
    symlinkSync(join(root, 'lib', 'cli.js'), join(root, 'work', 'linked.js'))
    const pins = await pinsOf(startOf(['--flag', '', 'server.js', 'data', 'missing.js', 'linked.js', join(root, 'work', 'server.js')]))
    expect(pins).toEqual([
      { path: join(root, 'bin', 'node'), sha256: digestOf(join(root, 'bin', 'node')) },
      { argument: 2, path: join(root, 'work', 'server.js'), sha256: digestOf(join(root, 'work', 'server.js')) },
      { argument: 5, path: join(root, 'lib', 'cli.js'), sha256: digestOf(join(root, 'lib', 'cli.js')) },
      { argument: 6, path: join(root, 'work', 'server.js'), sha256: digestOf(join(root, 'work', 'server.js')) },
    ])
  })

  it('pins the file the value of an --option=value argument names, such as a module --import or --require loads', async () => {
    file(join(root, 'work', 'hook.js'), 'hook\n')
    file(join(root, 'work', '--odd=name'), 'odd\n')
    const pins = await pinsOf(startOf(['--import=./hook.js', '--require=hook.js', '--import=', 'x=hook.js', '--import=data', '--odd=name', 'server.js']))
    const hook = { path: join(root, 'work', 'hook.js'), sha256: digestOf(join(root, 'work', 'hook.js')) }
    expect(pins).toEqual([
      { path: join(root, 'bin', 'node'), sha256: digestOf(join(root, 'bin', 'node')) },
      { argument: 0, ...hook },
      { argument: 1, ...hook },
      { argument: 5, path: join(root, 'work', '--odd=name'), sha256: digestOf(join(root, 'work', '--odd=name')) },
      { argument: 6, path: join(root, 'work', 'server.js'), sha256: digestOf(join(root, 'work', 'server.js')) },
    ])
  })

  it('follows a symbolic link of the executable to the file it names', async () => {
    file(join(root, 'pkg', 'bin', 'cli.js'), '#!/usr/bin/env node\n', 0o755)
    symlinkSync(join(root, 'pkg', 'bin', 'cli.js'), join(root, 'bin', 'cli'))
    await expect(pinFile(join(root, 'bin', 'cli'))).resolves.toEqual({ path: join(root, 'pkg', 'bin', 'cli.js'), sha256: digestOf(join(root, 'pkg', 'bin', 'cli.js')) })
  })

  it('refuses a path that does not resolve, a directory and a file it cannot open', async () => {
    await expect(pinFile(join(root, 'missing'))).rejects.toThrow(new FilePinError(join(root, 'missing'), 'does not exist or cannot be resolved'))
    await expect(pinFile(join(root, 'work', 'data'))).rejects.toThrow('is not a regular file')
    chmodSync(join(root, 'work', 'server.js'), 0o000)
    await expect(pinFile(join(root, 'work', 'server.js'))).rejects.toThrow('cannot be opened for reading')
  })

  it('reads a file again at every pin, after an in-place rewrite that keeps its size and modification time', async () => {
    const path = join(root, 'work', 'server.js')
    const before = await pinFile(path)
    writeFileSync(path, 'console.log("rewritten")\n'.slice(0, readFileSync(path).length))
    utimesSync(path, new Date(0), new Date(0))
    const after = await pinFile(path)
    expect(after.sha256).not.toBe(before.sha256)
    expect(after.sha256).toBe(digestOf(path))
  })
})

describe('what differs between pinned files', () => {
  const executable = { path: '/bin/node', sha256: 'sha256:a' }
  const script = { argument: 0, path: '/work/server.js', sha256: 'sha256:b' }

  it('names a rewritten file, a file a path now resolves to, and an argument that names a file now or no longer', () => {
    expect(filesChangeOf([executable, script], [executable, script])).toBeUndefined()
    expect(filesChangeOf([executable], [{ ...executable, sha256: 'sha256:c' }])).toBe('the contents of the file "/bin/node", the executable, changed since the person accepted this server')
    expect(filesChangeOf([executable, script], [executable, { ...script, path: '/work/other.js' }])).toBe('the argument 0 now resolves to the file "/work/other.js", and the person accepted "/work/server.js"')
    expect(filesChangeOf([executable], [executable, script])).toBe('the argument 0 now names the file "/work/server.js", which the person did not accept')
    expect(filesChangeOf([executable, script], [executable])).toBe('the argument 0 named the file "/work/server.js" when the person accepted this server, and names no file now')
  })
})

describe('the add-time consent of a pinned start', () => {
  let ctx: Context
  let consent: DeloMcpConsent

  beforeEach(() => {
    mkdirSync(join(root, 'home'))
    vi.stubEnv('DELO_HOME', join(root, 'home'))
    ctx = new Context()
    consent = new DeloMcpConsent(ctx)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await ctx.fiber.dispose()
  })

  /**
   * The change and reason of the pending review of the suite's server.
   * @returns them.
   */
  function heldAs(): [string | undefined, string | undefined] {
    const review = consent.pending().find(entry => entry.serverName === 'files')
    return [review?.change, review?.reason]
  }

  it('starts an unchanged start without asking, and records the files it pinned', async () => {
    await consent.accept(startOf())
    await expect(consent.review(startOf())).resolves.toMatchObject({ allow: true })
    const accepted = parseAcceptanceStore(readFileSync(acceptanceStorePath(join(root, 'home')), 'utf8')).acceptances.get('files')
    expect(accepted?.files.map(pin => pin.path)).toEqual([join(root, 'bin', 'node'), join(root, 'work', 'server.js')])
    expect((await consent.accepted())[0]?.files).toEqual(accepted?.files)
  })

  it('refuses a rewritten executable', async () => {
    await consent.accept(startOf())
    writeFileSync(join(root, 'bin', 'node'), '#!/bin/sh\necho changed\n')
    await expect(consent.review(startOf())).resolves.toMatchObject({ allow: false })
    expect(heldAs()).toEqual(['contents', `the contents of the file ${JSON.stringify(join(root, 'bin', 'node'))}, the executable, changed since the person accepted this server`])
  })

  it('refuses a rewritten script argument', async () => {
    await consent.accept(startOf())
    writeFileSync(join(root, 'work', 'server.js'), 'console.log("rewritten")\n')
    await expect(consent.review(startOf())).resolves.toMatchObject({ allow: false })
    expect(heldAs()[0]).toBe('contents')
  })

  it('refuses a node_modules/.bin link pointed at another file, even one with the same contents', async () => {
    file(join(root, 'work', 'node_modules', 'tool', 'cli.js'), '#!/usr/bin/env node\n', 0o755)
    file(join(root, 'work', 'node_modules', 'evil', 'cli.js'), '#!/usr/bin/env node\n', 0o755)
    const link = join(root, 'work', 'node_modules', '.bin', 'tool')
    mkdirSync(join(link, '..'))
    symlinkSync('../tool/cli.js', link)
    const start = { ...startOf([]), command: './node_modules/.bin/tool', resolvedCommand: link }
    await consent.accept(start)
    await expect(consent.review(start)).resolves.toMatchObject({ allow: true })
    rmSync(link)
    symlinkSync('../evil/cli.js', link)
    await expect(consent.review(start)).resolves.toMatchObject({ allow: false })
    expect(heldAs()).toEqual(['contents', `the executable now resolves to the file ${JSON.stringify(join(root, 'work', 'node_modules', 'evil', 'cli.js'))}, and the person accepted ${JSON.stringify(join(root, 'work', 'node_modules', 'tool', 'cli.js'))}`])
  })

  it('allows a start with the canonical file it pinned as the path to spawn, so a link retargeted after the review is not what runs', async () => {
    file(join(root, 'work', 'node_modules', 'tool', 'cli.js'), '#!/usr/bin/env node\n', 0o755)
    file(join(root, 'work', 'node_modules', 'evil', 'cli.js'), '#!/usr/bin/env node\n', 0o755)
    const link = join(root, 'work', 'node_modules', '.bin', 'tool')
    mkdirSync(join(link, '..'))
    symlinkSync('../tool/cli.js', link)
    const start = { ...startOf([]), command: './node_modules/.bin/tool', resolvedCommand: link }
    await consent.accept(start)
    const decision = await consent.review(start)
    // The link is pointed elsewhere after the review allowed the start, before the mcp-client spawns it.
    rmSync(link)
    symlinkSync('../evil/cli.js', link)
    expect(decision).toEqual({ allow: true, spawnCommand: join(root, 'work', 'node_modules', 'tool', 'cli.js') })
    await expect(consent.review(startOf())).resolves.toMatchObject({ allow: false })
    await consent.accept(startOf())
    await expect(consent.review(startOf())).resolves.toEqual({ allow: true, spawnCommand: join(root, 'bin', 'node') })
  })

  it('names the working directory and the pinned files that lie in a workspace or a temporary directory chats can write', async () => {
    const workspace = join(root, 'work')
    ctx.provide('workspaceRegistry', { list: () => [{ path: workspace }] } as never)
    await consent.review(startOf())
    const [review] = consent.pending()
    // The suite's root is under the temporary directory, so the executable is named as well.
    expect(review?.writableByChats).toEqual([workspace, join(root, 'bin', 'node'), join(workspace, 'server.js')])
  })

  it('names nothing chats can write for a start outside every workspace and temporary directory', async () => {
    await expect(chatWritableRoots([], ['/nonexistent-temporary-directory'])).resolves.toEqual([])
    expect(writableByChats(['/usr/bin/node', '/srv/work', '/srv/workspace/a.js'], ['/srv/work', '/srv/other'])).toEqual(['/srv/work'])
    expect(writableByChats(['/srv/work/a.js', '/srv/work/a.js', '/srv'], ['/srv/work'])).toEqual(['/srv/work/a.js'])
  })

  it('refuses a script argument that was removed, or an argument that now names a file', async () => {
    await consent.accept(startOf())
    rmSync(join(root, 'work', 'server.js'))
    await expect(consent.review(startOf())).resolves.toMatchObject({ allow: false })
    expect(heldAs()[1]).toContain('names no file now')
    await consent.accept(startOf(['main.js']))
    file(join(root, 'work', 'main.js'), 'console.log("planted")\n')
    await expect(consent.review(startOf(['main.js']))).resolves.toMatchObject({ allow: false })
    expect(heldAs()[1]).toContain('which the person did not accept')
  })

  it('refuses a start whose file cannot be read, pinning no file, and records nothing for an answer to it', async () => {
    await consent.accept(startOf())
    chmodSync(join(root, 'work', 'server.js'), 0o000)
    await expect(consent.review(startOf())).resolves.toMatchObject({ allow: false })
    expect(heldAs()[0]).toBe('contents')
    expect(heldAs()[1]).toContain('a file this server runs could not be read, so no acceptance covers it')
    const [review] = consent.pending()
    expect(review?.files).toEqual([])
    await expect(consent.acceptReview('files', review?.reviewId ?? '', true)).rejects.toThrow(expect.objectContaining({ code: 'STALE_REVIEW' }))
  })

  it('records nothing for an answer to a review whose file changed after it was shown, and reviews the start again', async () => {
    await consent.review(startOf())
    const [shown] = consent.pending()
    writeFileSync(join(root, 'work', 'server.js'), 'console.log("swapped after the review")\n')
    await expect(consent.acceptReview('files', shown?.reviewId ?? '', true)).rejects.toThrow(expect.objectContaining({
      code: 'STALE_REVIEW', message: expect.stringContaining('runs other file contents than this review showed'),
    }))
    const [again] = consent.pending()
    expect(again?.reviewId).not.toBe(shown?.reviewId)
    expect(again?.files[1]?.sha256).toBe(digestOf(join(root, 'work', 'server.js')))
    await expect(consent.acceptReview('files', again?.reviewId ?? '', true)).resolves.toEqual({ started: 0 })
    await expect(consent.review(startOf())).resolves.toMatchObject({ allow: true })
  })

  it('refuses to accept a start whose file cannot be read', async () => {
    chmodSync(join(root, 'work', 'server.js'), 0o000)
    await expect(consent.accept(startOf())).rejects.toThrow(FilePinError)
  })
})
