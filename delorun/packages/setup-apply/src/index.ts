/**
 * `@delorun/setup-apply`: the writes that apply a setup answer to a profile, shared by the `delorun` command and the
 * studio's How Delorun runs controls, so one definition of each row and record serves both.
 *
 * @module @delorun/setup-apply
 */
export { SetupApplyError } from './errors.ts'
export { JS_TAG, readPatchRow, setPatchRow, setPatchRows, setRowFields, updateRowConfig, type InheritedRow, type PatchRow, type PatchValue } from './patch-file.ts'
export { FULL_ACCESS_EVERYWHERE_KEY, promptRows, PROMPT_SWITCH_ROWS, readPromptsRows, writePromptRows, type PromptRow } from './prompt-rows.ts'
export { runsAsRoot } from './dangerous.ts'
export { DANGEROUS_WARNING_LINES } from './warning.ts'
export { BROWSER_BLOCKED_PORTS, STUDIO_ROW_ID, studioPortProblem, studioRow } from './studio-row.ts'
export { listenerPortFor, readReachRowAt, REACH_OFF, REACH_ROW_ID, reachRowsOf, signInAddress, writeReachRowAt, type TailscalePrivateRow } from './reach-row.ts'
export { TRUST_STATEMENT } from './trust.ts'
export { HOME_AUTH_ROW_ID, readPairingAt, readSecretsDirectoryAt, writeMayAskAt } from './pairing-row.ts'
export { ANSWERS_FILENAME, backgroundOf, promptsOf, readAnswersRecord, updateAnswersRecord, type AnswersRecord } from './answers-record.ts'
