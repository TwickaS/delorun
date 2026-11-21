/**
 * The home-data operations `delorun repair` runs in the npm launcher, without the report builder and its upstream
 * dependencies: the home's data-format record, a release's `data-formats.json`, and the session-data copy a repair
 * restores.
 *
 * @module @delorun/update/home-data
 */
export { isRuntimesSetAsideName, readCopyRecord, restoreDataCopy, runtimesSetAsideName, RUNTIMES_SET_ASIDE_PREFIX, type CopyRecord } from './data-copy.ts'
export { readDataFormats } from './data-formats.ts'
export { readHomeDataFormat, relateHomeData, writeHomeDataFormat, type HomeDataRelation } from './home-data-format.ts'
