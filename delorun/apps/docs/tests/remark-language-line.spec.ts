/** The site drops a bare language-name paragraph from a page, and keeps every other paragraph. */
import type { Paragraph, Root, Text } from 'mdast'
import { describe, expect, it } from 'vitest'
import { dropLanguageLine } from '../src/site/remark-delorun.ts'

const paragraph = (value: string): Paragraph => ({ type: 'paragraph', children: [{ type: 'text', value } as Text] })

describe('the page language line', () => {
  it('drops a bare English paragraph under the title', () => {
    const tree: Root = { type: 'root', children: [{ type: 'heading', depth: 1, children: [{ type: 'text', value: 'Title' }] }, paragraph('English'), paragraph('Body.')] }
    dropLanguageLine(tree)
    expect(tree.children.map(node => node.type)).toEqual(['heading', 'paragraph'])
    expect(tree.children[1]).toEqual(paragraph('Body.'))
  })

  it('keeps a paragraph that names English among other text, such as a line with a Chinese link', () => {
    const tree: Root = { type: 'root', children: [paragraph('English and more.'), paragraph('English | 中文')] }
    dropLanguageLine(tree)
    expect(tree.children).toHaveLength(2)
  })
})
