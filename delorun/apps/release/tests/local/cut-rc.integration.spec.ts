/**
 * Cuts two release candidates into a scratch channel with throwaway keys, a stand-in log and fixture closures: the
 * each candidate's manifest signs its notes, the channel verifies as a client verifies it, and the first candidate
 * stays in the channel as the release the second updates from. Git and the closure build are stood in; the signing runs
 * the real `local-release.ts`.
 */
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cutRelease, parseCutArgs, verifyChannel, type CutDeps, type RunResult } from '../../scripts/cut-rc.ts'
import { REPO, scratch } from '../support.ts'
import { fixtureClosure, keyFile, serveLog, trust } from './support.ts'

const NOTES = 'What is new in this candidate:\n- The studio opens faster.\n'

describe('cutting two candidates', () => {
  it('signs each candidate\'s notes, cuts a private iteration between two previews and offers each update from the one before', async (test) => {
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

    const cut = async (version: string, closureEntry: string): Promise<number> => {
      const closures = join(directory, `closure-${version}`)
      mkdirSync(closures)
      await fixtureClosure(test, version, { entrySuffix: closureEntry })(closures)
      const request = parseCutArgs([
        '--version', version, '--channel', join(directory, 'channel'), '--state', join(keys, 'state.json'), '--keys', keys, '--root', root,
        '--commit', real, '--work', join(directory, 'work'), '--closures-from', closures,
        '--log-submit', log.endpoints.submit, '--log-checkpoint', log.endpoints.checkpoint, '--log-tiles', log.endpoints.tiles, '--log-poll-seconds', '0', '--no-smoke',
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
