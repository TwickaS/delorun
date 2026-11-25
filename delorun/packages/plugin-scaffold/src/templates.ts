/**
 * The text of each kind's generated files: sources, build and TypeScript configuration, the bundle patch, and the
 * README. The `ui` kind's `tsdown.config.ts` builds the studio half without upstream's client build preset, which is
 * not published: it writes `lib/client.js` in the format the studio's client module loader runs, one script that passes
 * a factory to `window.__ModuleLoader__.load({ id, factory })`, requires the modules the page provides through the
 * factory's `require`, and carries everything else in the file. It handles no stylesheets, assets or code splitting.
 *
 * @module @delorun/plugin-scaffold/templates
 */
import type { ScaffoldFile, ScaffoldNames, PluginKind, TOOLCHAIN } from './scaffold.ts'

/** A kind's build: whether it has a studio half, and the toolchain packages it declares. */
export interface KindBuild {
  /** Whether the build writes `lib/client.js`, the studio half. */
  readonly client: boolean
  /** The toolchain packages the package declares as development dependencies. */
  readonly toolchain: readonly (keyof typeof TOOLCHAIN)[]
}

/** What a kind adds to the files every scaffold has. */
export interface KindTemplate {
  /** The package's description, which the plugin list shows. */
  readonly description: string
  /** The bundle patch, `cordis.patch.yml`. */
  readonly patch: string
  /** The kind's own files: sources and build configuration. */
  readonly files: readonly ScaffoldFile[]
  /** DSH packages the plugin shares with the host at run time: peer and development dependencies. */
  readonly sharedDsh: readonly string[]
  /** DSH packages the plugin reads only types from: development dependencies. */
  readonly typesDsh: readonly string[]
  /** The build, for a kind with code. */
  readonly build?: KindBuild
  /** The `dsh.client` declaration of a kind with a studio half. */
  readonly client?: { readonly platform: 'web', readonly inject: readonly string[] }
  /** The README's paragraph about what the plugin does. */
  readonly about: string
  /** The README's list of the files to edit, each a path and what it holds. */
  readonly guide: readonly (readonly [string, string])[]
}

/** The modules the studio page provides to every plugin's studio half, upstream's `PLATFORM_MODULES`. */
export const PAGE_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

/** The `.gitignore` of a package with a build: installed packages and the build's output. */
const BUILD_GITIGNORE: ScaffoldFile = { path: '.gitignore', text: 'node_modules/\nlib/\n' }

/** The `.gitignore` of a package without code. */
const PLAIN_GITIGNORE: ScaffoldFile = { path: '.gitignore', text: 'node_modules/\n' }

/**
 * The TypeScript configuration `pnpm run typecheck` reads; tsdown builds without it checking types.
 * @param browser - whether the sources include a studio half, which needs the DOM's types and JSX.
 * @returns the `tsconfig.json` file.
 */
function tsconfig(browser: boolean): ScaffoldFile {
  const compilerOptions = {
    target: 'ES2024',
    lib: browser ? ['ES2024', 'DOM'] : ['ES2024'],
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    ...browser ? { jsx: 'react-jsx' } : {},
    strict: true,
    noEmit: true,
    isolatedModules: true,
    verbatimModuleSyntax: true,
    skipLibCheck: true,
    types: [],
  }
  return { path: 'tsconfig.json', text: `${JSON.stringify({ compilerOptions, include: ['src'] }, null, 2)}\n` }
}

/** The host build's tsdown options, shared by the `tool` and `ui` configurations. */
const HOST_BUILD = `{
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}`

/** The `tool` kind's `tsdown.config.ts`. */
const TOOL_TSDOWN = `import { defineConfig } from 'tsdown'

// lib/index.js, the module a profile row loads, from src/index.ts. Packages under dependencies and peerDependencies
// stay imports: the profile supplies the peers, so the plugin shares their instances with DSH.
export default defineConfig(${HOST_BUILD})
`

/** The `ui` kind's `tsdown.config.ts`: the host half, and the studio half in the client module loader's format. */
const UI_TSDOWN = `import { readFileSync } from 'node:fs'
import { defineConfig, type UserConfig } from 'tsdown'

/** This package's manifest: its name is the id the studio page loads lib/client.js under. */
const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  readonly name: string
  readonly dsh: { readonly client: { readonly external?: readonly string[] } }
}

/**
 * The modules the studio page provides to every plugin, and the ones dsh.client.external requests. lib/client.js
 * requires them from the page, so it shares React, Cordis and the slot registry with the page; it carries a copy of
 * every other import.
 */
const PAGE_MODULES = new Set([
${PAGE_MODULES.map(name => `  '${name}',`).join('\n')}
  ...manifest.dsh.client.external ?? [],
])

/**
 * Whether the page answers an import.
 * @param id - the import.
 * @returns true for a module the page provides.
 */
const fromPage = (id: string): boolean => PAGE_MODULES.has(id)

// lib/index.js, the module a profile row loads; the studio serves lib/client.js only while that row is loaded.
const host: UserConfig = ${HOST_BUILD}

// lib/client.js, the studio half: one script that passes a factory to window.__ModuleLoader__.load. The page calls the
// factory with its own require, which answers PAGE_MODULES, and reads the plugin from the module.exports it returns.
// Limits: no CSS or asset imports, and dynamic import() is inlined rather than split into files.
const client: UserConfig = {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  deps: { neverBundle: fromPage, alwaysBundle: id => !fromPage(id) },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [{
    name: 'page-modules-only',
    resolveId(source: string) {
      if (source.startsWith('@deepseek-ai/') && !fromPage(source)) {
        throw new Error(\`\${source} is not a module the studio page provides: a copy in lib/client.js would not share the page's state. Import its types with "import type", reach its features through the services on ctx, or request it under dsh.client.external when the page provides it.\`)
      }
      return null
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    inlineDynamicImports: true,
    banner: \`window.__ModuleLoader__.load({ id: \${JSON.stringify(manifest.name)}, factory: (require) => {\`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}

export default defineConfig([host, client])
`

/**
 * The `tool` kind: a host plugin that registers one tool for the agent.
 * @param names - the derived names.
 * @returns the template.
 */
export function toolTemplate(names: ScaffoldNames): KindTemplate {
  const source = `/**
 * ${names.name}: gives the agent the \`${names.toolName}\` tool, which greets someone by name.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** The plugin's name. */
export const name = '${names.name}'

/** The services DSH provides before \`apply\` runs: the tool registry. */
export const inject = ['tools']

/**
 * Register the tool. DSH removes what a plugin registered through \`ctx\` when it unloads the plugin.
 * @param ctx - the plugin's context.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: '${names.toolName}',
    description: 'Greet someone by name.',
    parameters: {
      name: { type: 'string', required: true, description: 'The name to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(args) {
      return Promise.resolve(\`Hello, \${args.name}!\`)
    },
  }))
}
`
  return {
    description: `Gives the agent the ${names.toolName} tool, which greets someone by name.`,
    patch: `# The row a profile adds when it lists this package as a bundle. A profile's own cordis.patch.yml can change the
# row by its id.
- insert:
    - id: '${names.rowId}'
      name: '${names.name}'
`,
    files: [
      { path: 'src/index.ts', text: source },
      { path: 'tsdown.config.ts', text: TOOL_TSDOWN },
      tsconfig(false),
      BUILD_GITIGNORE,
    ],
    sharedDsh: ['@deepseek-ai/dsh-tools'],
    typesDsh: [],
    build: { client: false, toolchain: ['tsdown', 'typescript'] },
    about: `A plugin that gives the agent the \`${names.toolName}\` tool, which greets someone by name. The model sees the tool's name, description and parameters, and receives what \`execute\` returns.`,
    guide: [
      ['src/index.ts', 'the plugin: `inject` names the services it needs, and `apply` registers the tool'],
      ['tsdown.config.ts', 'the build, which writes `lib/index.js` from `src/index.ts`'],
    ],
  }
}

/**
 * The `preset` kind: a bundle that adds an agent preset composed of plugins DSH ships.
 * @param names - the derived names.
 * @returns the template.
 */
export function presetTemplate(names: ScaffoldNames): KindTemplate {
  return {
    description: `Adds the ${names.title} agent preset, which reads and searches the workspace without changing it.`,
    patch: `# Adds the "${names.title}" agent preset to the studio's preset list. A preset is the list of plugins a new chat's
# agent runs with; these come with DSH. config.id is the preset's identity, which chats record; the row's id lets a
# profile's own cordis.patch.yml override the preset, and an override replaces the whole config.
- insert:
    - id: 'preset-${names.rowId}'
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: '${names.rowId}'
        name: '${names.title}'
        description: Reads and searches the workspace without changing it.
        order: 50
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: >-
                You are a careful assistant. You read and search the files in the workspace to answer
                questions about them, and you never change them.
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
            config:
              write: false
              edit: false
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
`,
    files: [PLAIN_GITIGNORE],
    sharedDsh: [],
    typesDsh: [],
    about: `A bundle that adds the ${names.title} agent preset: a new chat can run with it from the studio's preset list. Its agent reads and searches the workspace and changes nothing. A preset needs a profile with the studio, whose preset registry lists it; the headless profile has none.`,
    guide: [
      ['cordis.patch.yml', 'the preset: its plugins, each with the configuration the plugin documents in its README'],
    ],
  }
}

/**
 * The `ui` kind: a plugin with a studio half that adds a page to Settings, and the host half that loads it.
 * @param names - the derived names.
 * @returns the template.
 */
export function uiTemplate(names: ScaffoldNames): KindTemplate {
  const host = `/**
 * ${names.name}'s host half. The studio serves this package's studio half, lib/client.js, only while a profile row
 * loads the package, so the row loads this plugin, which does nothing else.
 */

/** The plugin's name. */
export const name = '${names.name}'

/** Load the plugin; the studio half in src/client/index.tsx does the work. */
export function apply(): void {}
`
  const client = `/**
 * ${names.name}'s studio half: a "${names.title}" page in Settings.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.slots member of Context.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the 'settings.section' slot.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

/** The services the page provides before \`apply\` runs: the slot registry. */
export const inject = ['slots']

/** The page's id in Settings. */
const SECTION_ID = '${names.rowId}'

/**
 * The page Settings shows when its entry in the navigation is selected.
 * @returns the page.
 */
function Section() {
  return (
    <section>
      <h2>${names.title}</h2>
      <p>This page comes from the ${names.name} plugin.</p>
    </section>
  )
}

/**
 * Add the page to Settings. The page removes what a plugin registered through \`ctx\` when it unloads the plugin.
 * @param ctx - the plugin's context in the page.
 */
export function apply(ctx: Context): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: SECTION_ID, order: 100, label: '${names.title}',
  }, Section))
}
`
  return {
    description: `Adds a section titled "${names.title}" to the studio's Settings.`,
    patch: `# The row a profile adds when it lists this package as a bundle. The studio serves lib/client.js while this row is
# loaded. A profile's own cordis.patch.yml can change the row by its id.
- insert:
    - id: '${names.rowId}'
      name: '${names.name}'
`,
    files: [
      { path: 'src/index.ts', text: host },
      { path: 'src/client/index.tsx', text: client },
      { path: 'tsdown.config.ts', text: UI_TSDOWN },
      tsconfig(true),
      BUILD_GITIGNORE,
    ],
    sharedDsh: [],
    typesDsh: ['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-slots'],
    build: { client: true, toolchain: ['@types/react', 'react', 'tsdown', 'typescript'] },
    client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-settings'] },
    about: `A plugin that adds a section titled "${names.title}" to the studio's Settings. Its studio half, \`lib/client.js\`, runs in the browser; its host half, \`lib/index.js\`, is the row a profile loads, and the studio serves the studio half while that row is loaded.`,
    guide: [
      ['src/client/index.tsx', 'the studio half: the page, and `apply`, which registers it in the `settings.section` slot'],
      ['src/index.ts', 'the host half, which loads the package'],
      ['tsdown.config.ts', `the build. \`lib/client.js\` takes from the page the modules it provides to every plugin (${PAGE_MODULES.map(name => `\`${name}\``).join(', ')}), and the ones \`dsh.client.external\` in \`package.json\` requests; it carries a copy of every other import. It does not handle CSS or asset imports, and it does not split \`import()\` into separate files. A value import of another \`@deepseek-ai/\` package fails the build: use its services on \`ctx\`, and import its types with \`import type\``],
    ],
  }
}

/**
 * The `bundle` kind: a patch that changes rows other bundles add, with no code.
 * @param names - the derived names.
 * @returns the template.
 */
export function bundleTemplate(names: ScaffoldNames): KindTemplate {
  return {
    description: 'Turns on the read-before-edit guard for the agent\'s file tools.',
    patch: `# Turns on DSH's read-before-edit guard: the agent must read a file before it overwrites or edits it, and a write to a
# file that changed since that read is refused until the agent reads it again. DSH's base bundle adds the row
# fs-observation-policy turned off; this patch changes that row by its id, which works because a profile applies this
# bundle after the base bundle. A patch replaces a row's whole config, so an override restates every key the row needs.
- id: fs-observation-policy
  disabled: false
`,
    files: [PLAIN_GITIGNORE],
    sharedDsh: [],
    typesDsh: [],
    about: `A bundle that changes rows other bundles add, with no code of its own: it turns on DSH's read-before-edit guard for the agent's file tools. A profile applies its bundles in the order it lists them, then its own \`cordis.patch.yml\`, and a later layer wins for each row.`,
    guide: [
      ['cordis.patch.yml', `the patch. \`- id: <row>\` changes a row another bundle added; \`- insert:\` adds rows. ${names.name} must come after the bundle whose row it changes`],
    ],
  }
}

/**
 * The commands that follow `delorun plugin new`, in order.
 * @param kind - the kind.
 * @param folder - the new folder as the person wrote it, for `cd`.
 * @param absolute - the new folder's absolute path, for `delorun plugin add`.
 * @returns each command and what it does.
 */
export function nextCommands(kind: PluginKind, folder: string, absolute: string): (readonly [string, string])[] {
  const build = kind === 'tool' || kind === 'ui'
  return [
    [`cd ${folder}`, ''],
    ...build ? [['pnpm install', 'installs the build tools and the DSH packages the sources import'] as const, ['pnpm run build', 'writes lib/ from src/'] as const] : [],
    ['delorun plugin check .', 'says whether this Delorun release admits the plugin'],
    ['delorun plugin dev .', 'links the folder into your profile and reloads it when a file changes'],
    [`delorun plugin add ${absolute}`, 'installs the folder into your profile as a link'],
  ]
}

/**
 * The README of a scaffold.
 * @param names - the derived names.
 * @param kind - the kind.
 * @param template - the kind's template.
 * @returns the README's text.
 */
export function readme(names: ScaffoldNames, kind: PluginKind, template: KindTemplate): string {
  const build = template.build !== undefined
  const commands = nextCommands(kind, '.', '/absolute/path/to/this/folder').slice(1)
  const files = [
    ...template.guide,
    ['cordis.patch.yml', 'the rows a profile adds when it lists this package as a bundle'],
    ['locale/en.json', 'the title and description the plugin list shows'],
    ['package.json', '`engines.delorun`, the Delorun versions the plugin was made for, which alone decide on Delorun, and `engines.dsh`, the DSH versions, which stock DeepSeek Harness checks; `delorun plugin check` reads both'],
  ].filter(([path], index, all) => all.findIndex(([other]) => other === path) === index)
  return `# ${names.name}

${template.about}

## Develop

\`\`\`sh
${commands.map(([command]) => command).join('\n')}
\`\`\`

${commands.map(([command, what]) => `- \`${command}\` ${what}.`).join('\n')}
${build ? '\n`pnpm run typecheck` checks the types; the build does not.\n' : ''}
## Files

${files.map(([path, what]) => `- \`${path}\`: ${what}.`).join('\n')}

## Install from git or npm

${build
    ? `A git install receives the sources without \`lib/\`, and pnpm builds it with the \`prepare\` script. pnpm runs that script only for a package you allow, so install it with \`delorun plugin add github:<owner>/<repository>#<commit> --allow-build ${names.name}\`. The build runs on your machine with your access: allow only code you trust, and pin a commit so a later push cannot change what runs. A package published to npm with \`lib/\` built, or packed with \`pnpm pack\`, installs without that allowance.`
    : `\`delorun plugin add github:<owner>/<repository>#<commit>\` installs it from a git repository, and \`delorun plugin add ${names.name}\` from npm once it is published. It has no build, so it needs no allowance.`}

Run \`delorun plugin check .\` after changing \`engines\` or moving to another Delorun release.
`
}
