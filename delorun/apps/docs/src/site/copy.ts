/**
 * The site's own interface strings, by locale. Page text comes from the Delorun pages; these are the site's labels.
 *
 * @module @delorun/docs/copy
 */
import type { Locale } from './locale.ts'
import type { Section } from './routes.ts'

/** A link on the home page to one page of the site, with the line that says what the page helps you do. */
export interface HomeLink {
  readonly title: string
  /** The line under the title; a command between backticks shows as code. */
  readonly text: string
  readonly section: Section
  readonly slugs: readonly string[]
}

/** The home page's own text. */
export interface HomeCopy {
  /** What Delorun is, in plain words, before the glossary link. */
  readonly lead: string
  /** The sentence that links the glossary, split around the link's text. */
  readonly glossary: { readonly before: string, readonly link: string, readonly after: string }
  /** The primary action, which opens Install and first run. */
  readonly install: string
  /** The second action, which opens Why Delorun. */
  readonly why: string
  /** The label before the install command. */
  readonly command: string
  /** Where Delorun runs, beside the command. */
  readonly platforms: string
  /** The two halves of the guide, as the sidebar names them, each with the pages that start it. */
  readonly groups: readonly { readonly title: string, readonly links: readonly HomeLink[] }[]
  /** The closing links: their heading, the guide's map of every task and the glossary; the roadmap and changelog links take the header's labels. */
  readonly more: { readonly title: string, readonly everyTask: string, readonly glossary: string }
}

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
  /** The home page's body below its title: what Delorun is, the two first actions and the two maps of the site. */
  readonly home: HomeCopy
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
    homeIntro: 'Documentation for Delorun, a program that runs on your own computer and lets an AI model work on your files and run commands, asking before risky steps. The user guide helps you install it, use it day to day, reach it from your phone, make it yours and fix what goes wrong, in plain English. The glossary explains every term the guide uses, and the reference holds the notes for people who maintain Delorun.',
    homeDescription: 'Install Delorun, use it day to day, reach it from your phone, make it yours and fix what goes wrong. A plain-English guide, a glossary and a reference.',
    guideLabel: 'User guide',
    referenceLabel: 'Reference',
    switchTo: '中文',
    switchLabel: 'Read this page in Chinese',
    describes: version => `This page describes Delorun ${version}.`,
    home: {
      lead: 'Delorun is a program that runs on your own computer and lets an AI model work on your files and run commands. You chat with it in a studio that opens in your browser, and on your phone too, and it asks before risky steps such as giving a folder full access. It is open source and built on DeepSeek Harness.',
      glossary: { before: 'Every term these pages use is in the ', link: 'glossary', after: '.' },
      install: 'Install Delorun',
      why: 'Why Delorun',
      command: 'One command:',
      platforms: 'Linux (x64), and Windows through WSL2.',
      groups: [
        {
          title: 'Using Delorun',
          links: [
            { title: 'Install and first run', text: 'One command, a few questions and your first chat.', section: 'guide', slugs: ['get-started', 'install'] },
            { title: 'Daily use', text: 'Start, open and stop Delorun, and choose what the model may change in a folder.', section: 'guide', slugs: ['everyday-use', 'daily-use'] },
            { title: 'Reach the studio from your phone', text: "Open your studio in the phone's browser over your own Tailscale network.", section: 'guide', slugs: ['everyday-use', 'reach'] },
            { title: 'What Delorun protects', text: 'The sandbox, full access and the consents, and what Delorun does not protect against.', section: 'guide', slugs: ['safety-and-updates', 'safety'] },
            { title: 'Questions and answers', text: 'Is it safe, what is the catch, and why it is built on DeepSeek Harness.', section: 'guide', slugs: ['help', 'questions'] },
            { title: 'Troubleshooting', text: 'Read a refusal and find the fix by its code.', section: 'guide', slugs: ['help', 'troubleshooting'] },
          ],
        },
        {
          title: 'Customise and build',
          links: [
            { title: 'Where to customise what', text: 'Settings, agent presets, your own plugin or Delorun itself, and what each costs you at an update.', section: 'guide', slugs: ['customising', 'customise'] },
            { title: 'Your first plugin', text: 'Build a plugin, see it in the studio, then remove it again.', section: 'guide', slugs: ['plugin-guides', 'first-plugin'] },
            { title: 'Write a plugin for Delorun', text: 'From `delorun plugin new` to a plugin that loads in your studio.', section: 'guide', slugs: ['plugin-guides', 'plugins'] },
            { title: 'Changing your harness', text: 'See, protect and undo each change to Delorun.', section: 'guide', slugs: ['customising', 'changing-your-harness'] },
            { title: 'Reference', text: "The glossary, and the notes for people who maintain Delorun's fork of DeepSeek Harness.", section: 'reference', slugs: [] },
          ],
        },
      ],
      more: { title: 'Find anything else', everyTask: 'Every task, by what you want to do', glossary: 'Glossary' },
    },
    changelog: {
      title: 'Changelog',
      intro: 'What changed in each Delorun version, newest first, and how Delorun differs from DeepSeek Harness. The entries are in English.',
      whatsNew: "What's new",
      latest: (version, date) => `Delorun ${version}, ${date}`,
      full: 'Full changelog',
      fromUpstream: 'From upstream',
    },
    nav: { guide: 'Guide', reference: 'Reference', changelog: 'Changelog', roadmap: 'Roadmap' },
    sectionNames: { guide: 'User guide', reference: 'Reference' },
    productLabel: 'Delorun',
    notFoundTitle: 'Page not found',
    notFoundText: 'No page has this address. Try the user guide, or start from the home page.',
  },
  zh: {
    siteTitle: 'Delorun 文档',
    homeIntro: 'Delorun 的文档。Delorun 是一个运行在你自己电脑上的程序，让 AI 模型处理你的文件、运行命令，并在有风险的步骤之前先征求你的同意。用户指南用平实的语言帮助你安装它、日常使用它、用手机访问它、让它成为你的，并解决出现的问题。术语表解释指南用到的每个术语，参考资料收录面向 Delorun 维护者的说明。',
    homeDescription: '安装 Delorun，日常使用，用手机访问，让它成为你的，并解决出现的问题。一份平实的指南、一份术语表和参考资料。',
    guideLabel: '用户指南',
    referenceLabel: '参考资料',
    switchTo: 'English',
    switchLabel: '阅读英文版本',
    describes: version => `本页描述 Delorun ${version}。`,
    home: {
      lead: 'Delorun 是一个运行在你自己电脑上的程序，让 AI 模型处理你的文件、运行命令。你在浏览器里打开的 studio 中与它对话，手机上也可以；在有风险的步骤之前，例如给某个文件夹完全访问权限，它会先征求你的同意。它是开源的，构建在 DeepSeek Harness 之上。',
      glossary: { before: '这些页面用到的每个术语都在', link: '术语表', after: '中。' },
      install: '安装 Delorun',
      why: '为什么选择 Delorun',
      command: '只需一条命令：',
      platforms: 'Linux（x64），以及通过 WSL2 运行的 Windows。',
      groups: [
        {
          title: '使用 Delorun',
          links: [
            { title: '安装与首次运行', text: '一条命令、几个问题，然后是你的第一次对话。', section: 'guide', slugs: ['get-started', 'install'] },
            { title: '日常使用', text: '启动、打开和停止 Delorun，并决定模型在某个文件夹里可以改动什么。', section: 'guide', slugs: ['everyday-use', 'daily-use'] },
            { title: '用手机访问 studio', text: '通过你自己的 Tailscale 网络，在手机浏览器中打开你的 studio。', section: 'guide', slugs: ['everyday-use', 'reach'] },
            { title: 'Delorun 保护什么', text: '沙箱、完全访问与各项同意，以及 Delorun 不防护的情况。', section: 'guide', slugs: ['safety-and-updates', 'safety'] },
            { title: '问题与解答', text: '它安全吗、有什么代价，以及为什么构建在 DeepSeek Harness 之上。', section: 'guide', slugs: ['help', 'questions'] },
            { title: '故障排查', text: '读懂一次拒绝，并按代码找到修复办法。', section: 'guide', slugs: ['help', 'troubleshooting'] },
          ],
        },
        {
          title: '定制与构建',
          links: [
            { title: '什么该在哪里定制', text: '设置、agent 预设、你自己的插件或 Delorun 本身，以及每种方式在更新时的代价。', section: 'guide', slugs: ['customising', 'customise'] },
            { title: '你的第一个插件', text: '构建一个插件，在 studio 中看到它，然后再移除它。', section: 'guide', slugs: ['plugin-guides', 'first-plugin'] },
            { title: '为 Delorun 编写插件', text: '从 `delorun plugin new` 到一个能在你的 studio 中加载的插件。', section: 'guide', slugs: ['plugin-guides', 'plugins'] },
            { title: '修改你的 harness', text: '查看、保护并撤销对 Delorun 的每一处改动。', section: 'guide', slugs: ['customising', 'changing-your-harness'] },
            { title: '参考资料', text: '术语表，以及面向 Delorun 的 DeepSeek Harness 分支维护者的说明。', section: 'reference', slugs: [] },
          ],
        },
      ],
      more: { title: '查找其他内容', everyTask: '按你想做的事列出的所有任务', glossary: '术语表' },
    },
    changelog: {
      title: '更新日志',
      intro: '每个 Delorun 版本的变化（最新版本在前），以及 Delorun 与 DeepSeek Harness 的差异。条目为英文。',
      whatsNew: '新内容',
      latest: (version, date) => `Delorun ${version}，${date}`,
      full: '完整更新日志',
      fromUpstream: '来自上游',
    },
    nav: { guide: '指南', reference: '参考资料', changelog: '更新日志', roadmap: '路线图' },
    sectionNames: { guide: '用户指南', reference: '参考资料' },
    productLabel: 'Delorun',
    notFoundTitle: '页面不存在',
    notFoundText: '没有页面使用此地址。可以试试用户指南，或从首页开始。',
  },
}
