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
  /** The home page's entry points: where a new reader, a reader with a task and a developer each begin. */
  readonly entries: {
    readonly newTitle: string
    readonly newText: string
    readonly taskTitle: string
    readonly taskText: string
    readonly developerTitle: string
    readonly developerText: string
  }
  readonly sectionNames: { readonly guide: string, readonly reference: string }
  readonly productLabel: string
  readonly notFoundTitle: string
  readonly notFoundText: string
}

/** The labels by locale. */
export const COPY: Readonly<Record<Locale, Copy>> = {
  en: {
    siteTitle: 'Delo documentation',
    homeIntro: 'Documentation for Delo. The user guide is for people who install and use Delo, in plain English. The reference starts with a glossary of plain-English definitions and goes on to precise pages for developers and maintainers.',
    guideLabel: 'User guide',
    referenceLabel: 'Reference',
    switchTo: '中文',
    switchLabel: 'Read this page in Chinese',
    describes: version => `This page describes Delo ${version}.`,
    entries: {
      newTitle: "I'm new: start here",
      newText: 'Install Delo and open your first chat, step by step.',
      taskTitle: 'I want to do something',
      taskText: 'The guide index lists every task by what you want to do: daily use, switching, updates, remote access, safety and troubleshooting.',
      developerTitle: "I'm a developer",
      developerText: 'The reference: the glossary, the divergence ledger from upstream, the parity checklist and the other pages for maintainers.',
    },
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
    entries: {
      newTitle: '我是新用户：从这里开始',
      newText: '安装 Delo，并逐步打开第一个对话。',
      taskTitle: '我想做某件事',
      taskText: '用户指南的目录按你想做的事列出所有任务：日常使用、迁移、更新、远程访问、安全与故障排除。',
      developerTitle: '我是开发者',
      developerText: '参考资料：术语表、与上游的差异记录、一致性清单，以及面向维护者的其他页面。',
    },
    sectionNames: { guide: '用户指南', reference: '参考资料' },
    productLabel: 'Delo Run',
    notFoundTitle: '页面不存在',
    notFoundText: '没有页面使用此地址。文档从其首页开始。',
  },
}
