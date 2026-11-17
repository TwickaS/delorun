import { describe, expect, it } from 'vitest'
import { COPY_ANSWER_MS } from '@brand/components/CodeBlock.tsx'

describe('the @brand/* alias', () => {
  it('imports one brand file without the barrel', () => {
    expect(COPY_ANSWER_MS).toBeGreaterThan(0)
  })
})
