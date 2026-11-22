import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classify, KEPT, KEPT_CI_JOBS, keepJobs, REMOVED, workflowFiles } from '../src/opening/workflows.ts'

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

  it('lists both `.yml` and `.yaml` files, so a `.yaml` workflow is classified too', () => {
    const directory = mkdtempSync(join(tmpdir(), 'opening-workflows-'))
    try {
      for (const name of ['gates.yml', 'extra.yaml', 'notes.txt']) writeFileSync(join(directory, name), '')
      const files = workflowFiles(directory)
      expect(files).toEqual(['extra.yaml', 'gates.yml'])
      expect(classify(files).unclassified).toEqual(['extra.yaml'])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
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
    const files = workflowFiles(workflowDirectory)
    expect(classify(files)).toEqual({ unclassified: [], missing: [], remaining: [] })
    const ciJobs = [...readFileSync(join(workflowDirectory, 'ci.yml'), 'utf8').matchAll(/^ {2}([a-z0-9-]+):\s*$/gmu)]
      .map(match => match[1])
    expect(ciJobs).toEqual([...KEPT_CI_JOBS])
  })
})
