/**
 * The words around the plugin browser's data, which the page supplies per language. Plugin titles and sentences are
 * the package's English `locale/en.json` and are not part of this dictionary.
 *
 * @module @delorun/website/plugin-browser/words
 */
import type { Standing } from './list-plugins.ts'
import type { PluginKind } from '../../../../packages/plugin-scaffold/src/scaffold.ts'

/** What a file of a new plugin is for, keyed by the file's name without its folder. */
export type FileNote = 'package.json' | 'cordis.patch.yml' | 'en.json' | 'index.ts' | 'index.tsx' | 'tsdown.config.ts' | 'tsconfig.json' | '.gitignore' | 'README.md'

/** The words of the plugin browser. */
export interface PluginBrowserWords {
  /** The name of the two tabs' row, read before the tabs. */
  readonly tabsLabel: string
  readonly pluginsTab: string
  readonly makeYourOwnTab: string
  /** The name of the plugin list. */
  readonly listLabel: string
  /** Each group's heading, by where its plugins stand. */
  readonly groups: Readonly<Record<Standing, string>>
  /** The sentence beside each plugin's standing in its detail. */
  readonly standings: Readonly<Record<Standing, string>>
  readonly experimental: string
  /** The heading above what a pack needs. */
  readonly requiresHeading: string
  readonly requiresNothing: string
  /** The disclosure for plugin authors. */
  readonly filesSummary: string
  readonly filesCount: (count: number) => string
  readonly folderLink: string
  /** The paragraph above the four kinds. */
  readonly makeIntro: string
  readonly guideLink: string
  readonly kinds: Readonly<Record<PluginKind, { readonly name: string; readonly summary: string }>>
  /** The name of the list of files one kind writes. */
  readonly filesWritten: (kindName: string) => string
  readonly fileNotes: Readonly<Record<FileNote, string>>
  /** The note after the list, which says the names in it are examples. */
  readonly makeNote: string
}

/** The English words, which the page's English dictionary adopts and a test holds to the same keys as every language. */
export const ENGLISH_WORDS: PluginBrowserWords = {
  tabsLabel: 'Plugins',
  pluginsTab: 'What is in Delorun',
  makeYourOwnTab: 'Make your own',
  listLabel: 'Plugins',
  groups: {
    on: 'On from the start',
    off: 'Installed, off until you turn them on',
    headless: 'On in headless runs',
    pack: 'Downloaded when you turn them on',
  },
  standings: {
    on: 'On from the start.',
    off: 'Installed and off until you turn it on.',
    headless: 'On when Delorun runs without a screen.',
    pack: 'Downloaded when you first turn it on, which needs a connection once.',
  },
  experimental: 'Experimental',
  requiresHeading: 'What it needs from you',
  requiresNothing: 'Nothing to set up first.',
  filesSummary: 'Files, for plugin authors',
  filesCount: (count) => `${String(count)} ${count === 1 ? 'file' : 'files'} in the repository.`,
  folderLink: 'Open the folder',
  makeIntro: 'delorun plugin new writes a folder to start from. Pick what the plugin does and see the files it gets.',
  guideLink: 'Read Your first plugin',
  kinds: {
    tool: { name: 'Tool', summary: 'Gives the agent a new action to call.' },
    preset: { name: 'Preset', summary: 'Sets how an agent works: its instructions and permissions.' },
    ui: { name: 'Screen', summary: 'Adds a panel or control to the studio.' },
    bundle: { name: 'Bundle', summary: 'Turns on a set of existing plugins together.' },
  },
  filesWritten: (kindName) => `Files a ${kindName.toLowerCase()} starts with`,
  fileNotes: {
    'package.json': 'Names the plugin and what it needs.',
    'cordis.patch.yml': 'The entry that loads it.',
    'en.json': 'The title and sentence people read.',
    'index.ts': 'Where the code starts.',
    'index.tsx': 'The screen it draws.',
    'tsdown.config.ts': 'How it is built.',
    'tsconfig.json': 'How it is type checked.',
    '.gitignore': 'Keeps build output out of git.',
    'README.md': 'How to use and change it.',
  },
  makeNote: 'The name and versions in the files are filled in for your plugin.',
}
