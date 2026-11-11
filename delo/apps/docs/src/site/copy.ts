/**
 * The site's own interface strings, by locale. Page text comes from the Delo pages; these are the site's labels.
 *
 * @module @delo/docs/copy
 */
import type { Locale } from './locale.ts'

/** The labels one locale shows. */
export interface Copy {
  readonly siteTitle: string
  readonly homeIntro: string
  readonly guideLabel: string
  readonly referenceLabel: string
  /** The other locale's name, written in that locale, which this locale's pages show as the link to their counterpart. */
  readonly switchTo: string
  /** The description of that link, in this locale. */
  readonly switchLabel: string
  readonly describes: (version: string) => string
  readonly sectionNames: { readonly guide: string, readonly reference: string }
  readonly productLabel: string
  readonly notFoundTitle: string
  readonly notFoundText: string
}

/** The labels by locale. */
export const COPY: Readonly<Record<Locale, Copy>> = {
  en: {
    siteTitle: 'Delo documentation',
    homeIntro: 'Documentation for Delo: the user guide for people who use Delo, and the references that define its current behaviour and terms.',
    guideLabel: 'User guide',
    referenceLabel: 'Reference',
    switchTo: '中文',
    switchLabel: 'Read this page in Chinese',
    describes: version => `This page describes Delo ${version}.`,
    sectionNames: { guide: 'User guide', reference: 'Reference' },
    productLabel: 'Delo Run',
    notFoundTitle: 'Page not found',
    notFoundText: 'No page has this address. The documentation starts at its home page.',
  },
  zh: {
    siteTitle: 'Delo 文档',
    homeIntro: '这里是 Delo 的文档：面向使用者的用户指南，以及定义其当前行为和术语的参考资料。',
    guideLabel: '用户指南',
    referenceLabel: '参考资料',
    switchTo: 'English',
    switchLabel: '阅读英文版本',
    describes: version => `本页描述 Delo ${version}。`,
    sectionNames: { guide: '用户指南', reference: '参考资料' },
    productLabel: 'Delo Run',
    notFoundTitle: '页面不存在',
    notFoundText: '没有页面使用此地址。文档从其首页开始。',
  },
}
