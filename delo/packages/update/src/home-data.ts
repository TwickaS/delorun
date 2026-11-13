/**
 * The home-data operations `delorun repair` runs in the npm launcher, without the report builder and its upstream
 * dependencies: the home's data-format record, a release's `data-formats.json`, and the session-data copy a repair
 * restores.
 *
 * @module @delo/update/home-data
 */
export { readCopyRecord, restoreDataCopy, RUNTIMES_SET_ASIDE_PREFIX, type CopyRecord } from './data-copy.ts'
export { readDataFormats } from './data-formats.ts'
export { readHomeDataFormat, relateHomeData, type HomeDataRelation } from './home-data-format.ts'
