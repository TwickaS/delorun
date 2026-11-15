import { describe, expect, it } from 'vitest'
import { statementLines } from '../../src/setup/sections.ts'

describe('the update-check statement', () => {
  it('names releases.delorun.com and GitHub on the production channel', () => {
    const text = statementLines().join('\n')
    expect(text).toContain('from releases.delorun.com and the newest release\'s manifest and log record from GitHub')
  })

  it('names only the channel origin of a launcher built for another channel', () => {
    const text = statementLines('http://127.0.0.1:18080').join('\n')
    expect(text).toContain('all from 127.0.0.1:18080')
    expect(text).not.toContain('releases.delorun.com')
    expect(text).not.toContain('GitHub')
  })
})
