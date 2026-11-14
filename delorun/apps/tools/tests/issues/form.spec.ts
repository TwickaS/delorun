import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { BRIEF_FIELDS, BRIEF_LABEL, MODEL_VALUES } from '../../src/issues/brief.ts'
import { LABELS_PATH, parseLabels } from '../../src/issues/labels.ts'
import { REPO } from '../gates/support.ts'

const FORM_PATH = '.github/ISSUE_TEMPLATE/brief.yml'

const formSchema = z.object({
  name: z.string(),
  labels: z.array(z.string()),
  body: z.array(z.object({
    type: z.string(),
    id: z.string().optional(),
    attributes: z.object({
      label: z.string().optional(),
      options: z.array(z.string()).optional(),
      value: z.string().optional(),
    }),
    validations: z.object({ required: z.boolean().optional() }).optional(),
  })),
})

const form = formSchema.parse(load(readFileSync(join(REPO, FORM_PATH), 'utf8')))

const fields = form.body.filter(entry => entry.type !== 'markdown')

describe('the brief issue form', () => {
  it('starts with a note that only maintainers file briefs', () => {
    const [note] = form.body
    expect(note?.type).toBe('markdown')
    expect(String(note?.attributes.value)).toContain('Only a maintainer files a brief')
  })

  it('asks for the template fields exactly, in the template order', () => {
    expect(fields.map(entry => entry.attributes.label)).toEqual([...BRIEF_FIELDS])
  })

  it('requires every field and gives each a distinct id', () => {
    expect(fields.every(entry => entry.validations?.required === true)).toBe(true)
    const ids = fields.map(entry => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('offers exactly the allowed model values, and never Opus at max effort', () => {
    const model = fields.find(entry => entry.attributes.label === 'Model')
    expect(model?.type).toBe('dropdown')
    expect(model?.attributes.options).toEqual([...MODEL_VALUES])
    expect(model?.attributes.options).not.toContain('Opus at max effort')
  })

  it('labels each brief with brief, which the label file defines', () => {
    expect(form.labels).toEqual([BRIEF_LABEL])
    const parsed = parseLabels(readFileSync(join(REPO, LABELS_PATH), 'utf8'))
    expect(parsed.labels.map(label => label.name)).toContain(BRIEF_LABEL)
  })
})
