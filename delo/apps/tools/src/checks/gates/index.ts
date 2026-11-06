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

/** The integration branch that pull requests merge into; the range gates compare against it by default. */
const RANGE_BASE = 'origin/v5'

export const GATES: readonly GateCheck[] = [
  {
    id: 'gates:licence',
    title: 'Delo packages and the root LICENSE are MIT',
    command: [TSX, `${GATE_DIR}/licence.ts`],
    inputs: ['delo/**/package.json', 'LICENSE'],
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
  },
  {
    id: 'gates:commits',
    title: 'Commit subjects, sign-offs and changelog trailers in the range',
    command: [TSX, 'delo/apps/tools/src/check-commits.ts', '--base', RANGE_BASE],
  },
  {
    id: 'gates:doc-times',
    title: 'No calendar planning in the Delo documentation the range adds',
    command: [TSX, `${GATE_DIR}/doc-times.ts`, '--base', RANGE_BASE],
  },
  {
    id: 'gates:docs',
    title: 'Upstream documentation checks over delo/docs',
    command: [TSX, `${GATE_DIR}/docs.ts`],
    inputs: ['**/*.md', '**/*.i18n.yaml', 'scripts/**', 'packages/**', 'tsconfig*.json'],
  },
]
