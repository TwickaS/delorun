/**
 * Upstream's repository gates that Delorun's runner runs: every static check that upstream's `scripts/run-gates.ts` lists in
 * its `doc-sync`, `hygiene`, `check-all` and CI static modes, other than the ones another Delorun check already runs. Each
 * gate runs upstream's own package script or spec files, so the rule and its fix stay upstream's. `gates:docs` runs the
 * bilingual-pair (report-only), word-budget, hard-wrap, relative-link and TypeScript-fence checks, `typecheck:upstream`
 * the typecheck, and `tests:snapshots` the recorded-session replay, so those are not repeated here.
 *
 * A gate's tier follows its cost on the reference host: a gate that takes up to about ten seconds runs in every tier, one
 * that takes up to about a minute is left out of the lane tier, and one that takes longer, builds a site or reads
 * upstream's built output runs in the merge tier only. `budgets.json` records the memory of each gate that needs more
 * than the gates' default. A gate that fails on the integration branch keeps its tier and is listed in `debt.json`.
 *
 * @module @delorun/tools/checks/gates/upstream
 */
import type { GateCheck } from '../types.ts'

const VITEST = 'node_modules/.bin/vitest'

/** The spec files one gate runs with `vitest run`, and the per-test timeout they need. */
interface SpecsRun {
  /** The spec files `vitest run` runs. */
  readonly specs: readonly string[]
  /**
   * The per-test timeout vitest applies to these specs, in milliseconds (`--testTimeout`); absent, vitest's 5 s default
   * applies. The locale-dictionaries specs walk every source file and take about 16 s on the reference host under
   * concurrent load, against that default, so they set 60 s.
   */
  readonly testTimeoutMs?: number
}

/** One upstream gate: its id after `gates:`, the title, and the upstream package script or spec files it runs. */
interface UpstreamGate {
  /** Upstream's gate id in `scripts/run-gates.ts`; the runner names it `gates:<id>`. */
  readonly id: string
  readonly title: string
  /** The root package script that `pnpm run` starts, or the spec files `vitest run` runs. */
  readonly run: { readonly script: string } | SpecsRun
  readonly tier?: GateCheck['tier']
  readonly builtArtifacts?: true
}

/**
 * The argv of a spec gate: `vitest run`, the per-test timeout when the gate sets one, then its spec files.
 * @param run - the gate's spec files and timeout.
 * @returns the argv the runner executes from the repository root.
 */
function specsCommand(run: SpecsRun): string[] {
  const timeout = run.testTimeoutMs === undefined ? [] : [`--testTimeout=${String(run.testTimeoutMs)}`]
  return [VITEST, 'run', ...timeout, ...run.specs]
}

/** The upstream gates, in the order of upstream's `doc-sync`, `hygiene` and CI static lists. */
const UPSTREAM: readonly UpstreamGate[] = [
  { id: 'doc-graphs', title: 'Upstream\'s generated dependency and capability-seam graphs are current', run: { script: 'verify-doc-graphs' }, tier: 'agent' },
  { id: 'cli-help', title: 'The paired CLI help references match the shipped launcher\'s help', run: { script: 'verify-cli-help' } },
  { id: 'type-equivalence', title: 'Upstream\'s `type-equiv` documentation blocks match their source declarations', run: { script: 'verify-type-equiv' } },
  { id: 'cordis-catalog', title: 'Upstream\'s generated Cordis service and event reference is current', run: { script: 'verify-cordis-catalog' }, tier: 'agent' },
  { id: 'cordis-inspect-catalog', title: 'Upstream\'s generated Cordis inspect catalog is current', run: { script: 'verify-cordis-inspect-catalog' }, tier: 'agent' },
  { id: 'workflow-guest', title: 'The bundled workflow guest source module is current', run: { script: 'verify-workflow-guest' } },
  { id: 'mermaid', title: 'Every repository Mermaid fence parses with Mermaid', run: { script: 'verify-mermaid' }, tier: 'agent' },
  { id: 'client-catalog', title: 'Upstream\'s generated client slot catalog is current', run: { script: 'verify-client-catalog' } },
  { id: 'export-jsdoc', title: 'Every export of upstream\'s package APIs has complete JSDoc', run: { script: 'verify-export-jsdoc' }, tier: 'agent' },
  { id: 'tool-catalog', title: 'The tool catalog, generated from each tool plugin\'s registered schemas, is current', run: { script: 'verify-tool-catalog' } },
  { id: 'config-catalog', title: 'Upstream\'s generated configuration catalog is current', run: { script: 'verify-config-catalog' } },
  { id: 'plugin-packages', title: 'The loadable-plugin package list in the composition skill is current', run: { script: 'verify-plugin-packages' } },
  { id: 'dependency-catalog', title: 'The README npx dependency catalog is current', run: { script: 'verify-dependency-catalog' } },
  { id: 'persistence-catalog', title: 'Upstream\'s generated persistence catalog and schema are current', run: { script: 'verify-persistence-catalog' }, tier: 'agent' },
  { id: 'persistence-changes', title: 'Persistence type changes are acknowledged in the schema history', run: { script: 'verify-persistence-changes' }, tier: 'agent' },
  { id: 'persistence-releases', title: 'The pinned prerelease persistence archive verifies', run: { script: 'verify-persistence-releases' } },
  { id: 'persistence-formats', title: 'The archived Session format references verify through the current writer', run: { script: 'verify-persistence-formats' } },
  { id: 'session-format-catalog', title: 'The Session format catalog is current', run: { script: 'verify-session-format-catalog' } },
  { id: 'public-repository-links', title: 'No tracked file references an unavailable legacy repository', run: { script: 'verify-public-repository-links' } },
  { id: 'repository-references', title: 'No maintained reference to a repository commit or the disallowed organization URL', run: { script: 'verify-repository-references' }, tier: 'agent' },
  { id: 'concrete-terms', title: 'No tracked file carries the banned ambiguous origin label', run: { script: 'verify-concrete-terms' } },
  { id: 'release-tense', title: 'No release-status phrase in the English Markdown under `delorun/`', run: { script: 'verify-release-tense' } },
  { id: 'british-english', title: 'No curated US spelling in the English Markdown and source strings under `delorun/`', run: { script: 'verify-british-english' } },
  { id: 'doc-refs', title: 'Documentation paths named in TypeScript, Delorun\'s included, exist', run: { script: 'verify-doc-refs' } },
  { id: 'subsystem-pages', title: 'Every package group README links a subsystem page or names its exemption', run: { script: 'verify-subsystem-pages' } },
  { id: 'package-paths', title: 'Root-relative `packages/...` paths in prose and TypeScript name packages that exist', run: { script: 'verify-package-paths' } },
  { id: 'tsconfig-paths', title: 'The expanded workspace path aliases in `tsconfig.base.json` are current', run: { script: 'verify-tsconfig-paths' } },
  { id: 'config-source-ownership', title: 'Shipped Cordis configuration inlines no credential or endpoint environment variable', run: { script: 'verify-config-source-ownership' } },
  { id: 'package-readme-summaries', title: 'Every package README opens with its Summary', run: { script: 'verify-package-readme-summaries' } },
  { id: 'package-readme-model-experience', title: 'Package README Model Experience sections are complete and classified', run: { script: 'verify-package-readme-model-experience' } },
  { id: 'agent-note-classification', title: 'Agent Notes sit in their lifecycle and class paths with dated filenames', run: { script: 'verify-agent-note-classification' } },
  { id: 'agent-note-format', title: 'Agent Notes follow the note format', run: { script: 'verify-agent-note-format' } },
  { id: 'archived-agent-notes', title: 'The frozen Agent Note archive is unchanged and sealed', run: { script: 'verify-archived-agent-notes' } },
  { id: 'skill-invocation-metadata', title: 'Repository skills carry aligned Claude Code and Codex invocation metadata', run: { script: 'verify-skill-invocation-metadata' } },
  { id: 'translation-prompt', title: 'The committed translation prompt renders and parses as documented', run: { script: 'verify-translation-prompt' } },
  { id: 'upgrade-guides', title: 'Upgrade guides follow their layout, metadata, sections and word ceiling', run: { script: 'verify-upgrade-guides' } },
  { id: 'doc-standard-tests', title: 'Upstream\'s documentation-standard specs', run: { specs: ['scripts/doc-standard.spec.ts'] } },
  {
    id: 'docs-site-projection',
    title: 'Upstream\'s documentation-site projection and viewer specs',
    run: { specs: ['scripts/project-doc-site.spec.ts', 'scripts/verify-doc-site-fragments.spec.ts', 'website/tests/mermaid-viewer.spec.ts', 'website/tests/image-viewer.spec.ts', 'website/tests/code-groups.spec.ts', 'website/tests/table-filter.spec.ts', 'website/tests/page-markdown-actions.spec.ts', 'website/tests/raw-markdown.spec.ts'] },
    tier: 'agent',
  },
  { id: 'package-readme-limitations', title: 'Package READMEs carry the canonical limitations section, or an audited omission', run: { script: 'verify-package-readme-limitations' } },
  { id: 'docs-site-build', title: 'Upstream\'s VitePress documentation site builds, and every fragment it links resolves', run: { script: 'docs:build' }, tier: 'merge' },
  { id: 'rescope-vendor', title: 'Vendored packages keep their rescoped names, with no pre-rescope token left', run: { script: 'rescope-vendor:check' }, tier: 'agent' },
  { id: 'publint', title: 'Every published package passes publint', run: { script: 'publint' }, tier: 'merge', builtArtifacts: true },
  { id: 'constraints', title: 'Workspace constraints: versions, names and dependency protocols', run: { script: 'constraints' } },
  { id: 'default-product-isolation', title: 'Experimental packages stay outside default installations, runtime imports and shipped compositions', run: { script: 'verify-default-product-isolation' } },
  { id: 'product-use', title: 'Maintained packages have product use or an explicit non-default role', run: { script: 'verify-product-use' }, tier: 'agent' },
  { id: 'official-bundle-catalog', title: 'The embedded display metadata of the Official bundles is current', run: { script: 'verify-official-bundle-catalog' } },
  { id: 'provider-data', title: 'The pi-ai provider display metadata is current', run: { script: 'verify-provider-data' } },
  { id: 'package-dependencies', title: 'Every package\'s dependency sections match what its published faces import', run: { script: 'verify-package-dependencies' }, tier: 'merge' },
  { id: 'application-entrypoints', title: 'Node applications launch only through dsh profiles, and every other launcher is classified', run: { script: 'verify-application-entrypoints' } },
  { id: 'package-meta', title: 'Source locale metadata, official SVG artwork, Node resource exports and publication selections are valid', run: { script: 'verify-package-meta' } },
  { id: 'dsh-package-licenses', title: 'Repository-owned DSH npm packages declare MIT', run: { script: 'verify-dsh-package-licenses' } },
  { id: 'node-next-types', title: 'The built declarations resolve for a NodeNext consumer', run: { script: 'verify-node-next-types' }, tier: 'merge', builtArtifacts: true },
  { id: 'optional-dependency-imports', title: 'No static value import of an optional dependency', run: { script: 'verify-optional-dependency-imports' }, tier: 'agent' },
  { id: 'client-packages', title: 'Client package modes, the browser module-request graph and package-asset publication', run: { script: 'verify-client-packages' }, tier: 'agent' },
  { id: 'installer-locales', title: 'The Windows installer carries every shipped locale', run: { script: 'verify-installer-locales' } },
  { id: 'locale-metadata', title: 'Package and template metadata is translated into every shipped language', run: { script: 'verify-locale-metadata' } },
  {
    id: 'locale-dictionaries',
    title: 'Locale dictionaries agree across shipped languages',
    run: { specs: ['scripts/locale-dictionary-parity.spec.ts', 'scripts/shipped-locales.spec.ts', 'packages/client/locale/tests/apply.client.spec.ts'], testTimeoutMs: 60_000 },
  },
  { id: 'client-ui-i18n', title: 'Client UI copy goes through the locale dictionaries', run: { script: 'verify-client-ui-i18n' } },
  { id: 'client-route-resolution', title: 'App routes in browser code are document-relative', run: { script: 'verify-client-route-resolution' } },
  { id: 'no-bare-dispatcher', title: 'Every HTTP dispatcher honours the configured proxy or names its exemption', run: { script: 'verify-no-bare-dispatcher' } },
  { id: 'plugin-record-callers', title: 'Release packages declare Session events instead of writing plugin records', run: { script: 'verify-plugin-record-callers' }, tier: 'agent' },
  { id: 'no-top-level-await', title: 'No module-scope await in package sources', run: { script: 'verify-no-top-level-await' } },
  { id: 'cordis-config', title: 'Cordis Loader entry metadata and package resolution in every shipped configuration', run: { script: 'verify-cordis-config' } },
  { id: 'runtime-closure', title: 'The deploy manifest supplies every plugin a shipped preset references and every required workspace peer', run: { script: 'verify-runtime-closure' } },
  { id: 'issue-management', title: 'Upstream\'s issue-management policy specs', run: { script: 'test:issue-management' } },
  { id: 'client-domain-graph', title: 'Client domain directories import `contract/` and never each other', run: { script: 'verify-client-domain-graph' } },
  { id: 'module-graph', title: 'Upstream\'s generated module graph is current', run: { script: 'verify-module-graph' } },
  { id: 'duplication', title: 'No cross-file TypeScript clone in packages and scripts', run: { script: 'duplication' } },
  { id: 'lint', title: 'Upstream\'s oxlint rules over the repository', run: { script: 'lint:contracts-ready' }, tier: 'merge' },
]

/**
 * The runner's gates for {@link UPSTREAM}. Every gate reads the whole tree, so its pass is reused only for an unchanged
 * tree.
 */
export const UPSTREAM_GATES: readonly GateCheck[] = UPSTREAM.map(gate => ({
  id: `gates:${gate.id}`,
  title: gate.title,
  command: 'script' in gate.run ? ['pnpm', 'run', '--silent', gate.run.script] : specsCommand(gate.run),
  inputs: ['**'],
  ...gate.tier === undefined ? {} : { tier: gate.tier },
  ...gate.builtArtifacts === true ? { builtArtifacts: true } : {},
}))
