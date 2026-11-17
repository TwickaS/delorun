/** A production build carries only real sessions recorded on the release the site markets, unless SITE_ALLOW_STANDINS=1 marks a review build. */
import { describe, expect, it } from 'vitest'
import { sessionRefusals } from '../src/replica/build/release.ts'
import { SESSION_IDS } from '../src/replica/model.ts'
import { loadFixture } from '../src/replica/sessions/index.ts'

const recorded = { id: 'ordinary-work', standIn: false, release: '0.1.0' } as const

describe('sessionRefusals', () => {
  it('accepts a recording made on the marketed release', () => {
    expect(sessionRefusals([recorded], { release: '0.1.0', allowStandIns: false })).toEqual([])
  })

  it('refuses a stand-in and a recording from another release', () => {
    expect(sessionRefusals([{ ...recorded, standIn: true }], { release: '0.1.0', allowStandIns: false })).toEqual(['ordinary-work is a hand-made stand-in, not a recording.'])
    expect(sessionRefusals([{ ...recorded, release: '0.1.0-preview.2' }], { release: '0.1.0', allowStandIns: false })).toEqual(['ordinary-work was recorded on 0.1.0-preview.2, and the site markets 0.1.0.'])
  })

  it('accepts both in a review build', () => {
    expect(sessionRefusals([{ ...recorded, standIn: true, release: '0.0.1' }], { release: '0.1.0', allowStandIns: true })).toEqual([])
  })

  it('refuses today\'s sessions outside a review build, since both are stand-ins', async () => {
    const fixtures = await Promise.all(SESSION_IDS.map(loadFixture))
    expect(sessionRefusals(fixtures, { release: fixtures[0]!.release, allowStandIns: false })).toHaveLength(SESSION_IDS.length)
  })
})
