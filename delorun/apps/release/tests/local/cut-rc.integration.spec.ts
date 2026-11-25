/**
 * Cuts two release candidates into a scratch channel with throwaway keys, a stand-in log and fixture closures: the
 * each candidate's manifest signs its notes, the channel verifies as a client verifies it, and the first candidate
 * stays in the channel as the release the second updates from. A cut after a root rotation passes the chain, which
 * signing and verification take whole while the log probe takes only the newest root. Git and the closure build are
 * stood in; the signing runs the real `local-release.ts`.
 */
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cutRelease, parseCutArgs, verifyChannel, type CutDeps, type RunResult } from '../../scripts/cut-rc.ts'
import { rootFile } from '../sign/fixture.ts'
import { REPO, scratch } from '../support.ts'
import { fixtureClosure, keyFile, serveLog, trust } from './support.ts'

const NOTES = 'What is new in this candidate:\n- The studio opens faster.\n'

/** A scratch channel with throwaway keys and a stand-in log, and a `cut` that signs one fixture candidate into it. */
async function cutter(test: Parameters<typeof scratch>[0]): Promise<{ directory: string, lines: string[], keys: string, trusted: ReturnType<typeof trust>, cut: (version: string, closureEntry: string, extra?: readonly string[], roots?: readonly string[]) => Promise<number> }> {
  const directory = scratch(test)
  const trusted = trust()
  const log = await serveLog(test, trusted)
  const keys = join(directory, 'keys')
  mkdirSync(keys, { mode: 0o700 })
  keyFile(keys, 'targets.pem', trusted.keys.targets)
  keyFile(keys, 'timestamp.pem', trusted.keys.timestamp)
  const root = join(keys, '1.root.json')
  writeFileSync(root, trusted.root)
  const commit = 'b'.repeat(40)
  const lines: string[] = []
  const real = (await new Promise<string>((done, failed) => execFile('git', ['rev-parse', 'HEAD'], { cwd: REPO }, (error, stdout) => error === null ? done(stdout.trim()) : failed(error)))).trim()

  const cut = async (version: string, closureEntry: string, extra: readonly string[] = [], roots: readonly string[] = [root]): Promise<number> => {
    const closures = join(directory, `closure-${version}`)
    rmSync(closures, { recursive: true, force: true })
    mkdirSync(closures)
    await fixtureClosure(test, version, { entrySuffix: closureEntry })(closures)
    const request = parseCutArgs([
      '--version', version, '--channel', join(directory, 'channel'), '--state', join(keys, 'state.json'), '--keys', keys, ...roots.flatMap(path => ['--root', path]),
      '--commit', real, '--work', join(directory, 'work'), '--closures-from', closures,
      '--log-submit', log.endpoints.submit, '--log-checkpoint', log.endpoints.checkpoint, '--log-tiles', log.endpoints.tiles, '--log-poll-seconds', '0', '--no-smoke', ...extra,
    ])
    const deps: CutDeps = {
      repository: REPO,
      hasChangelogEntry: () => true,
      say: line => lines.push(line),
      now: () => Date.now(),
      run: (command, args, logFile) => new Promise<RunResult>((done) => {
        appendFileSync(logFile, `$ ${command} ${args.join(' ')}\n`)
        if (command === 'git') {
          done({ status: 0, stdout: args[0] === 'status' ? '' : `${commit}\n` })
        } else if (args[0]?.endsWith('assemble.ts')) {
          writeFileSync(args[args.indexOf('--highlights') + 1]!, NOTES)
          done({ status: 0, stdout: '' })
        } else {
          execFile(command, [...args], { cwd: REPO, env: { ...process.env, CI: '' } }, (error, stdout, stderr) => {
            appendFileSync(logFile, stdout + stderr)
            done({ status: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout })
          })
        }
      }),
    }
    const outcome = await cutRelease({ ...request, commit: commit }, { ...deps, run: (command, args, logFile) => deps.run(command, args.map(arg => arg === commit ? real : arg), logFile) })
    return outcome.code
  }
  return { directory, lines, cut, keys, trusted }
}

describe('cutting two candidates', () => {
  it('signs each candidate\'s notes, cuts a private iteration between two previews and offers each update from the one before', async (test) => {
    const { directory, lines, cut: cutWith } = await cutter(test)
    // The fixture closure names this process's Node, which may lie under the real user's home, so these cuts allow the builder's paths.
    const cut = (version: string, closureEntry: string): Promise<number> => cutWith(version, closureEntry, ['--allow-builder-paths'])
    expect(await cut('0.1.0-preview.1', '')).toBe(0)
    const first = verifyChannel(join(directory, 'channel'), '0.1.0-preview.1', Math.floor(Date.now() / 1000))
    expect(first.notes?.toString()).toBe(NOTES)

    expect(await cut('0.1.0-preview.1.1', '\n// preview.1.1\n')).toBe(0)
    const iteration = verifyChannel(join(directory, 'channel'), '0.1.0-preview.1.1', Math.floor(Date.now() / 1000))
    expect(iteration.others).toEqual(['0.1.0-preview.1'])
    expect(iteration.timestampVersion).toBeGreaterThan(first.timestampVersion)

    expect(await cut('0.1.0-preview.2', '\n// preview.2\n')).toBe(0)
    const second = verifyChannel(join(directory, 'channel'), '0.1.0-preview.2', Math.floor(Date.now() / 1000))
    expect(second.notes?.toString()).toBe(NOTES)
    expect(second.others).toEqual(['0.1.0-preview.1', '0.1.0-preview.1.1'])
    expect(second.timestampVersion).toBeGreaterThan(iteration.timestampVersion)
    expect(existsSync(join(directory, 'channel', 'releases', 'download', 'v0.1.0-preview.2', 'delorun-0.1.0-preview.2.notes.txt'))).toBe(true)
    expect(readFileSync(join(directory, 'work', 'cut-rc-0.1.0-preview.2.log'), 'utf8')).not.toContain('PRIVATE KEY')
    expect(lines.join('\n')).toContain('signed notes')
  }, 120_000)

  it('refuses a closure that names the building user\'s home directory unless --allow-builder-paths is given, and then warns naming the file', async (test) => {
    const { directory, lines, cut } = await cutter(test)
    const planted = `\n// built in ${homedir()}/work\n`
    expect(await cut('0.1.0-preview.1', planted)).toBe(1)
    expect(lines.join('\n')).toContain('signing or logging failed')
    expect(existsSync(join(directory, 'channel', 'releases', 'download', 'v0.1.0-preview.1'))).toBe(false)
    const log = join(directory, 'work', 'cut-rc-0.1.0-preview.1.log')
    expect(readFileSync(log, 'utf8')).toContain("delorun-0.1.0-preview.1-linux-x64.tar.gz!app/node_modules/@delorun/cli/src/bin.js: the building user's home directory")
    expect(await cut('0.1.0-preview.1', planted, ['--allow-builder-paths'])).toBe(0)
    expect(readFileSync(log, 'utf8')).toContain("warning: the closure files name the building user's paths")
  }, 120_000)

  it('cuts after a root rotation with the whole chain, signing and verifying under the newest root and probing only that one', async (test) => {
    const { directory, cut: cutWith, keys, trusted } = await cutter(test)
    const cut = (version: string, closureEntry: string, roots: readonly string[]): Promise<number> => cutWith(version, closureEntry, ['--allow-builder-paths'], roots)
    // The signer's state trusts root 1 until a release under root 2 is signed, so the second cut passes both.
    expect(await cut('0.1.0-preview.1', '', [join(keys, '1.root.json')])).toBe(0)
    const second = join(keys, '2.root.json')
    writeFileSync(second, rootFile(trusted.keys, { version: 2 }).bytes)
    expect(await cut('0.1.0-preview.2', '\n// preview.2\n', [join(keys, '1.root.json'), second])).toBe(0)
    const verified = verifyChannel(join(directory, 'channel'), '0.1.0-preview.2', Math.floor(Date.now() / 1000), [join(keys, '1.root.json'), second])
    expect(verified.others).toEqual(['0.1.0-preview.1'])
    expect(existsSync(join(directory, 'channel', 'root', '2.root.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(directory, 'channel', 'timestamp.json'), 'utf8')).signed.root.version).toBe(2)
    // The probe asks the log the newest root names, so its command line names root 2 alone.
    const log = readFileSync(join(directory, 'work', 'cut-rc-0.1.0-preview.2.log'), 'utf8')
    const probe = log.split('\n').find(line => line.includes('probe-log.ts'))!
    expect(probe).toContain(second)
    expect(probe).not.toContain('1.root.json')
    // Signing took the chain: both roots are on its command line, oldest first.
    const sign = log.split('\n').find(line => line.includes('local-release.ts'))!
    expect(sign.indexOf('1.root.json')).toBeLessThan(sign.indexOf('2.root.json'))
  }, 120_000)

  it('refuses a chain whose root the channel does not serve', async (test) => {
    const { directory, cut: cutWith, keys, trusted } = await cutter(test)
    const second = join(keys, '2.root.json')
    writeFileSync(second, rootFile(trusted.keys, { version: 2 }).bytes)
    expect(await cutWith('0.1.0-preview.1', '', ['--allow-builder-paths'], [join(keys, '1.root.json'), second])).toBe(1)
    expect(existsSync(join(directory, 'channel', 'releases', 'download', 'v0.1.0-preview.1'))).toBe(false)
  }, 120_000)

  it('refuses rc.2 without rc.1 in the channel and a dirty tree', async (test) => {
    const directory = scratch(test)
    const request = parseCutArgs(['--version', '0.1.0-rc.2', '--channel', join(directory, 'channel'), '--state', join(directory, 's.json'), '--keys', directory, '--root', join(directory, 'r.json'), '--commit', 'abc'])
    const lines: string[] = []
    const never = (): Promise<RunResult> => Promise.reject(new Error('no command may run'))
    const outcome = await cutRelease(request, { repository: REPO, hasChangelogEntry: () => true, say: line => lines.push(line), now: () => 0, run: never })
    expect(outcome.code).toBe(1)
    expect(lines.join('\n')).toContain('has no 0.1.0-rc.1 to update from')
  })
})
