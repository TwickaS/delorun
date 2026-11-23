/**
 * The `cut-rc.ts` command line and plan: which flags it requires, that every candidate signs its notes, what `--dry-run` prints, the closing installed-release smoke, and that key material never reaches the plan.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { localReleaseArgs, parseCutArgs, planSteps, previousCandidate, printPlan, smokeArgs } from '../../scripts/cut-rc.ts'

const BASE = ['--version', '0.1.0-rc.2', '--channel', '/c/channel', '--state', '/k/state.json', '--keys', '/k', '--root', '/k/1.root.json', '--commit', 'abc123']

describe('cut-rc arguments', () => {
  it('requires the version, channel, state, keys, root and commit', () => {
    for (const flag of ['version', 'channel', 'state', 'keys', 'root', 'commit']) {
      const index = BASE.indexOf(`--${flag}`)
      const without = [...BASE.slice(0, index), ...BASE.slice(index + 2)]
      expect(() => parseCutArgs(without)).toThrow(`pass --${flag}`)
    }
  })

  it('refuses a version that is not a preview or release candidate, an unknown platform and an unknown flag', () => {
    expect(() => parseCutArgs(['--version', '0.1.0', ...BASE.slice(2)])).toThrow('not a preview or release candidate')
    expect(() => parseCutArgs(['--version', '0.1.0-preview.0', ...BASE.slice(2)])).toThrow('not a preview or release candidate')
    expect(() => parseCutArgs(['--version', '0.1.0-preview.1.0', ...BASE.slice(2)])).toThrow('not a preview or release candidate')
    expect(() => parseCutArgs(['--version', '0.1.0-preview.01', ...BASE.slice(2)])).toThrow('not a preview or release candidate')
    expect(() => parseCutArgs(['--version', '0.1.0-preview.1.01', ...BASE.slice(2)])).toThrow('not a preview or release candidate')
    expect(() => parseCutArgs(['--version', '0.1.0-preview.1.1.1', ...BASE.slice(2)])).toThrow('not a preview or release candidate')
    expect(() => parseCutArgs(['--version', '0.1.0-beta.1', ...BASE.slice(2)])).toThrow('not a preview or release candidate')
    expect(() => parseCutArgs([...BASE, '--platform', 'plan9-x64'])).toThrow('not one of')
    expect(() => parseCutArgs([...BASE, '--artifacts', 'maybe'])).toThrow('build or existing')
    expect(() => parseCutArgs([...BASE, '--nope'])).toThrow()
  })

  it('defaults the work directory to the channel parent, the notes file under it and the summary to the number', () => {
    const request = parseCutArgs(BASE)
    expect(request).toMatchObject({ number: 2, work: '/c', highlights: '/c/notes-0.1.0-rc.2.txt', summary: 'Release candidate 2.', platforms: ['linux-x64'], artifacts: 'existing', dryRun: false })
    expect(request.log.submit).toBe('https://log2025-1.rekor.sigstore.dev/api/v2/log/entries')
  })

  it('takes the log endpoints, highlights file and closure directory from flags', () => {
    const request = parseCutArgs([...BASE, '--highlights', '/h/n.txt', '--log-submit', 'http://127.0.0.1:1/s', '--log-checkpoint', 'http://127.0.0.1:1/c', '--log-tiles', 'http://127.0.0.1:1/t/', '--closures-from', '/x', '--dry-run'])
    expect(request).toMatchObject({ highlights: '/h/n.txt', closuresFrom: '/x', dryRun: true, log: { submit: 'http://127.0.0.1:1/s', checkpoint: 'http://127.0.0.1:1/c', tiles: 'http://127.0.0.1:1/t/' } })
  })
})

describe('cut-rc plan', () => {
  it('reads previews and release candidates, and names each series in the default summary', () => {
    const preview = parseCutArgs(['--version', '0.1.0-preview.3', ...BASE.slice(2)])
    expect(preview).toMatchObject({ kind: 'preview', number: 3, summary: 'Preview 3.', highlights: '/c/notes-0.1.0-preview.3.txt' })
    expect(parseCutArgs(BASE)).toMatchObject({ kind: 'rc', number: 2 })
  })

  it('signs notes for every candidate, the first preview included', () => {
    for (const version of ['0.1.0-preview.1', '0.1.0-preview.2', '0.1.0-rc.1']) {
      const request = parseCutArgs(['--version', version, ...BASE.slice(2)])
      expect(localReleaseArgs(request)).toContain('--notes')
      expect(planSteps(request).map(step => step.id)).toEqual(['tree', 'probe', 'changelog', 'highlights', 'clear-stages', 'closure', 'sign', 'verify', 'smoke'])
    }
  })

  it('never allows the builder\'s paths in the signed closure unless the person passes --allow-builder-paths', () => {
    expect(parseCutArgs(BASE)).toMatchObject({ artifacts: 'existing', allowBuilderPaths: false })
    expect(localReleaseArgs(parseCutArgs(BASE))).not.toContain('--allow-builder-paths')
    expect(localReleaseArgs(parseCutArgs([...BASE, '--artifacts', 'build']))).not.toContain('--allow-builder-paths')
    expect(localReleaseArgs(parseCutArgs([...BASE, '--allow-builder-paths']))).toContain('--allow-builder-paths')
  })

  it('accepts a private test build between two candidates and names it in the default summary', () => {
    expect(parseCutArgs(['--version', '0.1.0-preview.1.1', ...BASE.slice(2)])).toMatchObject({ kind: 'preview', number: 1, iteration: 1, summary: 'Preview 1.1.', highlights: '/c/notes-0.1.0-preview.1.1.txt' })
    expect(parseCutArgs(BASE)).toMatchObject({ iteration: undefined, summary: 'Release candidate 2.' })
  })

  it('updates an iteration from the one before it and the first iteration from its preview', () => {
    const at = (version: string) => parseCutArgs(['--version', version, ...BASE.slice(2)])
    expect(previousCandidate(at('0.1.0-preview.1.1'), ['0.1.0-preview.1'])).toBe('0.1.0-preview.1')
    expect(previousCandidate(at('0.1.0-preview.1.2'), ['0.1.0-preview.1', '0.1.0-preview.1.1'])).toBe('0.1.0-preview.1.1')
    expect(previousCandidate(at('0.1.0-preview.1'), [])).toBeUndefined()
  })

  it('updates a plain candidate from the newest lower candidate of its series, which may be an iteration', () => {
    const at = (version: string) => parseCutArgs(['--version', version, ...BASE.slice(2)])
    expect(previousCandidate(at('0.1.0-preview.2'), ['0.1.0-preview.1', '0.1.0-preview.1.1'])).toBe('0.1.0-preview.1.1')
    expect(previousCandidate(at('0.1.0-preview.2'), ['0.1.0-preview.1'])).toBe('0.1.0-preview.1')
    expect(previousCandidate(at('0.1.0-preview.2'), ['0.1.0-preview.1.1', '0.1.0-preview.3', '0.1.0-rc.1', '0.2.0-preview.1'])).toBe('0.1.0-preview.1.1')
    expect(previousCandidate(at('0.1.0-preview.2'), ['0.1.0-rc.1'])).toBeUndefined()
    expect(previousCandidate(at('0.1.0-rc.1'), ['0.1.0-preview.2'])).toBeUndefined()
  })

  it('plans the highlights step and drops the build steps with --closures-from', () => {
    expect(planSteps(parseCutArgs([...BASE, '--closures-from', '/x'])).map(step => step.id)).toEqual(['tree', 'probe', 'changelog', 'highlights', 'sign', 'verify', 'smoke'])
  })

  it('ends with the installed-release smoke against the channel, within its budget, unless --no-smoke', () => {
    const request = parseCutArgs([...BASE, '--smoke-minutes', '20'])
    expect(smokeArgs(request)).toEqual(['delorun/apps/release/scripts/installed-smoke.ts', '--channel', request.channel, '--version', '0.1.0-rc.2', '--keys', request.keys, '--budget-minutes', '20', '--log', join(request.work, 'installed-smoke-0.1.0-rc.2.log')])
    expect(planSteps(request).at(-1)?.title).toContain('at most 20 min')
    expect(planSteps(parseCutArgs([...BASE, '--no-smoke'])).map(step => step.id)).not.toContain('smoke')
    expect(parseCutArgs(BASE).smokePrevious).toBeUndefined()
    expect(smokeArgs(parseCutArgs([...BASE, '--smoke-previous', '0.1.0-rc.1'])).slice(-2)).toEqual(['--previous', '0.1.0-rc.1'])
    expect(() => parseCutArgs([...BASE, '--smoke-minutes', '0'])).toThrow(/--smoke-minutes/u)
  })

  it('passes key files by path and prints the by-hand commands in --dry-run', () => {
    const lines: string[] = []
    printPlan(parseCutArgs(BASE), line => lines.push(line))
    const text = lines.join('\n')
    expect(text).toContain('/k/targets.pem')
    expect(text).not.toContain('PRIVATE KEY')
    expect(text).toContain('git tag -a v0.1.0-rc.2 abc123')
    expect(text).toContain('rc update --check')
    expect(text).toContain('--log-poll-seconds 30')
  })
})
