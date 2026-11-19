/** The page's reach for a live agent's approvals: only the computer's own page grants. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { provideAgentSeatReach } from '../src/client/agent-seat-reach.ts'

describe('the live agent reach', () => {
  it('counts the computer\'s own page as the computer', () => {
    const ctx = new Context()
    provideAgentSeatReach(ctx, true)
    expect(ctx.get('agentSeatReach')?.get()).toEqual({ kind: 'computer' })
  })

  // Treating a PIN-unlocked phone as able to grant lets a page lock stand in for a confirmation of each answer (F36).
  it('provides nothing on a phone, so its cards offer Reject only', () => {
    const ctx = new Context()
    provideAgentSeatReach(ctx, false)
    expect(ctx.get('agentSeatReach')).toBeUndefined()
  })
})
