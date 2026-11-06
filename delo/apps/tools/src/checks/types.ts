/**
 * The gate descriptor the check runner consumes. Each gate is one command the runner executes from the
 * repository root and passes when the command exits 0.
 *
 * @module @delo/tools/checks/types
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
   * True when the verdict reads commits beyond the tree, such as the range gates' commits from `origin/v5` to HEAD.
   * A tree pass covers such a gate only at the same HEAD commit and range base (`checks/tree-pass.ts`).
   */
  readonly history?: boolean
}
