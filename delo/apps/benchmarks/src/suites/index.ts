/**
 * Every suite, in the order a full run measures them. A lane that adds a point where a person waits adds its module
 * under this directory and one entry here, and records its first ceilings in `budgets.json`.
 *
 * @module @delo/benchmarks/suites
 */
import type { Suite } from '../harness/suite.ts'
import { cliSuite } from './cli/index.ts'
import { dataSuite } from './data/index.ts'
import { installSuite } from './install/index.ts'
import { pluginsSuite } from './plugins/index.ts'
import { recoverySuite } from './recovery/index.ts'
import { startSuite } from './start/index.ts'
import { studioSuite } from './studio/index.ts'
import { turnSuite } from './turn/index.ts'
import { updateSuite } from './update/index.ts'

/** The suites. */
export const SUITES: readonly Suite[] = [updateSuite, cliSuite, startSuite, installSuite, recoverySuite, dataSuite, pluginsSuite, turnSuite, studioSuite]
