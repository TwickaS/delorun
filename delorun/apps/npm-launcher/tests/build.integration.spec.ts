/**
 * The launcher's build: the package it stages and the tarball it packs run with plain Node, ship exactly the roots
 * they were given, and refuse everything else before writing a package.
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildLauncher, main } from '../src/build.ts'
import { fixtureRelease, nextRoot } from '../../install/tests/support.ts'

let directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })))
  directories = []
})

/**
 * A new temporary directory.
 * @returns its path.
 */
async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'delorun-launcher-build-'))
  directories.push(directory)
  return directory
}

/**
 * A root file on disk.
 * @param directory - where to write it.
 * @returns its path and the root's bytes.
 */
async function rootFile(directory: string): Promise<{ readonly path: string, readonly bytes: Buffer }> {
  const fixture = await fixtureRelease()
  const path = join(directory, 'root.json')
  const bytes = Buffer.from(fixture.roots[0]!)
  await writeFile(path, bytes)
  return { path, bytes }
}

/** Each build bundles the launcher and runs `npm pack`, which takes seconds. */
const LIMIT = { timeout: 120_000 }

describe('the built launcher', LIMIT, () => {
  it('packs a tarball of plain JavaScript that holds the root it was given and runs on Node alone', async () => {
    const work = await scratch()
    const root = await rootFile(work)
    const built = await buildLauncher({ roots: [root.path], out: join(work, 'out'), version: '0.1.0-test.1' })
    const listing = execFileSync('tar', ['-tzf', built.tarball], { encoding: 'utf8', timeout: 30_000 }).split('\n').filter(Boolean).sort()
    expect(listing).toEqual(expect.arrayContaining(['package/dist/bin.js', 'package/package.json', 'package/roots/1.root.json', 'package/LICENSE', 'package/README.md']))
    expect(listing.every(entry => !entry.includes('node_modules') && !entry.endsWith('.ts'))).toBe(true)
    const manifest = JSON.parse(await readFile(join(built.directory, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(manifest).toMatchObject({ name: 'delorun', version: '0.1.0-test.1', type: 'module', bin: { delorun: 'dist/bin.js' }, engines: { node: '>=24.9.0' } })
    expect(manifest).toMatchObject({ description: 'Install and run Delorun', homepage: 'https://delorun.com', bugs: { url: 'https://github.com/twickas/delorun/issues' }, keywords: expect.arrayContaining(['delorun', 'deepseek-harness', 'dsh-plugin']) })
    expect(manifest).not.toHaveProperty('dependencies')
    const readme = await readFile(join(built.directory, 'README.md'), 'utf8')
    expect(readme).toContain('npx delorun')
    expect(readme).toContain('It is not a DeepSeek product, and DeepSeek does not endorse it.')
    expect(await readFile(join(built.directory, 'roots', '1.root.json'))).toEqual(root.bytes)
    const unpacked = join(work, 'unpacked')
    execFileSync('mkdir', [unpacked], { timeout: 30_000 })
    execFileSync('tar', ['-xzf', built.tarball, '-C', unpacked], { timeout: 30_000 })
    const usage = execFileSync(process.execPath, [join(unpacked, 'package', 'dist', 'bin.js'), '--help'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, timeout: 50_000 })
    expect(usage).toContain('Usage: delorun')
  })

  it('names the package’s own version when none is given', async () => {
    const work = await scratch()
    const root = await rootFile(work)
    const built = await buildLauncher({ roots: [root.path], out: join(work, 'out') })
    const own = JSON.parse(await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string }
    expect(built.tarball.endsWith(`delorun-${own.version}.tgz`)).toBe(true)
    expect((await readdir(join(work, 'out'))).sort()).toEqual([`delorun-${own.version}.tgz`, 'package'])
  })

  it('builds with a channel and a log origin, and refuses an origin that breaks the rule before writing a package', async () => {
    const work = await scratch()
    const root = await rootFile(work)
    const built = await buildLauncher({ roots: [root.path], out: join(work, 'out'), constants: { channelOrigin: 'http://127.0.0.1:8123', logOrigin: 'http://127.0.0.1:8124' }, version: '0.0.1-origins' })
    const chunks = (await readdir(join(built.directory, 'dist'))).filter(name => name.endsWith('.js'))
    const code = (await Promise.all(chunks.map(name => readFile(join(built.directory, 'dist', name), 'utf8')))).join('\n')
    expect(code).toContain('http://127.0.0.1:8123')
    expect(code).toContain('http://127.0.0.1:8124')
    expect(JSON.parse(await readFile(join(built.directory, 'package.json'), 'utf8'))).toMatchObject({ description: 'Delorun launcher built for a local release channel' })
    await expect(buildLauncher({ roots: [root.path], out: join(work, 'refused'), constants: { channelOrigin: 'http://channel.example.test' } })).rejects.toThrow('must use https')
    expect(await readdir(work)).not.toContain('refused')
  })

  it('refuses a build with no root, a root twice and an output directory that already holds a package', async () => {
    const work = await scratch()
    const root = await rootFile(work)
    await expect(buildLauncher({ roots: [], out: join(work, 'none') })).rejects.toThrow('pass at least one --root')
    await expect(buildLauncher({ roots: [root.path, root.path], out: join(work, 'twice') })).rejects.toThrow('two --root files are root version 1')
    await buildLauncher({ roots: [root.path], out: join(work, 'out') })
    await expect(buildLauncher({ roots: [root.path], out: join(work, 'out') })).rejects.toThrow('exists; build into a new directory')
  })

  it('refuses a package that names the builder\'s own paths, naming the file, before it writes a tarball', async () => {
    const work = await scratch()
    const root = await rootFile(work)
    // The package README is known text, so a builder whose home directory is a phrase from it plants that "path".
    const builder = { home: 'installs nothing when either check refuses', username: 'maker' }
    const refusal = await buildLauncher({ roots: [root.path], out: join(work, 'out'), version: '0.1.0-planted', builder }).then(() => undefined, (error: unknown) => error as Error)
    expect(refusal?.message).toMatch(/name the builder's own paths[^]*package\/README\.md: the building user's home directory installs nothing when either check refuses/u)
    expect(await readdir(join(work, 'out'))).toEqual(['package'])
    const built = await buildLauncher({ roots: [root.path], out: join(work, 'clean'), version: '0.1.0-clean', builder: { home: '/home/maker', username: 'maker' } })
    expect(await readdir(join(work, 'clean'))).toContain('delorun-0.1.0-clean.tgz')
    expect(built.tarball).toContain('delorun-0.1.0-clean.tgz')
  })

  it('refuses a root that does not verify, and roots that skip a version', async () => {
    const work = await scratch()
    const bad = join(work, 'bad.json')
    await writeFile(bad, '{"signed":{},"signatures":[]}')
    await expect(buildLauncher({ roots: [bad], out: join(work, 'bad-out') })).rejects.toThrow()
    const fixture = await fixtureRelease()
    const second = nextRoot(fixture.rootMetadata, fixture.keys, [fixture.keys.root])
    const third = nextRoot({ ...fixture.rootMetadata, version: 2 }, fixture.keys, [fixture.keys.root])
    const secondPath = join(work, '2.json')
    const thirdPath = join(work, '3.json')
    await writeFile(secondPath, second)
    await writeFile(thirdPath, third)
    await expect(buildLauncher({ roots: [secondPath, thirdPath], out: join(work, 'chain') })).resolves.toMatchObject({ tarball: expect.stringContaining('delorun-') as string })
    const firstPath = join(work, 'first.json')
    await writeFile(firstPath, fixture.roots[0]!)
    await expect(buildLauncher({ roots: [firstPath, thirdPath], out: join(work, 'skip') })).rejects.toThrow('holds root 3 without root 2')
  })
})

describe('the build command', LIMIT, () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('packs the launcher for the roots and origins it is given, and prints the tarball', async () => {
    const work = await scratch()
    const root = await rootFile(work)
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(await main(['--root', root.path, '--out', join(work, 'out'), '--channel-origin', 'http://127.0.0.1:8123', '--log-origin', 'http://127.0.0.1:8124', '--package-version', '0.0.2-command'])).toBe(0)
    expect(out).toHaveBeenCalledWith(`build: wrote ${join(work, 'out', 'delorun-0.0.2-command.tgz')}`)
    expect(await main(['--root', root.path, '--out', join(work, 'plain')])).toBe(0)
  })

  it('refuses a call with no output directory, and reports a build that fails', async () => {
    const work = await scratch()
    const root = await rootFile(work)
    const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await main(['--root', root.path])).toBe(1)
    expect(failure).toHaveBeenLastCalledWith('build: pass --out <dir> and at least one --root <root file>')
    expect(await main(['--out', join(work, 'no-root')])).toBe(1)
    expect(failure).toHaveBeenLastCalledWith(expect.stringContaining('pass at least one --root'))
  })
})
