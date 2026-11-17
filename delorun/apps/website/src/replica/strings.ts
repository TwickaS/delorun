/**
 * The product text the drawn studio's own parts read: the composer, the tool card, the sidebar and the Settings frame.
 * The build picks these keys from the product's English dictionaries, with Delorun's vocabulary laid over upstream's
 * (`build/plugins.ts`, `virtual:replica-strings`), so no text is retyped and only the keys listed here ship. The real
 * studio sections take their whole dictionaries instead (`screens/real.tsx`).
 * @module @delorun/website/replica/strings
 */

/** Where each dictionary lives, as an alias the site resolves, and the vocabulary namespace laid over it. */
export const STRING_SOURCES = {
  conversation: { module: '#studio/ui-conversation/src/client/locales.ts', vocabulary: 'conversation' },
  chat: { module: '#studio/ui-chat/src/client/locale.ts', vocabulary: 'chat' },
  sidebar: { module: '#studio/ui-sidebar/src/client/locales.ts', vocabulary: 'sidebar' },
  settings: { module: '#studio/ui-settings-general/src/client/locales.ts', vocabulary: undefined },
  layout: { module: '../../../../packages/plugin-settings-layout/src/client/locales.ts', vocabulary: undefined },
} as const

/** The keys the drawn studio reads, by dictionary. */
export const STRING_KEYS = {
  conversation: ['placeholder.default', 'input.send'],
  chat: ['command.title', 'command.running', 'command.done', 'command.failed', 'message.stepProcess.done.commands'],
  sidebar: ['session.new.label', 'navigation.label'],
  settings: ['title'],
  layout: ['page.changes', 'page.setupVersions'],
} as const satisfies { readonly [D in keyof typeof STRING_SOURCES]: readonly string[] }

/** One dictionary's name. */
export type StringSource = keyof typeof STRING_KEYS

/** The text the drawn studio reads. */
export type ReplicaStrings = { readonly [D in StringSource]: Readonly<Record<typeof STRING_KEYS[D][number], string>> }

/** A dictionary as a module exports it: `en`, and other languages the pick leaves out. */
export interface DictionaryModule {
  readonly en: Readonly<Record<string, string>>
}

/** Delorun's vocabulary: English and Chinese text by namespace, laid over upstream's dictionaries. */
export type Vocabulary = Readonly<Record<string, { readonly en: Readonly<Record<string, string>> }>>

/**
 * Pick the drawn studio's text from the product's dictionaries.
 * @param modules - each dictionary's module, by name.
 * @param vocabulary - Delorun's vocabulary.
 * @returns the text, with Delorun's words where it has its own.
 * @throws Error naming a key the product's dictionary no longer has, so a renamed key fails the build.
 */
export function pickStrings(modules: { readonly [D in StringSource]: DictionaryModule }, vocabulary: Vocabulary): ReplicaStrings {
  const pick = <D extends StringSource>(name: D): ReplicaStrings[D] => {
    const namespace = STRING_SOURCES[name].vocabulary
    const dictionary = { ...modules[name].en, ...namespace === undefined ? {} : vocabulary[namespace]?.en }
    return Object.fromEntries(STRING_KEYS[name].map((key) => {
      const text = dictionary[key]
      if (text === undefined) throw new Error(`replica strings: the ${name} dictionary has no key '${key}'`)
      return [key, text]
    })) as ReplicaStrings[D]
  }
  return { conversation: pick('conversation'), chat: pick('chat'), sidebar: pick('sidebar'), settings: pick('settings'), layout: pick('layout') }
}

/**
 * A translate function over one dictionary, filling `{name}` placeholders as the studio's locale plugin does.
 * @param dictionary - the dictionary.
 * @returns a function that gives the text for a key with its values filled in.
 */
export function translator<K extends string>(dictionary: Readonly<Record<K, string>>): (key: K, params?: Readonly<Record<string, unknown>>) => string {
  return (key, params) => {
    const text = dictionary[key]
    return params === undefined ? text : text.replace(/\{(\w+)\}/g, (whole, name: string) => name in params ? String(params[name]) : whole)
  }
}
