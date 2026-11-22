/**
 * The gates of the check runner, one entry per gate. Each command runs from the repository root and exits 0 when the
 * gate passes. A staged gate accepts paths as trailing arguments, which the runner appends at pre-commit. A range gate
 * compares the commits from `origin/main` to HEAD; a CI run that checks another range passes its own `--base`.
 *
 * @module @delorun/tools/checks/gates
 */
import type { GateCheck } from '../types.ts'
import { readDebt, withDebt } from './debt.ts'
import { UPSTREAM_GATES } from './upstream.ts'

const TSX = 'node_modules/.bin/tsx'
const GATE_DIR = 'delorun/apps/tools/src/checks/gates'

/**
 * The inputs of `gates:fundamentals`: the fundamentals page, the gate's source, and every file an `enforced` row of the
 * page names. The gate fails when the page names a file this list does not, so a pass is never reused after a named
 * file changed.
 */
export const FUNDAMENTALS_INPUTS: readonly string[] = [
  'delorun/docs/security/fundamentals.md',
  `${GATE_DIR}/fundamentals.ts`,
  `${GATE_DIR}/index.ts`,
  'apps/desktop/src/browser-guests.ts',
  'apps/desktop/src/home-websocket.ts',
  'apps/desktop/src/main.ts',
  'apps/desktop/src/web-document.ts',
  'apps/desktop/src/wsl-connection.ts',
  'apps/desktop/src/wsl-home.ts',
  'apps/desktop/tests/home-websocket.spec.ts',
  'apps/desktop/tests/main-startup.spec.ts',
  'apps/desktop/tests/web-document.spec.ts',
  'apps/desktop/tests/wsl-connection.spec.ts',
  'apps/desktop/tests/wsl-home.spec.ts',
  'delorun/apps/cli/src/setup/answers.ts',
  'delorun/apps/cli/tests/denial/reach/end-to-end.spec.ts',
  'delorun/apps/cli/tests/denial/reach/reach-access.spec.ts',
  'delorun/apps/cli/tests/setup/answers.spec.ts',
  'delorun/apps/install/src/channel.ts',
  'delorun/apps/install/src/extract.ts',
  'delorun/apps/install/src/verify.ts',
  'delorun/apps/install/tests/channel.integration.spec.ts',
  'delorun/apps/install/tests/extract.spec.ts',
  'delorun/apps/install/tests/key-agility.integration.spec.ts',
  'delorun/apps/npm-launcher/src/launcher.ts',
  'delorun/apps/npm-launcher/src/root.ts',
  'delorun/apps/npm-launcher/tests/launcher.spec.ts',
  'delorun/packages/release-formats/src/log/entry-keys.ts',
  'delorun/packages/release-formats/src/sign/verify.ts',
  'delorun/apps/release/tests/sign/verify.integration.spec.ts',
  'delorun/packages/archive/src/importer.ts',
  'delorun/packages/archive/tests/consent.integration.spec.ts',
  'delorun/packages/bundle-local/cordis.patch.yml',
  'delorun/packages/bundle-local/tests/privacy-defaults.spec.ts',
  'delorun/packages/bundle-local/tests/protected-reads.integration.spec.ts',
  'delorun/packages/home-auth/src/authenticator.ts',
  'delorun/packages/home-auth/src/home-auth.ts',
  'delorun/packages/home-auth/src/reach-access.ts',
  'delorun/packages/home-auth/src/reach-routes.ts',
  'delorun/packages/home-auth/src/routes.ts',
  'delorun/packages/home-auth/src/service.ts',
  'delorun/packages/home-auth/tests/authenticator.spec.ts',
  'delorun/packages/home-auth/tests/denial/face-pass.spec.ts',
  'delorun/packages/home-auth/tests/owner-claim.spec.ts',
  'delorun/packages/home-auth/tests/reach-routes.spec.ts',
  'delorun/packages/home-auth/tests/routes.spec.ts',
  'delorun/packages/home-process/src/devices-approve.ts',
  'delorun/packages/home-process/tests/devices-approve.integration.spec.ts',
  'delorun/packages/plugin-fetch-guard/src/guard.ts',
  'delorun/packages/plugin-fetch-guard/tests/guard.spec.ts',
  'delorun/packages/plugin-fetch-guard/tests/provider-guard.spec.ts',
  'delorun/packages/plugin-instruction-consent/src/index.ts',
  'delorun/packages/plugin-instruction-consent/tests/consent.spec.ts',
  'delorun/packages/plugin-mcp-consent/src/index.ts',
  'delorun/packages/plugin-trash/src/operations.ts',
  'delorun/packages/release-verify/src/bundle.ts',
  'delorun/packages/release-verify/src/entry.ts',
  'delorun/packages/release-verify/src/online.ts',
  'delorun/packages/release-verify/tests/entry-keys.spec.ts',
  'delorun/packages/trash/src/service.ts',
  'delorun/packages/trash/tests/delete.integration.spec.ts',
  'delorun/packages/trash/tests/purge.integration.spec.ts',
  'packages/deliverables/tool-present/src/index.ts',
  'packages/deliverables/tool-present/tests/present.spec.ts',
  'packages/fs/tool-fs-search/src/search-core.ts',
  'packages/fs/tool-fs/src/consent.ts',
  'packages/fs/tool-fs/src/read-target.ts',
  'packages/fs/tool-fs/tests/integration.spec.ts',
  'packages/fs/tool-fs/tests/tools.spec.ts',
  'packages/mcp/mcp-client/src/index.ts',
  'packages/mcp/mcp-client/tests/consent.spec.ts',
  'packages/schedule/schedule/src/runtime.ts',
  'packages/schedule/schedule/tests/consent.spec.ts',
  'packages/schedule/tool-schedule/src/index.ts',
  'packages/schedule/tool-schedule/tests/consent.spec.ts',
  'packages/web/web-fetch-http/src/provider.ts',
]

/**
 * The ref the range gates and tree pass records compare HEAD with: `DELORUN_RANGE_BASE` when it is set and not empty,
 * else `origin/main`, the integration branch that pull requests merge into. This is the only place that names the default.
 * @param env - the environment the run starts with.
 * @returns the ref, which {@link unresolvedRangeBase} checks against the repository.
 */
export function rangeBase(env: NodeJS.ProcessEnv): string {
  const set = env['DELORUN_RANGE_BASE']
  return set === undefined || set === '' ? 'origin/main' : set
}

/**
 * Whether the range base was chosen with `DELORUN_RANGE_BASE`, which the run header names.
 * @param env - the environment the run starts with.
 * @returns true when the variable is set and not empty.
 */
export function rangeBaseOverridden(env: NodeJS.ProcessEnv): boolean {
  return env['DELORUN_RANGE_BASE'] !== undefined && env['DELORUN_RANGE_BASE'] !== ''
}

/**
 * The refusal for a range base that names no commit.
 * @param base - the range base from {@link rangeBase}.
 * @returns one actionable line naming the ref.
 */
export function unresolvedRangeBase(base: string): string {
  return `the range base ${base} is not a commit in this clone; fetch it, or set DELORUN_RANGE_BASE to a commit`
}

/**
 * The repository gates the runner schedules, in catalogue order: Delorun's own, then upstream's ({@link UPSTREAM_GATES}). A
 * gate's command runs from the repository root and passes on exit 0; at pre-commit the runner appends the staged paths to
 * the command of each staged gate. A gate listed in `debt.json` runs through `debt.ts`, which reports its failure
 * without failing the run and fails the run once it passes.
 * @param base - the ref each range gate's `--base` names, from {@link rangeBase}.
 * @returns the gates.
 */
export function gatesFor(base: string): readonly GateCheck[] {
  return withDebt([
    {
      id: 'gates:licence',
      title: 'Delorun packages and the root LICENSE are MIT',
      command: [TSX, `${GATE_DIR}/licence.ts`],
      inputs: ['delorun/**/package.json', 'LICENSE'],
    },
    {
      id: 'gates:erasable-syntax',
      title: 'Every Delorun source uses only syntax that Node\'s type stripping removes',
      command: [TSX, `${GATE_DIR}/erasable-syntax.ts`],
      inputs: ['delorun/**/*.ts', 'delorun/**/*.tsx', 'delorun/**/*.mts', 'delorun/**/*.cts', `${GATE_DIR}/erasable-syntax.ts`],
    },
    {
      id: 'gates:bundle-patch-literals',
      title: 'Shipped Delorun bundle patches disable rows only with literal true or false',
      command: [TSX, `${GATE_DIR}/bundle-patch-literals.ts`],
      inputs: ['delorun/packages/*/cordis.patch.yml', `${GATE_DIR}/bundle-patch-literals.ts`],
    },
    {
      id: 'gates:upstream-src-imports',
      title: 'No Delorun source imports a file from an upstream package\'s src/',
      command: [TSX, `${GATE_DIR}/upstream-src-imports.ts`],
      inputs: ['delorun/packages/*/src/**', 'delorun/apps/*/src/**', `${GATE_DIR}/upstream-src-imports.ts`],
    },
    {
      id: 'gates:external-agent-spawns',
      title: 'No Delorun source starts Claude Code or Codex outside the start gate, upstream\'s one-shot path and `delorun agents login`',
      command: [TSX, `${GATE_DIR}/external-agent-spawns.ts`],
      inputs: ['delorun/packages/*/src/**', 'delorun/apps/*/src/**', `${GATE_DIR}/external-agent-spawns.ts`],
    },
    {
      id: 'gates:no-unknown-casts',
      title: 'No assertion to `unknown` beyond upstream\'s recorded baseline, in upstream\'s sources and Delorun\'s',
      command: [TSX, 'scripts/verify-no-unknown-casts.ts'],
      inputs: ['**/*.ts', '**/*.mts', '**/*.cts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.cjs', '**/*.jsx', 'scripts/no-unknown-casts.baseline.json'],
    },
    {
      id: 'gates:package-states',
      title: 'Every Delorun package records a state that agrees with what the shipped roots reach',
      command: [TSX, `${GATE_DIR}/package-states.ts`],
      inputs: ['delorun/packages/*/package.json', 'delorun/apps/*/package.json', `${GATE_DIR}/package-states.ts`],
    },
    {
      id: 'gates:plugin-sentences',
      title: 'Every plugin the site lists has a title and a sentence in its locale/en.json',
      command: [TSX, `${GATE_DIR}/plugin-sentences.ts`],
      inputs: ['delorun/packages/*/package.json', 'delorun/packages/*/cordis.patch.yml', 'delorun/packages/*/locale/en.json', 'delorun/apps/website/src/plugin-browser/list-plugins.ts', `${GATE_DIR}/plugin-sentences.ts`],
    },
    {
      id: 'gates:preview-flags',
      title: 'Every Delorun package lists exactly the preview flags its plugin declares',
      command: [TSX, `${GATE_DIR}/preview-flags.ts`],
      inputs: ['delorun/packages/*/package.json', 'delorun/packages/*/src/**/*.ts', 'delorun/packages/*/src/**/*.tsx', `${GATE_DIR}/preview-flags.ts`],
    },
    {
      id: 'gates:workspace-graph',
      title: 'Delorun packages have no dependency cycle and the runtime closure carries no release or developer tooling',
      command: [TSX, `${GATE_DIR}/workspace-graph.ts`],
      inputs: ['delorun/packages/*/package.json', 'delorun/apps/*/package.json', 'delorun/apps/release/closure.json', `${GATE_DIR}/workspace-graph.ts`, `${GATE_DIR}/package-states.ts`],
    },
    {
      id: 'gates:secrets',
      title: 'No secrets in the staged or changed paths',
      command: [TSX, `${GATE_DIR}/secrets.ts`],
      inputs: ['**/*'],
      staged: true,
    },
    {
      id: 'gates:personal-data',
      title: 'No personal data or postal address in the staged paths or the range',
      command: [TSX, `${GATE_DIR}/personal-data.ts`, '--base', base],
      staged: true,
      history: true,
    },
    {
      id: 'gates:infrastructure',
      title: 'No deployment identifiers in the staged or changed paths',
      command: [TSX, `${GATE_DIR}/infrastructure.ts`],
      inputs: ['**/*'],
      staged: true,
    },
    {
      id: 'gates:brand-drift',
      title: 'No brand colour, named typeface or copy of the hex mark outside @delorun/brand',
      command: [TSX, `${GATE_DIR}/brand-drift.ts`],
      inputs: ['delorun/packages/*/src/**', 'delorun/packages/site-design/**', 'delorun/apps/website/{src,public,scripts}/**', 'delorun/apps/docs/{src,public,scripts}/**', `${GATE_DIR}/brand-drift.*`],
    },
    {
      id: 'gates:dco',
      title: 'Every commit in the range is signed off by its author',
      command: [TSX, `${GATE_DIR}/dco.ts`, '--base', base],
      history: true,
    },
    {
      id: 'gates:commits',
      title: 'Commit subjects, sign-offs and changelog trailers in the range',
      command: [TSX, 'delorun/apps/tools/src/check-commits.ts', '--base', base],
      history: true,
    },
    {
      id: 'gates:changelog',
      title: 'Each product change in the range has a changelog fragment or a reasoned trailer, and every fragment parses',
      command: [TSX, 'delorun/apps/release/src/changelog/check.ts', '--base', base],
      history: true,
    },
    {
      id: 'gates:doc-times',
      title: 'No calendar planning in the Delorun documentation the range adds',
      command: [TSX, `${GATE_DIR}/doc-times.ts`, '--base', base],
      history: true,
    },
    {
      id: 'gates:spec-lanes',
      title: 'No unit spec starts a process, and every synchronous process call under a tests directory has a timeout',
      command: [TSX, `${GATE_DIR}/spec-lanes.ts`],
      inputs: ['delorun/apps/*/tests/**', 'delorun/packages/*/tests/**', `${GATE_DIR}/spec-lanes.ts`],
    },
    {
      id: 'gates:whitespace',
      title: 'No whitespace error, and exactly one final newline, in the files that differ from the merge base with origin/main',
      command: [TSX, `${GATE_DIR}/whitespace.ts`, '--base', base],
      history: true,
    },
    {
      id: 'gates:docs',
      title: 'Upstream documentation checks over delorun/docs',
      command: [TSX, `${GATE_DIR}/docs.ts`],
      inputs: ['**/*.md', '**/*.i18n.yaml', 'scripts/**', 'packages/**', 'tsconfig*.json', `${GATE_DIR}/docs.ts`],
      tier: 'agent',
    },
    {
      id: 'gates:fundamentals',
      title: 'Each enforced security fundamental names code that exists and a test that exists with its exact title',
      command: [TSX, `${GATE_DIR}/fundamentals.ts`],
      inputs: FUNDAMENTALS_INPUTS,
    },
    ...UPSTREAM_GATES,
  ], readDebt())
}

/** The gates with the default range base, for consumers that read the catalogue and run nothing. */
export const GATES: readonly GateCheck[] = gatesFor(rangeBase({}))
