/**
 * The parity replay lane's refusals that hold without running a replay: each snapshot adapter checks
 * `DSH_SNAPSHOT_PATCH` against its `DSH_SNAPSHOT` mode in its module's top-level code, so the check runs when the
 * module loads and before any test starts a process, and the check refuses the record and refresh modes. A replay
 * with a planted switch left on runs as the merge-only check `parity-replay:control`, and the shipped profile's run
 * is in `replay-lane.integration.spec.ts`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { SNAPSHOT_PATCH_ENV, snapshotPatchOverlay } from '@deepseek-ai/dsh-session-snapshot/src/snapshot-patch.ts'
import { PARITY_OVERLAY_ENV } from '@delorun/contract-parity-composition'

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
/** The modules that read the variable for upstream's replay: the three adapters and the web adapters' shared scaffold. */
const ADAPTERS = ['snapshots/session/headless.snapshot.ts', 'snapshots/sdk/sdk.snapshot.ts', 'snapshots/acp/acp.snapshot.ts', 'apps/web/tests/scaffold.ts']
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * Whether a module's top-level statements call `snapshotPatchOverlay(process.env.DSH_SNAPSHOT)`.
 * @param path - the module, repository-relative.
 * @returns true when a top-level variable statement's initializer is that call.
 */
function checksAtLoad(path: string): boolean {
  const source = ts.createSourceFile(path, readFileSync(join(ROOT, path), 'utf8'), ts.ScriptTarget.Latest, true)
  return source.statements.some(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(({ initializer }) =>
    initializer !== undefined && ts.isCallExpression(initializer) && initializer.expression.getText(source) === 'snapshotPatchOverlay'
    && initializer.arguments.length === 1 && initializer.arguments[0]?.getText(source) === 'process.env.DSH_SNAPSHOT'))
}

describe('the replay lane', () => {
  it('parity replay refuses record and refresh modes', () => {
    expect(SNAPSHOT_PATCH_ENV).toBe(PARITY_OVERLAY_ENV)
    for (const adapter of ADAPTERS) expect(checksAtLoad(adapter), adapter).toBe(true)
    const directory = mkdtempSync(join(tmpdir(), 'delorun-replay-lane-'))
    directories.push(directory)
    const overlay = join(directory, 'overlay.yml')
    writeFileSync(overlay, '[]\n')
    for (const mode of ['record', 'refresh']) {
      expect(() => snapshotPatchOverlay(mode, { [PARITY_OVERLAY_ENV]: overlay }), mode)
        .toThrow(`${PARITY_OVERLAY_ENV} selects a replay-only overlay and is refused in DSH_SNAPSHOT=${mode} mode`)
    }
    expect(snapshotPatchOverlay('replay', { [PARITY_OVERLAY_ENV]: overlay })).toEqual([overlay])
    expect(snapshotPatchOverlay(undefined, {})).toEqual([])
  })
})
