/**
 * The files of a new Delo plugin and the writer that puts them in a folder, shared by `delorun plugin new` and the
 * studio's Create a plugin.
 *
 * @module @delo/plugin-scaffold
 */
export { checkKind, checkName, createPlugin, type CreateRequest } from './create.ts'
export { ScaffoldError, type ScaffoldErrorKind } from './error.ts'
export { installedCordisVersion, installationShips, resolvesFrom, runningInstallation, RESERVED_SCOPES, type Installation } from './installation.ts'
export { bareName, PLUGIN_KINDS, scaffoldFiles, scaffoldNames, targetRange, TOOLCHAIN, type PluginKind, type ScaffoldFile, type ScaffoldNames, type ScaffoldPlan } from './scaffold.ts'
export { nextCommands, PAGE_MODULES } from './templates.ts'
