/** The deprecated PresentationInjected export keeps the face a stock plugin declares. */
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { PresentationInjected } from '../src/client/index.ts'
import { presentationPolicyFor, type ChatPresentationPolicy } from '../src/client/presentation-policy.ts'

describe('PresentationInjected (deprecated export)', () => {
  it('lets a stock face extend it and supply the policy source it declares', () => {
    // oxlint-disable-next-line typescript/no-deprecated -- The spec exercises the deprecated export on purpose.
    interface StockFace extends PresentationInjected {
      readonly resolveFilePath: (path: string) => string
    }
    const policy = presentationPolicyFor('detailed')
    const presentation: ObservableSnapshot<ChatPresentationPolicy> = { getSnapshot: () => policy, subscribe: () => () => {} }
    const face: StockFace = { hooks: { presentation }, resolveFilePath: path => path }
    expect(face.hooks.presentation.getSnapshot()).toBe(policy)
    // oxlint-disable-next-line typescript/no-deprecated -- The spec exercises the deprecated export on purpose.
    expectTypeOf<PresentationInjected['hooks']['presentation']>().toEqualTypeOf<ObservableSnapshot<ChatPresentationPolicy>>()
  })
})
