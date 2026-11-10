/**
 * The gates of the check runner, one entry per gate. Each command runs from the repository root and exits 0 when the
 * gate passes. A staged gate accepts paths as trailing arguments, which the runner appends at pre-commit. A range gate
 * compares the commits from `origin/v5` to HEAD; a CI run that checks another range passes its own `--base`.
 *
 * @module @delo/tools/checks/gates
 */
import type { GateCheck } from '../types.ts'

const TSX = 'node_modules/.bin/tsx'
const GATE_DIR = 'delo/apps/tools/src/checks/gates'

/**
 * The inputs of `gates:fundamentals`: the fundamentals page, the gate's source, and every file an `enforced` row of the
 * page names. The gate fails when the page names a file this list does not, so a pass is never reused after a named
 * file changed.
 */
const FUNDAMENTALS_INPUTS = [
  'delo/docs/security/fundamentals.md',
  `${GATE_DIR}/fundamentals.ts`,
  `${GATE_DIR}/index.ts`,
  'delo/apps/cli/src/setup/answers.ts',
  'delo/apps/cli/tests/setup/answers.spec.ts',
  'delo/apps/install/src/channel.ts',
  'delo/apps/install/src/extract.ts',
  'delo/apps/install/src/verify.ts',
  'delo/apps/install/tests/channel.integration.spec.ts',
  'delo/apps/install/tests/extract.spec.ts',
  'delo/apps/npm-launcher/src/launcher.ts',
  'delo/apps/npm-launcher/src/root.ts',
  'delo/apps/npm-launcher/tests/launcher.spec.ts',
  'delo/apps/release/src/sign/verify.ts',
  'delo/apps/release/tests/sign/verify.integration.spec.ts',
  'delo/packages/archive/src/importer.ts',
  'delo/packages/archive/tests/consent.integration.spec.ts',
  'delo/packages/bundle-local/cordis.patch.yml',
  'delo/packages/bundle-local/tests/privacy-defaults.spec.ts',
  'delo/packages/bundle-local/tests/protected-reads.integration.spec.ts',
  'delo/packages/home-auth/src/home-auth.ts',
  'delo/packages/home-auth/src/routes.ts',
  'delo/packages/home-auth/tests/owner-claim.spec.ts',
  'delo/packages/home-auth/tests/routes.spec.ts',
  'delo/packages/plugin-fetch-guard/src/guard.ts',
  'delo/packages/plugin-fetch-guard/tests/guard.spec.ts',
  'delo/packages/plugin-fetch-guard/tests/provider-guard.spec.ts',
  'delo/packages/plugin-instruction-consent/src/index.ts',
  'delo/packages/plugin-instruction-consent/tests/consent.spec.ts',
  'delo/packages/plugin-mcp-consent/src/index.ts',
  'delo/packages/plugin-trash/src/operations.ts',
  'delo/packages/release-verify/src/online.ts',
  'delo/packages/trash/src/service.ts',
  'delo/packages/trash/tests/delete.integration.spec.ts',
  'delo/packages/trash/tests/purge.integration.spec.ts',
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

/** The integration branch that pull requests merge into; the range gates compare against it by default. */
export const RANGE_BASE = 'origin/v5'

/**
 * The repository gates the runner schedules, in catalogue order. A gate's command runs from the repository root and
 * passes on exit 0; at pre-commit the runner appends the staged paths to the command of each staged gate.
 */
export const GATES: readonly GateCheck[] = [
  {
    id: 'gates:licence',
    title: 'Delo packages and the root LICENSE are MIT',
    command: [TSX, `${GATE_DIR}/licence.ts`],
    inputs: ['delo/**/package.json', 'LICENSE'],
  },
  {
    id: 'gates:package-states',
    title: 'Every Delo package records a state that agrees with what the shipped roots reach',
    command: [TSX, `${GATE_DIR}/package-states.ts`],
    inputs: ['delo/packages/*/package.json', 'delo/apps/*/package.json', `${GATE_DIR}/package-states.ts`],
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
    command: [TSX, `${GATE_DIR}/personal-data.ts`, '--base', RANGE_BASE],
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
    id: 'gates:dco',
    title: 'Every commit in the range is signed off by its author',
    command: [TSX, `${GATE_DIR}/dco.ts`, '--base', RANGE_BASE],
    history: true,
  },
  {
    id: 'gates:commits',
    title: 'Commit subjects, sign-offs and changelog trailers in the range',
    command: [TSX, 'delo/apps/tools/src/check-commits.ts', '--base', RANGE_BASE],
    history: true,
  },
  {
    id: 'gates:changelog',
    title: 'Each product change in the range has a changelog fragment or a reasoned trailer, and every fragment parses',
    command: [TSX, 'delo/apps/release/src/changelog/check.ts', '--base', RANGE_BASE],
    history: true,
  },
  {
    id: 'gates:doc-times',
    title: 'No calendar planning in the Delo documentation the range adds',
    command: [TSX, `${GATE_DIR}/doc-times.ts`, '--base', RANGE_BASE],
    history: true,
  },
  {
    id: 'gates:spec-lanes',
    title: 'No unit spec starts a process, and every synchronous process call under a tests directory has a timeout',
    command: [TSX, `${GATE_DIR}/spec-lanes.ts`],
    inputs: ['delo/apps/*/tests/**', 'delo/packages/*/tests/**', `${GATE_DIR}/spec-lanes.ts`],
  },
  {
    id: 'gates:docs',
    title: 'Upstream documentation checks over delo/docs',
    command: [TSX, `${GATE_DIR}/docs.ts`],
    inputs: ['**/*.md', '**/*.i18n.yaml', 'scripts/**', 'packages/**', 'tsconfig*.json', `${GATE_DIR}/docs.ts`],
  },
  {
    id: 'gates:fundamentals',
    title: 'Each enforced security fundamental names code that exists and a test that exists with its exact title',
    command: [TSX, `${GATE_DIR}/fundamentals.ts`],
    inputs: FUNDAMENTALS_INPUTS,
  },
]
