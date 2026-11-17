/** Each product label a caption names is the product's own English text, so a renamed control fails here. */
import { describe, expect, it } from 'vitest'
import { en as approval } from '#studio/ui-approval/src/client/locales.ts'
import { en as changes } from '../../../packages/plugin-changes/src/client/locales.ts'
import { en as consents } from '../../../packages/bundle-local/src/client/consents-locales.ts'
import { en as versions } from '../../../packages/bundle-local/src/client/versions-locales.ts'
import { en as layout } from '../../../packages/plugin-settings-layout/src/client/locales.ts'
import { CHAPTER_FILES } from '../src/replica/sessions/index.ts'

/** The labels each chapter's caption names, by session and chapter id. */
const NAMED: Readonly<Record<string, readonly string[]>> = {
  'ordinary-work/asks-first': ['Allow once', 'Allow for this chat'],
  'changes-and-versions/listed': ['Changes'],
  'changes-and-versions/undo': ['Undo'],
  'changes-and-versions/versions': ['Setup versions', 'Switch to this version'],
}

const PRODUCT_TEXT = new Set<string>([approval, changes, consents, versions, layout].flatMap(dictionary => Object.values(dictionary)))

describe('the captions', () => {
  for (const [key, labels] of Object.entries(NAMED)) {
    it(`${key} names only labels the product shows`, () => {
      const [session, id] = key.split('/') as [keyof typeof CHAPTER_FILES, string]
      const caption = CHAPTER_FILES[session].chapters.find(chapter => chapter.id === id)?.caption
      expect(caption, key).toBeDefined()
      for (const label of labels) {
        expect(caption, label).toContain(label)
        expect(PRODUCT_TEXT.has(label), label).toBe(true)
      }
    })
  }
})
