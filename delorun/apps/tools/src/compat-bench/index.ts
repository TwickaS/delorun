/**
 * The plugin compatibility bench as a library. `runPlugin` runs one plugin through the stages on one host and returns
 * its card; stages and observers are options, nothing here writes to the console or exits the process (that is
 * `cli.ts`, a thin wrapper around these functions).
 *
 * @module @delorun/tools/compat-bench
 */
export { runBench as runPlugin, runBaseline, type RunRequest, type RunResult } from './runner.ts'
export { buildImage, planImage, imageTag, PREVIOUS_RELEASE_TAG, type ImageRequest } from './images.ts'
export { DEFAULT_STAGES, type Stage } from './pipeline.ts'
export { renderCard, validateCard, deriveVerdict, type Card, type StageResult } from './card.ts'
export { renderTable } from './table.ts'
export { rankCauses, renderBoard, downloadsFor } from './board.ts'
export { loadLatestCards } from './cards-dir.ts'
export type { Observer, RunContext, ContainerAdditions, PrivacySection, StageName, Marker } from './observer.ts'
export type { RunState, PluginSource, Baseline } from './stages.ts'
