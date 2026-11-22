/**
 * The site's own interface strings, by locale. Page text comes from the Delorun pages; these are the site's labels.
 *
 * @module @delorun/docs/copy
 */
import type { Locale } from './locale.ts'
import type { Section } from './routes.ts'

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
  /** The home page's description, which link previews and search results show. */
  readonly homeDescription: string
  /** The home page's entry points, each a person's aim and the page that serves it. */
  readonly entries: readonly {
    readonly title: string
    readonly text: string
    readonly section: Section
    readonly slugs: readonly string[]
  }[]
  /** The changelog page and the home page's What's new section, which the build omits when no version is assembled. */
  readonly changelog: {
    /** The page's title, its heading and the header of the home section's link. */
    readonly title: string
    /** The page's opening sentence. */
    readonly intro: string
    /** The home section's heading. */
    readonly whatsNew: string
    /** The home section's latest-version line. */
    readonly latest: (version: string, date: string) => string
    /** The home section's link to the page. */
    readonly full: string
    /** The heading of the upstream block that ends each version. */
    readonly fromUpstream: string
  }
  /** The header's links to the site's own pages. */
  readonly nav: { readonly guide: string, readonly reference: string, readonly changelog: string, readonly roadmap: string }
  readonly sectionNames: { readonly guide: string, readonly reference: string }
  readonly productLabel: string
  readonly notFoundTitle: string
  readonly notFoundText: string
}

/** The labels by locale. */
export const COPY: Readonly<Record<Locale, Copy>> = {
  en: {
    siteTitle: 'Delorun Docs',
    homeIntro: 'Documentation for Delorun, the agent harness you shape to your own work. The user guide helps you install it, make it yours, use it day to day, reach it from your phone and fix what goes wrong, in plain English. The glossary explains every term the guide uses. The developer reference is for developers and maintainers.',
    homeDescription: 'Install Delorun, make it yours, use it day to day, reach it from your phone and fix what goes wrong. A plain-English guide and a developer reference.',
    guideLabel: 'User guide',
    referenceLabel: 'Developer reference',
    switchTo: '中文',
    switchLabel: 'Read this page in Chinese',
    describes: version => `This page describes Delorun ${version}.`,
    entries: [
      { title: "I'm new: start here", text: 'Install Delorun and open your first chat, step by step.', section: 'guide', slugs: ['get-started', 'install'] },
      { title: 'I want to make it mine', text: 'Change the look, settings and plugins, and see what you can undo.', section: 'guide', slugs: ['customising', 'customise'] },
      { title: 'Is this safe? What is this?', text: 'What Delorun protects, what you trust when you use it, and honest answers to the hard questions.', section: 'guide', slugs: ['help', 'questions'] },
      { title: 'I want to do something', text: 'The guide index lists every task by what you want to do: daily use, switching, updates, remote access, safety, troubleshooting and the roadmap.', section: 'guide', slugs: [] },
      { title: "I'm a developer", text: 'The developer reference: terms, how the pieces fit and the other pages for maintainers.', section: 'reference', slugs: [] },
    ],
    changelog: {
      title: 'Changelog',
      intro: 'What changed in each Delorun version, newest first, and how Delorun differs from DeepSeek Harness. The entries are in English.',
      whatsNew: "What's new",
      latest: (version, date) => `Delorun ${version}, ${date}`,
      full: 'Full changelog',
      fromUpstream: 'From upstream',
    },
    nav: { guide: 'Guide', reference: 'Reference', changelog: 'Changelog', roadmap: 'Roadmap' },
    sectionNames: { guide: 'User guide', reference: 'Developer reference' },
    productLabel: 'Delorun',
    notFoundTitle: 'Page not found',
    notFoundText: 'No page has this address. The documentation starts at its home page.',
  },
  zh: {
    siteTitle: 'Delorun 文档',
    homeIntro: 'Delorun 的文档。Delorun 是一个按你自己的工作方式来塑造的 harness（智能体框架）。用户指南用平实的语言帮助你安装它、让它成为你的、日常使用它、用手机访问它，并解决出现的问题。术语表解释指南用到的每个术语。开发者参考面向开发者和维护者。',
    homeDescription: '安装 Delorun，让它成为你的，日常使用，用手机访问，并解决出现的问题。一份平实的指南和一份开发者参考。',
    guideLabel: '用户指南',
    referenceLabel: '开发者参考',
    switchTo: 'English',
    switchLabel: '阅读英文版本',
    describes: version => `本页描述 Delorun ${version}。`,
    entries: [
      { title: '我是新用户：从这里开始', text: '安装 Delorun，并逐步打开第一个对话。', section: 'guide', slugs: ['get-started', 'install'] },
      { title: '我想让它成为我的', text: '更改外观、设置和插件，并了解哪些改动可以撤销。', section: 'guide', slugs: ['customising', 'customise'] },
      { title: '这安全吗？这是什么？', text: 'Delorun 保护什么、使用它时你要信任什么，以及对难回答问题的坦诚解答。', section: 'guide', slugs: ['help', 'questions'] },
      { title: '我想做某件事', text: '用户指南的目录按你想做的事列出所有任务：日常使用、迁移、更新、远程访问、安全、故障排除与路线图。', section: 'guide', slugs: [] },
      { title: '我是开发者', text: '开发者参考：术语、各部分如何配合，以及面向维护者的其他页面。', section: 'reference', slugs: [] },
    ],
    changelog: {
      title: '更新日志',
      intro: '每个 Delorun 版本的变化（最新版本在前），以及 Delorun 与 DeepSeek Harness 的差异。条目为英文。',
      whatsNew: '新内容',
      latest: (version, date) => `Delorun ${version}，${date}`,
      full: '完整更新日志',
      fromUpstream: '来自上游',
    },
    nav: { guide: '指南', reference: '参考资料', changelog: '更新日志', roadmap: '路线图' },
    sectionNames: { guide: '用户指南', reference: '开发者参考' },
    productLabel: 'Delorun',
    notFoundTitle: '页面不存在',
    notFoundText: '没有页面使用此地址。文档从其首页开始。',
  },
}
