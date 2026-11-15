import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KINDS, LABELS_PATH, parseLabels } from '../../src/issues/labels.ts'
import { REPO } from '../gates/support.ts'

const LABELS_TEXT = readFileSync(join(REPO, LABELS_PATH), 'utf8')

/**
 * A label file with one entry, for the entry rules.
 * @param entry - the YAML text of the entry's keys, indented under the list item.
 * @returns the label file's text.
 */
function oneEntry(entry: string): string {
  return `- ${entry}\n`
}

describe('the label file', () => {
  it('parses with no problem, and defines brief, the six kinds, the areas, the batches and the plain labels', () => {
    const parsed = parseLabels(LABELS_TEXT)
    expect(parsed.errors).toEqual([])
    const names = parsed.labels.map(label => label.name)
    expect(names).toEqual(expect.arrayContaining(['brief', 'security', 'upstream-merge', 'parity', 'batch/0', 'batch/1', 'batch/2', 'batch/3']))
    expect(names.filter(name => name.startsWith('kind/'))).toEqual([...KINDS])
    expect(names.filter(name => name.startsWith('area/')).length).toBeGreaterThan(0)
  })

  it('refuses a kind alias the taxonomy retired, and a kind outside the closed set', () => {
    expect(parseLabels(oneEntry('name: kind/bug\n  color: "d73a4a"\n  description: "Retired."')).errors).toEqual([
      `${LABELS_PATH} labels[0] "kind/bug" is a retired alias`,
    ])
    expect(parseLabels(oneEntry('name: kind/design\n  color: "d73a4a"\n  description: "New."')).errors).toEqual([
      `${LABELS_PATH} labels[0] "kind/design" is not one of the kind labels`,
    ])
  })

  it('refuses a plain retired alias, an area that is not kebab case, a batch outside 0 to 3, and a label outside the set', () => {
    expect(parseLabels(oneEntry('name: feature\n  color: "0e8a16"\n  description: "Old alias."')).errors).toEqual([
      `${LABELS_PATH} labels[0] "feature" is a retired alias`,
    ])
    expect(parseLabels(oneEntry('name: area/Web\n  color: "bfdadc"\n  description: "Upper case."')).errors).toEqual([
      `${LABELS_PATH} labels[0] "area/Web" is not area/ followed by a lowercase kebab-case name`,
    ])
    expect(parseLabels(oneEntry('name: batch/4\n  color: "fef2c0"\n  description: "Too late."')).errors).toEqual([
      `${LABELS_PATH} labels[0] "batch/4" is not batch/0, batch/1, batch/2 or batch/3`,
    ])
    expect(parseLabels(oneEntry('name: team/core\n  color: "fef2c0"\n  description: "A team."')).errors).toEqual([
      `${LABELS_PATH} labels[0] "team/core" is not a label in Delorun's label set`,
    ])
  })

  it('refuses a colour that is not six hex digits, an unquoted colour and a description longer than GitHub allows', () => {
    expect(parseLabels(oneEntry('name: brief\n  color: "12345G"\n  description: "Bad colour."')).errors).toEqual([
      `${LABELS_PATH} labels[0].color: must be a six-digit hex colour`,
    ])
    expect(parseLabels(oneEntry('name: brief\n  color: 000000\n  description: "Unquoted colour."')).errors).toEqual([
      `${LABELS_PATH} labels[0].color: must be a six-digit hex colour, quoted`,
    ])
    const long = 'x'.repeat(101)
    expect(parseLabels(oneEntry(`name: brief\n  color: "5319e7"\n  description: "${long}"`)).errors).toEqual([
      `${LABELS_PATH} labels[0].description: is longer than 100 characters`,
    ])
  })

  it('refuses an entry with a missing key, an unknown key, and a name listed twice', () => {
    expect(parseLabels(oneEntry('name: brief\n  color: "5319e7"')).errors).toEqual([
      `${LABELS_PATH} labels[0].description: is missing`,
    ])
    expect(parseLabels(oneEntry('name: brief\n  color: "5319e7"\n  description: "Ok."\n  extra: 1')).errors[0]).toMatch(/unrecognized|Unrecognized/u)
    const twice = `${oneEntry('name: brief\n  color: "5319e7"\n  description: "One."')}${oneEntry('name: brief\n  color: "5319e7"\n  description: "Two."')}`
    expect(parseLabels(twice).errors).toEqual([`${LABELS_PATH} labels[1] "brief" is listed more than once`])
  })

  it('refuses text that is not YAML', () => {
    expect(parseLabels('- name: [unclosed\n').errors[0]).toMatch(/^\.github\/labels\.yml is not valid YAML/u)
  })
})
