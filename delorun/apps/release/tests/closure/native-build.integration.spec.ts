/**
 * The recipe's native step against a Docker stand-in: it refuses a platform the recipe does not build and a route that
 * disagrees with `native/system`, builds the builder image only when its input-named tag is missing, compiles only
 * after the image's packages match the pins, and compiles with no network, a read-only root, the pinned Node's headers
 * and the commit's time. The `docker` command itself runs as a stand-in script on `PATH`.
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { create as createTar } from 'tar'
import { describe, expect, it } from 'vitest'
import { readRecipe, type Toolchain } from '../../src/closure/config.ts'
import { builderUser, buildNativeAddons, builderTag, engineIsRootless, installedPackageProblems, NATIVE_SOURCE, runDocker, unbuiltPlatformProblems, type Docker, type DockerResult } from '../../src/closure/native-build.ts'
import { scratch } from '../support.ts'

const BASE = 'docker.io/library/debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc'
const EPOCH = 1_793_981_656

/** A pinned toolchain whose Linux x64 Node distribution is a small fixture tarball already in the cache. */
async function fixture(directory: string): Promise<{ toolchain: Toolchain, source: string, cache: string }> {
  const toolchain = readRecipe().toolchain
  const top = 'node-v24.22.0-linux-x64'
  const tree = join(directory, 'tree')
  mkdirSync(join(tree, top, 'bin'), { recursive: true })
  mkdirSync(join(tree, top, 'include', 'node'), { recursive: true })
  mkdirSync(join(tree, top, 'share'), { recursive: true })
  writeFileSync(join(tree, top, 'bin', 'node'), 'node')
  writeFileSync(join(tree, top, 'include', 'node', 'node_api.h'), 'header')
  writeFileSync(join(tree, top, 'share', 'unused'), 'not extracted')
  const tarball = join(directory, 'node.tar.gz')
  await createTar({ gzip: true, file: tarball, cwd: tree }, [top])
  const bytes = readFileSync(tarball)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const cache = join(directory, 'cache')
  mkdirSync(cache)
  writeFileSync(join(cache, `sha256-${sha256}`), bytes)
  const source = join(directory, 'source')
  for (const platform of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']) mkdirSync(join(source, NATIVE_SOURCE, 'packages', platform), { recursive: true })
  mkdirSync(join(source, NATIVE_SOURCE, 'packages', 'linux-x64', 'bin', 'glibc'), { recursive: true })
  writeFileSync(join(source, NATIVE_SOURCE, 'packages', 'linux-x64', 'bin', 'glibc', 'stale.node'), 'copied from a worktree')
  const distributions = { ...toolchain.node.distributions, 'linux-x64': { file: `${top}.tar.gz`, sha256 } }
  return { toolchain: { ...toolchain, node: { ...toolchain.node, distributions } }, source, cache }
}

const ok = (stdout = ''): DockerResult => ({ status: 0, stdout, stderr: '' })

/** The pinned packages as `dpkg-query` lists them. */
function listed(toolchain: Toolchain): string {
  return toolchain.native.builder.packages.map(item => `${item}\n`).join('')
}

/** A Docker stand-in that records each call; `answer` decides each result. */
function standIn(answer: (args: readonly string[]) => DockerResult): { docker: Docker, calls: Array<{ args: readonly string[], inherit: boolean }> } {
  const calls: Array<{ args: readonly string[], inherit: boolean }> = []
  return { calls, docker: (args, inherit) => { calls.push({ args, inherit }); return answer(args) } }
}

describe('the native step', () => {
  it('refuses an unbuilt platform before calling Docker', async (test) => {
    const { toolchain, source, cache } = await fixture(scratch(test))
    expect(unbuiltPlatformProblems(toolchain, ['linux-x64', 'win32-x64'])).toEqual([])
    const { docker, calls } = standIn(() => ok())
    await expect(buildNativeAddons({ toolchain, base: BASE, source, platforms: ['linux-x64', 'darwin-x64', 'darwin-arm64'], cache, epoch: EPOCH, user: '1000:1000', docker }))
      .rejects.toThrow(/^darwin-x64: toolchain\.json builds no native system addon[^\n]*\ndarwin-arm64: /u)
    expect(calls).toEqual([])
  })

  it('refuses a route that disagrees with the native workspace', async (test) => {
    const { toolchain, source, cache } = await fixture(scratch(test))
    const { docker, calls } = standIn(() => ok())
    await buildNativeAddons({ toolchain, base: BASE, source, platforms: ['win32-x64'], cache, epoch: EPOCH, user: '1000:1000' })
    mkdirSync(join(source, NATIVE_SOURCE, 'packages', 'win32-x64'))
    await expect(buildNativeAddons({ toolchain, base: BASE, source, platforms: ['win32-x64'], cache, epoch: EPOCH, user: '1000:1000', docker }))
      .rejects.toThrow('native/system/packages/win32-x64 exists, but toolchain.json says win32-x64 has no native system addon')
    const darwin = { ...toolchain, native: { ...toolchain.native, platforms: { ...toolchain.native.platforms, 'darwin-x64': 'source' as const } } }
    await expect(buildNativeAddons({ toolchain: darwin, base: BASE, source, platforms: ['darwin-x64'], cache, epoch: EPOCH, user: '1000:1000', docker }))
      .rejects.toThrow('toolchain.json builds the native system addon for darwin-x64 from source, but the recipe compiles only Linux platforms')
    await expect(buildNativeAddons({ toolchain, base: BASE, source: join(source, 'elsewhere'), platforms: ['linux-arm64'], cache, epoch: EPOCH, user: '1000:1000', docker }))
      .rejects.toThrow('toolchain.json builds the native system addon for linux-arm64, but native/system/packages/linux-arm64 does not exist')
    expect(calls).toEqual([])
  })

  it('builds a missing builder image, checks its packages, and compiles offline with the pinned Node', async (test) => {
    const { toolchain, source, cache } = await fixture(scratch(test))
    const packageDir = join(source, NATIVE_SOURCE, 'packages', 'linux-x64')
    let mounted: string[] = []
    const { docker, calls } = standIn((args) => {
      if (args[0] === 'image') return { status: 1, stdout: '', stderr: 'No such image' }
      if (args.includes('dpkg-query')) return ok(listed(toolchain))
      if (args[0] === 'run') {
        const node = args[args.indexOf('--volume') + 1]!.split(':')[0]!
        mounted = [readFileSync(join(node, 'bin', 'node'), 'utf8'), readFileSync(join(node, 'include', 'node', 'node_api.h'), 'utf8'), String(existsSync(join(node, 'share'))), String(existsSync(join(packageDir, 'bin')))]
      }
      return ok()
    })
    await buildNativeAddons({ toolchain, base: BASE, source, platforms: ['linux-x64', 'win32-x64'], cache, epoch: EPOCH, user: '1000:1000', docker })
    const tag = builderTag(readFileSync(join(import.meta.dirname, '..', '..', toolchain.native.builder.dockerfile)), BASE, toolchain.native.builder, 'linux/amd64')
    expect(calls.map(call => [call.args[0], call.inherit])).toEqual([['image', false], ['build', true], ['run', false], ['run', true]])
    expect(calls[1]!.args).toEqual(expect.arrayContaining(['--platform', 'linux/amd64', `BASE=${BASE}`, `SNAPSHOT=${toolchain.native.builder.snapshot}`, `PACKAGES=${toolchain.native.builder.packages.join(' ')}`, '--tag', tag]))
    const compile = calls[3]!.args
    expect(compile.slice(0, 11)).toEqual(['run', '--rm', '--network', 'none', '--platform', 'linux/amd64', '--read-only', '--tmpfs', '/tmp', '--user', '1000:1000'])
    expect(compile).toEqual(expect.arrayContaining([`SOURCE_DATE_EPOCH=${String(EPOCH)}`, 'TZ=UTC', 'LC_ALL=C', `${join(source, NATIVE_SOURCE)}:/build/system`, tag, '/opt/node/bin/node', 'scripts/build.ts']))
    expect(mounted).toEqual(['node', 'header', 'false', 'false'])
    expect(readdirSync(cache).filter(name => name.startsWith('.native-node-'))).toEqual([])
  })

  it('starts the compile container as the user the request names, which is uid 0 on a rootless engine', async (test) => {
    const { toolchain, source, cache } = await fixture(scratch(test))
    const { docker, calls } = standIn(args => (args.includes('dpkg-query') ? ok(listed(toolchain)) : ok()))
    await buildNativeAddons({ toolchain, base: BASE, source, platforms: ['linux-x64'], cache, epoch: EPOCH, user: builderUser(true), docker })
    const compile = calls.find(call => call.args[0] === 'run' && call.args.includes('scripts/build.ts'))!.args
    expect(compile[compile.indexOf('--user') + 1]).toBe('0:0')
  })

  it('reuses an existing image, and refuses one whose packages are not the pinned ones', async (test) => {
    const { toolchain, source, cache } = await fixture(scratch(test))
    const drifted = listed(toolchain).replace('binutils=2.40-2', 'binutils=2.40-3').replace(/^musl-tools=.*\n/mu, '')
    const { docker, calls } = standIn(args => (args.includes('dpkg-query') ? ok(drifted) : ok()))
    await expect(buildNativeAddons({ toolchain, base: BASE, source, platforms: ['linux-x64'], cache, epoch: EPOCH, user: '1000:1000', docker }))
      .rejects.toThrow(/is not the pinned toolchain:\nbinutils=2\.40-2 is pinned, but the builder image has binutils=2\.40-3\nmusl-tools=1\.2\.3-1 is pinned, but the builder image has no such package$/u)
    expect(calls.map(call => call.args[0])).toEqual(['image', 'run'])
    expect(existsSync(join(source, NATIVE_SOURCE, 'packages', 'linux-x64', 'bin'))).toBe(true)
  })

  it('reports a failed image build or compile with Docker\'s message, and removes the unpacked Node', async (test) => {
    const { toolchain, source, cache } = await fixture(scratch(test))
    const failing = (step: string, stderr: string): Docker => standIn((args) => {
      if (args[0] === 'image') return { status: 1, stdout: '', stderr: '' }
      if (args.includes('dpkg-query')) return ok(listed(toolchain))
      return args[0] === step && !args.includes('dpkg-query') ? { status: 2, stdout: '', stderr } : ok()
    }).docker
    await expect(buildNativeAddons({ toolchain, base: BASE, source, platforms: ['linux-x64'], cache, epoch: EPOCH, user: '1000:1000', docker: failing('build', 'snapshot unreachable\n') }))
      .rejects.toThrow('building the native builder image for linux/amd64 failed with 2: snapshot unreachable')
    await expect(buildNativeAddons({ toolchain, base: BASE, source, platforms: ['linux-x64'], cache, epoch: EPOCH, user: '1000:1000', docker: failing('run', '') }))
      .rejects.toThrow(/^compiling native\/system for linux-x64 failed with 2$/u)
    expect(readdirSync(cache).filter(name => name.startsWith('.native-node-'))).toEqual([])
  })

  it('runs the builder as uid 0 on a rootless engine and as the caller on a rootful one', () => {
    expect(builderUser(true)).toBe('0:0')
    expect(builderUser(false)).toBe(`${String(process.getuid?.())}:${String(process.getgid?.())}`)
  })

  it('reads rootless from the engine\'s security options', () => {
    const answering = (stdout: string, status = 0): Docker => (args, inherit) => {
      expect(args).toEqual(['info', '--format', '{{json .SecurityOptions}}'])
      expect(inherit).toBe(false)
      return { status, stdout, stderr: status === 0 ? '' : 'Cannot connect to the Docker daemon\n' }
    }
    expect(engineIsRootless(answering('["name=apparmor,profile=default","name=rootless"]'))).toBe(true)
    expect(engineIsRootless(answering('["name=apparmor,profile=default","name=seccomp,profile=builtin","name=cgroupns"]'))).toBe(false)
    expect(engineIsRootless(answering('null'))).toBe(false)
    expect(() => engineIsRootless(answering('', 1))).toThrow('docker info failed with 1: Cannot connect to the Docker daemon')
  })

  it('names the builder image after every input', () => {
    const builder = readRecipe().toolchain.native.builder
    const tag = builderTag(Buffer.from('FROM x'), BASE, builder, 'linux/amd64')
    expect(tag).toMatch(/^delorun-release-native:[0-9a-f]{24}$/u)
    expect(new Set([
      tag,
      builderTag(Buffer.from('FROM y'), BASE, builder, 'linux/amd64'),
      builderTag(Buffer.from('FROM x'), `${BASE.slice(0, -1)}0`, builder, 'linux/amd64'),
      builderTag(Buffer.from('FROM x'), BASE, { ...builder, snapshot: '20260101T000000Z' }, 'linux/amd64'),
      builderTag(Buffer.from('FROM x'), BASE, { ...builder, packages: [...builder.packages, 'make=4.3-4.1'] }, 'linux/amd64'),
      builderTag(Buffer.from('FROM x'), BASE, builder, 'linux/arm64'),
    ]).size).toBe(6)
    expect(installedPackageProblems('gcc=1\nmusl=2\n', ['gcc=1', 'musl=2'])).toEqual([])
  })

  it('runs the docker command on PATH, with its output captured or passed through', (test) => {
    const bin = scratch(test)
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\necho "out $*"\necho err >&2\nexit 3\n')
    chmodSync(join(bin, 'docker'), 0o755)
    const path = process.env.PATH
    test.onTestFinished(() => { process.env.PATH = path })
    process.env.PATH = bin
    expect(runDocker(['version'], false)).toEqual({ status: 3, stdout: 'out version\n', stderr: 'err\n' })
    expect(runDocker(['version'], true)).toEqual({ status: 3, stdout: '', stderr: '' })
    process.env.PATH = join(bin, 'missing')
    expect(() => runDocker(['version'], false)).toThrow(/^docker did not start: /u)
  })
})
