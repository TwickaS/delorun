// @vitest-environment jsdom
/** A registration's own presentation source takes precedence over the seat's live policy in the assistant renderer. */
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { bindSnapshotSelector, contextMenuHook, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locale.ts'
import { AssistantNodeView } from '../src/client/chat/AssistantNodeView.tsx'
import { useDisclosure } from '../src/client/chat/use-disclosure.ts'
import { useSearchableHidden } from '../src/client/chat/searchable-hidden.ts'
import { DEFAULT_CUSTOM_DISPLAY } from '../src/chat-settings.ts'
import { presentationPolicyFor, type ChatPresentationPolicy } from '../src/client/presentation-policy.ts'
import { renderReasoningSlot, unusedImageLoader } from './reasoning-component-fixture.tsx'

afterEach(() => {
  cleanup()
})

type AssistantProps = ComponentProps<typeof AssistantNodeView>

const t = makeTranslate(zh, commonZh)
// A stock registration's own source titles its reasoning; the seat's detailed mode previews it.
const registrationPolicy = presentationPolicyFor('custom', 'completion', 'all', { ...DEFAULT_CUSTOM_DISPLAY, thinking: 'title' })
const seatPolicy = presentationPolicyFor('detailed')

/** A selector hook over one policy, bound the way a registration's `hooks.presentation` source is bound. */
function policySource(policy: ChatPresentationPolicy) {
  return bindSnapshotSelector({ getSnapshot: () => policy, subscribe: () => () => {} })
}

function assistantProps(): AssistantProps {
  const fixture: Partial<AssistantProps> = {
    node: {
      key: 'assistant:1',
      kind: 'assistant-step',
      id: 'assistant-1',
      target: 'chat',
      anchorSeq: 1,
      location: { kind: 'session' },
      visibility: 'visible',
      data: { status: 'settled', turn: 1, step: 1, time: 1, blocks: [{ kind: 'reasoning', text: 'Weighing the options' }] },
    },
    useDisclosure,
    useGroupAction: useSearchableHidden,
    useTurnData: () => undefined,
    openFile: vi.fn(),
    loadImage: unusedImageLoader,
    fileMentions: vi.fn(),
    renderSlot: renderReasoningSlot,
    t,
    sessionId: 'session' as AssistantProps['sessionId'],
    useContextMenu: contextMenuHook(),
    resolveFilePath: path => path,
    useSeatPresentation: policySource(seatPolicy),
  }
  return fixture as AssistantProps
}

/** The reasoning row's display mode, which follows the policy the assistant renderer resolved. */
function reasoningDisplay(container: HTMLElement): string | null {
  return container.querySelector('[data-variant="think"]')?.getAttribute('data-thinking') ?? null
}

describe('AssistantNodeView presentation source', () => {
  it("gives a stock registration's own policy source precedence over the seat's live policy", () => {
    const view = render(<AssistantNodeView {...assistantProps()} usePresentation={policySource(registrationPolicy)} />)
    expect(reasoningDisplay(view.container)).toBe('title')
  })

  it("falls back to the seat's live policy when the registration supplies no source", () => {
    const view = render(<AssistantNodeView {...assistantProps()} />)
    expect(reasoningDisplay(view.container)).toBe('preview')
  })
})
