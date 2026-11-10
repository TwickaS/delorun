/**
 * Every suite, in the order a full run measures them. A lane that adds a point where a person waits adds its module
 * under this directory and one entry here, and records its first ceilings in `budgets.json`.
 *
 * @module @delo/benchmarks/suites
 */
import type { Suite } from '../harness/suite.ts'
import { updateSuite } from './update/index.ts'

/** The suites. */
export const SUITES: readonly Suite[] = [updateSuite]
