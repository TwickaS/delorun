// @vitest-environment jsdom
/**
 * Parity between the website replica's simplified chat and the product's real chat. The product's side renders the real
 * transcript in `product/replica-outline.client.spec.tsx` (React 18) and commits what a person can read and press as
 * `ordinary-work.outline.json`, one scene per chapter end; this spec renders only the replica (React 19) from the same
 * fixture and holds it to that file. It sees each scene's user and assistant message text, each tool row's visible title,
 * command and status word, and the buttons a person can press: the approval card's (the real card, while a command waits)
 * and the composer's send button. The two outlines must list the same items in the same order, but for
 * {@link ALLOWED_DIFFERENCES}; a dropped button, a changed label, title or status, or an allowance that matches nothing
 * fails. It cannot see layout, colours, icons, timestamps, step grouping or the folded tool output, text that is only
 * visually hidden (the running status, the textbox's accessible label), or the status of a call that fails, which the
 * fixture has none of. Takes about 6 s (module loading; each mount takes milliseconds).
 * @module @delorun/website/tests/replica-parity.client.spec
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRoot, type Root } from 'react-dom/client'
import { act, type ReactNode } from 'react'
import strings from 'virtual:replica-strings'
import { afterEach, describe, expect, it } from 'vitest'
import { en as consentsEn } from '../../../packages/bundle-local/src/client/consents-locales.ts'
import type { ReplicaEvent } from '../src/replica/model.ts'
import { differences, outlineOf, parseOutline, scenesOf, type AllowedDifference, type Outline, type OutlineSelectors } from '../src/replica/outline.ts'
import { ChatScreen } from '../src/replica/screens/ChatScreen.tsx'
import { RealApproval } from '../src/replica/screens/real.tsx'
import { CHAPTER_FILES } from '../src/replica/sessions/index.ts'
import { FIXTURE } from '../src/replica/sessions/ordinary-work.session.ts'
import type { ReplicaStrings } from '../src/replica/strings.ts'

// The site renders with React 19; this spec mounts through `react-dom/client` itself so no other React copy renders.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mounted: Root[] = []

/**
 * Mount an element in a fresh container.
 * @param element - the element.
 * @returns the container.
 */
function mount(element: ReactNode): HTMLElement {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  mounted.push(root)
  act(() => { root.render(element) })
  return container
}

/**
 * Wait until a check stops throwing.
 * @param check - the check.
 * @param timeout - how long to try, in milliseconds.
 */
async function until(check: () => unknown, timeout = 10_000): Promise<void> {
  const end = Date.now() + timeout
  for (;;) {
    try {
      await act(async () => { await check() })
      return
    } catch (error) {
      if (Date.now() > end) throw error
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    }
  }
}

afterEach(() => {
  for (const root of mounted.splice(0)) act(() => { root.unmount() })
  document.body.replaceChildren()
})

/**
 * How the replica's markup maps to items: its `data-from` bubbles; the tool row's title, command and any visible span
 * besides them (the status word; the row draws none, and its dot and hidden status are left out); the real approval
 * card's buttons and the button that follows the composer's textbox.
 */
const REPLICA: OutlineSelectors = {
  readable: '[data-from], [data-status] [class*="_title_"], [data-status] code, [data-status] span:not([class*="_title_"]):not([class*="_hidden_"]):not([aria-hidden="true"])',
  buttons: '[data-approval-key] button, [role="textbox"] + button',
  kindOf: element => element.tagName === 'CODE' ? 'command'
    : element.matches('[data-status] *') ? element.matches('[class*="_title_"]') ? 'title' : 'status'
    : element.getAttribute('data-from') === 'person' ? 'user' : 'assistant',
}

/** What the replica may list that the product's outline lacks, or the reverse. Everything else must be equal. */
const ALLOWED_DIFFERENCES: readonly AllowedDifference[] = [
  { kind: 'group', reason: 'the product folds its tool calls into a step group ("Ran commands"); the replica draws one flat row' },
  { kind: 'button', text: consentsEn['action.allowForChat'], reason: "the card the site draws is Delorun's, with its \"Allow for this chat\" choice; the product render has upstream's approval plugin alone" },
]

/** The product's committed outline. */
const PRODUCT_OUTLINE: Outline = parseOutline(readFileSync(resolve(import.meta.dirname, '../src/replica/sessions/ordinary-work.outline.json'), 'utf8'))

/**
 * Read every scene from the replica.
 * @param events - the fixture's rows.
 * @param text - the replica's text.
 * @returns the outline of each chapter end; a scene that leaves an approval waiting draws the real card.
 */
async function replicaOutline(events: readonly ReplicaEvent[], text: ReplicaStrings = strings): Promise<Outline> {
  const outline: Outline[number][] = []
  for (const scene of scenesOf(CHAPTER_FILES['ordinary-work'], events)) {
    const container = mount(<ChatScreen events={scene.events} shown={scene.events.length} draft="" typing={false} strings={text}
      approval={pending => <RealApproval pending={pending} />} />)
    const ready = scene.pending === undefined ? '[role="textbox"]' : '[data-approval-key]'
    await until(() => { if (container.querySelector(ready) === null) throw new Error(`the replica has no ${ready}`) })
    outline.push(outlineOf(container, scene.id, REPLICA))
  }
  return outline
}

describe('replica chat parity', () => {
  it('lists the items the product does, in every chapter of the fixture', async () => {
    const replica = await replicaOutline(FIXTURE.events)
    expect(differences(PRODUCT_OUTLINE, replica, ALLOWED_DIFFERENCES)).toBeUndefined()
    expect(replica.map(scene => scene.scene)).toEqual(PRODUCT_OUTLINE.map(scene => scene.scene))
  })

  it('reports a difference when the replica text drifts', async () => {
    const drifted = FIXTURE.events.map((row): ReplicaEvent => row.type === 'assistant/message' && row.data.step === 2
      ? { ...row, data: { ...row.data, message: { ...row.data.message, content: [{ type: 'text', text: 'The project has 215 tests in 31 files, and all of them pass.' }] } } }
      : row)
    expect(differences(PRODUCT_OUTLINE, await replicaOutline(drifted), ALLOWED_DIFFERENCES)).toContain('215 tests')
  })

  it('reports a difference when the replica names the tool differently', async () => {
    const renamed: ReplicaStrings = { ...strings, conversation: { ...strings.conversation, 'tool.title.bash': 'Command' } }
    expect(differences(PRODUCT_OUTLINE, await replicaOutline(FIXTURE.events, renamed), ALLOWED_DIFFERENCES)).toContain('title: Command')
  })

  it('reports a dropped button, an unlisted button and an allowance that matches nothing', () => {
    const edit = (change: (items: Outline[number]['items']) => Outline[number]['items']): Outline => PRODUCT_OUTLINE.map(scene => ({ scene: scene.scene, items: change(scene.items) }))
    expect(differences(PRODUCT_OUTLINE, edit(items => items.filter(item => item.text !== 'Reject')), ALLOWED_DIFFERENCES)).toContain('items differ')
    expect(differences(PRODUCT_OUTLINE, edit(items => [...items, { kind: 'button', text: 'Surprise' }]), ALLOWED_DIFFERENCES)).toContain('button: Surprise')
    expect(differences(PRODUCT_OUTLINE, PRODUCT_OUTLINE, [{ kind: 'status', reason: 'nothing draws one' }])).toContain('allowed difference matches nothing')
  })
})
