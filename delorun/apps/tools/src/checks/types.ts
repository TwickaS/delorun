/**
 * The gate descriptor the check runner consumes. Each gate is one command the runner executes from the
 * repository root and passes when the command exits 0.
 *
 * @module @delorun/tools/checks/types
 */

/** One gate of the check runner. */
export interface GateCheck {
  /** Stable identifier, such as `gates:licence`, that names the gate in the runner's output and selections. */
  readonly id: string
  /** The gate's title in the runner's output. */
  readonly title: string
  /** The argv the runner executes from the repository root; the first entry is the program. */
  readonly command: readonly string[]
  /**
   * Repository-relative globs whose changes can change the verdict. Omitted when the verdict also reads git
   * history or other state outside the repository files.
   */
  readonly inputs?: readonly string[]
  /** True when the runner appends the staged paths to `command` at pre-commit, so the command accepts paths. */
  readonly staged?: boolean
  /**
   * True when the verdict reads commits beyond the tree, such as the range gates' commits from `origin/main` to HEAD.
   * A tree pass covers such a gate only at the same HEAD commit and range base (`checks/tree-pass.ts`).
   */
  readonly history?: boolean
  /**
   * The lightest gate tier that runs it. Absent, every tier runs it; `agent` leaves it out of the lane tier, for a gate
   * that takes minutes rather than seconds; `merge` runs it only in the merge tier, the full gate, or when `--only` names it.
   */
  readonly tier?: 'agent' | 'merge'
  /** True when it reads upstream's built output, so it waits for `build:artifacts` whenever that build is missing or stale. */
  readonly builtArtifacts?: true
  /** Variables the runner sets for the command over the inherited environment. */
  readonly environment?: Readonly<Record<string, string>>
}
