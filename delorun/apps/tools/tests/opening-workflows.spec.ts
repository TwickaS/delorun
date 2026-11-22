import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classify, KEPT, KEPT_CI_JOBS, keepJobs, REMOVED } from '../src/opening/workflows.ts'

const repository = resolve(import.meta.dirname, '../../../..')
const workflowDirectory = join(repository, '.github', 'workflows')

describe('opening workflows', () => {
  it('reports a file in neither list, a kept file that is missing and a removed file still present', () => {
    expect(classify(['gates.yml', 'new.yml', 'release.yml'])).toEqual({
      unclassified: ['new.yml'],
      missing: ['expected-filenames.yml', 'ci.yml'],
      remaining: ['release.yml'],
    })
  })

  it('keeps no workflow in both lists', () => {
    expect(Object.keys(KEPT).filter(name => name in REMOVED)).toEqual([])
  })

  it('keeps the named jobs with the comments above them and drops the others from `needs`', () => {
    const text = [
      'name: CI',
      'jobs:',
      '',
      '  # kept comment',
      '  keep:',
      '    runs-on: ubuntu-latest',
      '',
      '  # dropped comment',
      '  drop:',
      '    runs-on: ubuntu-latest',
      '',
      '  verdict:',
      '    needs: [keep, drop]',
      '',
    ].join('\n')
    expect(keepJobs(text, ['keep', 'verdict'])).toBe([
      'name: CI',
      'jobs:',
      '',
      '  # kept comment',
      '  keep:',
      '    runs-on: ubuntu-latest',
      '',
      '  verdict:',
      '    needs: [keep]',
      '',
    ].join('\n'))
  })

  it('leaves this repository with exactly the kept workflows and the kept jobs of ci.yml', () => {
    const files = readdirSync(workflowDirectory).filter(name => name.endsWith('.yml'))
    expect(classify(files)).toEqual({ unclassified: [], missing: [], remaining: [] })
    const ciJobs = [...readFileSync(join(workflowDirectory, 'ci.yml'), 'utf8').matchAll(/^ {2}([a-z0-9-]+):\s*$/gmu)]
      .map(match => match[1])
    expect(ciJobs).toEqual([...KEPT_CI_JOBS])
  })
})
