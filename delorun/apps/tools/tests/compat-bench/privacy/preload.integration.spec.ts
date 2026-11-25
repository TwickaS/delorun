import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { PRELOAD_PATH, runWithHooks } from '../../../src/compat-bench/privacy/harness.ts'

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

describe('the privacy preload', () => {
  it('records nothing for an ordinary plugin but its own start', async () => {
    const run = await runWithHooks(fixture('ordinary.mjs'))
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toBe('6')
    expect(run.summary.connects.size).toBe(0)
    expect(run.summary.listens.size).toBe(0)
    expect(run.summary.execs.size).toBe(0)
    expect(run.summary.opens.size).toBe(0)
  })

  it('records a listen and a connect of a plugin that fetches a URL it declares', async () => {
    const run = await runWithHooks(fixture('fetches-declared-url.mjs'))
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toBe('ok')
    expect([...run.summary.listens.values()].map(listen => listen.host)).toEqual(['127.0.0.1'])
    const connects = [...run.summary.connects.values()]
    expect(connects).toHaveLength(1)
    expect(connects[0]?.host).toBe('127.0.0.1')
  })

  it('records each way of starting a program', async () => {
    const run = await runWithHooks(fixture('starts-programs.mjs'))
    expect(run.status).toBe(0)
    const execs = [...run.summary.execs]
    expect(execs.length).toBeGreaterThanOrEqual(3)
    expect(execs.some(exec => exec.endsWith(' -v'))).toBe(true)
    expect(execs.some(exec => exec.includes('-e 0'))).toBe(true)
  })

  it('records the environment names a plugin reads, once each', async () => {
    const run = await runWithHooks(fixture('reads-env.mjs'), { env: { READ_NAMES: 'GITHUB_TOKEN,GITHUB_TOKEN,AWS_SECRET_ACCESS_KEY' } })
    expect(run.status).toBe(0)
    expect(run.summary.envNames.has('GITHUB_TOKEN')).toBe(true)
    expect(run.summary.envNames.has('AWS_SECRET_ACCESS_KEY')).toBe(true)
    expect(run.events.filter(event => event.t === 'env' && event.name === 'GITHUB_TOKEN')).toHaveLength(1)
    expect(run.summary.envEnumerated).toBe(false)
  })

  it('notes that the whole environment was listed', async () => {
    const run = await runWithHooks(fixture('reads-env.mjs'), { env: { ENUMERATE: '1' } })
    expect(run.summary.envEnumerated).toBe(true)
  })

  it('does not count the environment Node reads to start a child as the plugin reading it', async () => {
    const run = await runWithHooks(fixture('reads-env.mjs'), { env: { SPAWN: '1', SECRET_LOOKING_NAME: 'x' } })
    expect(run.status).toBe(0)
    expect(run.summary.envEnumerated).toBe(false)
    expect(run.summary.envNames.has('SECRET_LOOKING_NAME')).toBe(false)
    expect(run.summary.execs.size).toBe(1)
  })

  it('records opens of watched files and of everything below a watched directory, however they are opened', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-privacy-watch-'))
    temporary.push(dir)
    const key = join(dir, 'id_ed25519')
    const hosts = join(dir, 'gh', 'hosts.yml')
    const other = join(dir, 'unwatched.txt')
    await writeFile(key, 'fake')
    const run = await runWithHooks(fixture('reads-files.mjs'), {
      args: [key, hosts, other],
      watch: [{ label: '~/.ssh/id_ed25519', path: key }, { label: '~/.config/gh/', path: `${join(dir, 'gh')}/` }],
    })
    expect(run.status).toBe(0)
    expect([...run.summary.opens.values()].map(open => open.label).sort()).toEqual(['~/.config/gh/', '~/.ssh/id_ed25519'])
    expect([...run.summary.opens.keys()]).not.toContain(other)
  })

  it('records a datagram sent to a name or address', async () => {
    const run = await runWithHooks(fixture('sends-udp.mjs'))
    expect([...run.summary.connects.values()].map(connect => `${connect.host}:${connect.port}`)).toContain('192.0.2.1:9')
  })

  it('changes nothing without the log variable', () => {
    const env: Record<string, string | undefined> = { ...process.env, NODE_OPTIONS: `--import ${PRELOAD_PATH}` }
    delete env.DELORUN_PRIVACY_LOG
    const run = spawnSync(process.execPath, [fixture('ordinary.mjs')], { env, encoding: 'utf8', timeout: 30_000 })
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toBe('6')
    expect(run.stderr).toBe('')
  })
})
