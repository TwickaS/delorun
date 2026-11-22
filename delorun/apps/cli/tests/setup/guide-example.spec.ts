import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAnswers } from '../../src/setup/answers.ts'

const GUIDE = join(import.meta.dirname, '../../../../docs/guide/get-started/install.md')

describe('the install guide’s setup answers example', () => {
  it('is a complete answers document that --config accepts', () => {
    const match = /```json setup-answers-example\n([^]*?)\n\s*```/u.exec(readFileSync(GUIDE, 'utf8'))
    expect(match).not.toBeNull()
    const result = parseAnswers(JSON.parse((match?.[1] ?? '').replace(/^ {2}/gmu, '')))
    expect(result.success).toBe(true)
  })
})
