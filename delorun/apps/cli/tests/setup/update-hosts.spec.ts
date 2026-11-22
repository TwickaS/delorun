import { describe, expect, it } from 'vitest'
import { statementLines } from '../../src/setup/sections.ts'

describe('the update-check statement', () => {
  it('names releases.delorun.com and GitHub on the production channel', () => {
    const text = statementLines().join('\n')
    expect(text).toContain('About once a day Delorun checks releases.delorun.com and GitHub for a newer release.')
    expect(text).toContain('It sends nothing about you or your plugins; those sites see this computer\'s address.')
  })

  it('names releases.delorun.com and GitHub when the production origin is recorded', () => {
    for (const origin of ['https://releases.delorun.com', 'https://releases.delorun.com/']) {
      const text = statementLines(origin).join('\n')
      expect(text).toContain('About once a day Delorun checks releases.delorun.com and GitHub for a newer release.')
      expect(text).not.toContain('the release channel this launcher was built for')
    }
  })

  it('names only the channel origin of a launcher built for another channel', () => {
    const text = statementLines('http://127.0.0.1:18080').join('\n')
    expect(text).toContain('all from 127.0.0.1:18080')
    expect(text).not.toContain('releases.delorun.com')
    expect(text).not.toContain('GitHub')
  })
})
