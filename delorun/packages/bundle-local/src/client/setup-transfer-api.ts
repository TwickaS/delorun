/**
 * Requests to the home's setup routes (Move your setup, in the Setup versions section) and the validation of their JSON
 * answers. The routes and the answer fields are `@delorun/plugin-changes`' own ([wire](../../../plugin-changes/src/wire.ts)),
 * which serves them to the studio at the home's computer only; requests go through [`./host-api.ts`](./host-api.ts).
 * @module @delorun/bundle-local/client/setup-transfer-api
 */
import { SETUP_PATHS, type SetupApplyView, type SetupExportView, type SetupInspectView, type SetupPluginsView } from '@delorun/plugin-changes/wire'
import { call, fields, isBoolean, isString, isTime, listOf, optional, type Check, type HostFetch } from './host-api.ts'

const isInstall: Check = fields({ name: isString, version: optional(isString), kind: value => value === 'add' || value === 'replace', source: value => value === 'registry' || value === 'local', from: optional(isString) })
const isSigner: Check = fields({ state: value => value === 'verified' || value === 'unverified', reason: optional(isString), fingerprint: isString })
const isProtection: Check = value => value === 'on' || value === 'off'
const isPlugins: Check = fields({ plugins: listOf(fields({ name: isString, source: value => value === 'registry' || value === 'local' })) })
const isExported: Check = fields({ file: isString, name: isString, plugins: isTime, local: isTime, settings: isTime, leftOut: listOf(isString), signedBy: isString, withoutCode: listOf(isString) })
const isInspected: Check = fields({
  token: isString, signer: isSigner, createdBy: isString, exportedAt: isString, note: optional(isString), includesSettings: isBoolean, replaces: listOf(isString), named: listOf(isString), sourceProfile: isString, install: listOf(isInstall), remove: listOf(isString), keep: listOf(isString),
  settings: listOf(isString), endpoints: listOf(isString), leftOut: listOf(isString), keyNotes: listOf(isString), protection: isProtection, changes: isBoolean,
})
const isApplied: Check = fields({
  savedVersion: isString, removed: listOf(isString), installed: listOf(fields({ name: isString, reviewChange: optional(isString) })), settingsWritten: isBoolean, keyNotes: listOf(isString), protection: isProtection,
})

/** What the person chose to put in a file. */
export interface ExportChoices {
  readonly settings: boolean
  readonly localCode: boolean
  /** The plugins to include; every plugin when absent. */
  readonly plugins?: readonly string[]
  readonly note?: string
}

/** What the person chose an import to replace. */
export interface ImportChoices {
  readonly settings: boolean
  readonly removeOthers: boolean
}

/**
 * The plugins the profile could put in a file.
 * @param fetch - the request function.
 * @returns them.
 * @throws {HostRequestError} for a refusal, an unreachable Host or an unreadable answer.
 */
export function listSetupPlugins(fetch: HostFetch): Promise<SetupPluginsView> {
  return call<SetupPluginsView>(fetch, SETUP_PATHS.export, isPlugins, { list: true })
}

/**
 * Write the profile's setup as a signed file.
 * @param fetch - the request function.
 * @param choices - what to put in it.
 * @returns the file as base64 and what it holds.
 * @throws {HostRequestError} for a refusal (`LOOPBACK_REQUIRED`, `SETUP_REFUSED` for a key in a settings row), an unreachable Host or an unreadable answer.
 */
export function exportSetupFile(fetch: HostFetch, choices: ExportChoices): Promise<SetupExportView> {
  return call<SetupExportView>(fetch, SETUP_PATHS.export, isExported, { ...choices })
}

/**
 * Send a setup file for checking; nothing is changed.
 * @param fetch - the request function.
 * @param bytes - the file.
 * @param choices - what the person chose to import.
 * @returns who signed it and everything an import would change, with the token that applies it.
 * @throws {HostRequestError} for a file that fails a check (an `ARCHIVE_…` code), another refusal, an unreachable Host or an unreadable answer.
 */
export function inspectSetupFile(fetch: HostFetch, bytes: Uint8Array, choices: ImportChoices): Promise<SetupInspectView> {
  return call<SetupInspectView>(fetch, SETUP_PATHS.inspect, isInspected, { file: toBase64(bytes), ...choices })
}

/**
 * Plan the import of a file the home already holds again, with other choices.
 * @param fetch - the request function.
 * @param token - the token the first inspection returned.
 * @param choices - what the person chose to import.
 * @returns the new list of changes, with the same token.
 * @throws {HostRequestError} for a refusal (`SETUP_EXPIRED`), an unreachable Host or an unreadable answer.
 */
export function replanSetupFile(fetch: HostFetch, token: string, choices: ImportChoices): Promise<SetupInspectView> {
  return call<SetupInspectView>(fetch, SETUP_PATHS.inspect, isInspected, { token, ...choices })
}

/**
 * Apply an inspected file.
 * @param fetch - the request function.
 * @param token - the token the inspection returned.
 * @param choices - what the person chose to import.
 * @returns what was done.
 * @throws {HostRequestError} for a refusal (`SETUP_EXPIRED`, `OPERATION_FAILED`), an unreachable Host or an unreadable answer.
 */
export function applySetupFile(fetch: HostFetch, token: string, choices: ImportChoices): Promise<SetupApplyView> {
  return call<SetupApplyView>(fetch, SETUP_PATHS.apply, isApplied, { token, ...choices })
}

/**
 * @param bytes - some bytes.
 * @returns them as base64.
 */
export function toBase64(bytes: Uint8Array): string {
  let text = ''
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(text)
}

/**
 * @param text - base64 text.
 * @returns the bytes.
 */
export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), character => character.charCodeAt(0))
}
