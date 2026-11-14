/**
 * Generate Delorun's studio vocabulary: the override texts that make
 * upstream's copy say "chat" where it says "session", as the Delorun glossary
 * names it, in English and Chinese. It reads upstream's dictionaries from
 * source and writes `src/client/vocabulary.ts`, which the theme registers
 * through `ctx.locale.override` while the studio additions are on; run it
 * again after an upstream merge and review the diff.
 *
 *   node_modules/.bin/tsx delorun/packages/plugin-theme/scripts/gen-vocabulary.ts [--check]
 *
 * `--check` fails when the committed file differs from what it would write.
 * @module @delorun/plugin-theme/scripts/gen-vocabulary
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

/** The upstream dictionaries the vocabulary covers: each namespace and the module that exports its `en` and `zh`. */
export const SOURCES: readonly { readonly ns: string; readonly module: string }[] = [
  { ns: 'conversation', module: 'packages/client/ui-conversation/src/client/locales.ts' },
  { ns: 'workspace', module: 'packages/client/ui-workspace/src/client/locales.ts' },
  { ns: 'sidebar', module: 'packages/client/ui-sidebar/src/client/locales.ts' },
  { ns: 'sidebarRight', module: 'packages/client/ui-sidebar-right/src/client/locales.ts' },
  { ns: 'sidebarFiles', module: 'packages/client/ui-sidebar-files/src/client/locales.ts' },
  { ns: 'sidebarBrowser', module: 'packages/client/ui-sidebar-browser/src/client/locales.ts' },
  { ns: 'sidebarTerminal', module: 'packages/client/ui-sidebar-terminal/src/client/locales.ts' },
  { ns: 'trajectory', module: 'packages/client/ui-trajectory/src/client/locales.ts' },
  { ns: 'chat', module: 'packages/client/ui-chat/src/client/locale.ts' },
  { ns: 'subagent', module: 'packages/client/ui-subagent/src/client/locales.ts' },
  { ns: 'pluginManager', module: 'packages/client/ui-plugin-manager/src/client/locales.ts' },
]

/** Where the vocabulary is written, from the repository's root. */
export const OUT = 'delorun/packages/plugin-theme/src/client/vocabulary.ts'

/** A text's code spans and placeholders, which keep their words: `code`, {name} and slash commands. */
const PROTECTED = /`[^`]*`|\{[^}]*\}|\/[a-z][\w-]*/g

/**
 * Say "chat" where an English text says "session": sentence case, so a word
 * that does not start the text or a sentence is lower case.
 * @param text - upstream's English text.
 * @returns the text in Delorun's words, or undefined when it does not change.
 */
export function chatEnglish(text: string): string | undefined {
  let changed = false
  const swap = (part: string, prefix: string): string => part.replace(/\b(S|s)ession(s?)\b/g, (_match, _initial: string, plural: string, offset: number) => {
    changed = true
    const before = prefix + part.slice(0, offset)
    const starts = before.trim() === '' || /[.!?:]\s*$/.test(before)
    return `${starts ? 'C' : 'c'}hat${plural}`
  })
  let result = ''
  let last = 0
  for (const match of text.matchAll(PROTECTED)) {
    result += swap(text.slice(last, match.index), result) + match[0]
    last = match.index + match[0].length
  }
  result += swap(text.slice(last), result)
  return changed ? result : undefined
}

/**
 * Say 对话 where a Chinese text says 会话.
 * @param text - upstream's Chinese text.
 * @returns the text in Delorun's words, or undefined when it does not change.
 */
export function chatChinese(text: string): string | undefined {
  return text.includes('会话') ? text.replaceAll('会话', '对话') : undefined
}

/** The overrides of one namespace in both locales. */
export interface NamespaceVocabulary {
  readonly en: Readonly<Record<string, string>>
  readonly zh: Readonly<Record<string, string>>
}

/**
 * Build the vocabulary from the dictionaries.
 * @param dictionaries - each namespace's English and Chinese dictionaries.
 * @returns the overrides of each namespace that has any, in key order.
 */
export function vocabularyOf(dictionaries: ReadonlyMap<string, { readonly en: Record<string, string>; readonly zh: Record<string, string> }>): Record<string, NamespaceVocabulary> {
  const result: Record<string, NamespaceVocabulary> = {}
  for (const [ns, { en, zh }] of dictionaries) {
    const enOut: Record<string, string> = {}
    const zhOut: Record<string, string> = {}
    for (const key of Object.keys(en).sort()) {
      const english = chatEnglish(en[key] ?? '')
      if (english !== undefined) enOut[key] = english
      const chinese = chatChinese(zh[key] ?? '')
      if (chinese !== undefined) zhOut[key] = chinese
    }
    if (Object.keys(enOut).length > 0 || Object.keys(zhOut).length > 0) result[ns] = { en: enOut, zh: zhOut }
  }
  return result
}

/**
 * Render the vocabulary module.
 * @param vocabulary - the overrides by namespace.
 * @returns the module's source.
 */
export function render(vocabulary: Record<string, NamespaceVocabulary>): string {
  const lines = [
    '/**',
    ' * Delorun\'s studio vocabulary: upstream\'s texts that say "session", as',
    ' * "chat", the Delorun glossary\'s word, in English and Chinese. Generated by',
    ' * `scripts/gen-vocabulary.ts` from upstream\'s dictionaries;',
    ' * do not edit by hand.',
    ' * @module @delorun/plugin-theme/client/vocabulary',
    ' */',
    '',
    '/** Override texts by namespace, then locale, then key. */',
    'export const VOCABULARY: Readonly<Record<string, { readonly en: Readonly<Record<string, string>>; readonly zh: Readonly<Record<string, string>> }>> = ',
  ]
  return `${lines.join('\n')}${JSON.stringify(vocabulary, null, 2).replaceAll(/"([A-Za-z_$][\w$]*)":/g, '$1:')}\n`
}

/** The repository's root. */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/**
 * Read upstream's dictionaries from source and render the vocabulary module.
 * @returns the module's source, as `OUT` should hold it.
 */
export async function generate(): Promise<string> {
  const dictionaries = new Map<string, { en: Record<string, string>; zh: Record<string, string> }>()
  for (const { ns, module } of SOURCES) {
    const loaded = await import(join(ROOT, module)) as { en: Record<string, string>; zh: Record<string, string> }
    dictionaries.set(ns, { en: loaded.en, zh: loaded.zh })
  }
  return render(vocabularyOf(dictionaries))
}

/** Write or check the vocabulary. */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } } })
  const root = ROOT
  const text = await generate()
  const out = join(root, OUT)
  if (values.check) {
    const current = await readFile(out, 'utf8').catch(() => '')
    if (current !== text) {
      console.error(`${OUT} is stale: run scripts/gen-vocabulary.ts`)
      process.exitCode = 1
    }
    return
  }
  await writeFile(out, text)
  console.log(`wrote ${OUT}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
