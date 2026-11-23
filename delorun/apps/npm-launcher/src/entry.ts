#!/usr/bin/env node
/**
 * The published package's `bin`: refuses a Node older than the package's `engines` range with one line, before the
 * launcher's main module is read, and otherwise installs the process's last-resort handler ([refusals](./refusals.ts))
 * and runs the launcher. The refusal comes first because a module written for a newer Node can fail on syntax an older
 * one cannot read. Under Yarn's Plug'n'Play the entry then starts one plain Node process on itself and ends with its
 * status, because Yarn's patched `fs` breaks the launcher's file writes (see [pnp](./pnp.ts)); `pnp.ts` is loaded only
 * in that case.
 *
 * @module @delorun/npm-launcher/entry
 */
import { nodeRefusal } from './node-version.ts'

/** Plug'n'Play's version, set by Yarn's runtime; `@types/node` does not declare it. */
const pnpVersion = (process.versions as NodeJS.ProcessVersions & { pnp?: string }).pnp

/** Run the launcher in this process. */
function launch(): void {
  void import('./refusals.ts')
    .then(({ installLauncherLastResort }) => {
      installLauncherLastResort()
      return import('./bin.ts')
    })
    .then(async ({ main }) => {
      process.exitCode = await main(process.argv.slice(2))
    })
}

/** Leave Plug'n'Play: run this entry once more in a plain Node process, and end as it ends. */
function leavePlugAndPlay(): void {
  void import('./pnp.ts')
    .then(async ({ leavePnp, signalStatus }) => {
      const outcome = await leavePnp({ pnp: pnpVersion, entryUrl: import.meta.url, argv: process.argv.slice(2), env: process.env, execPath: process.execPath, pid: process.pid, parentId: process.ppid })
      if (outcome.action === 'continue') return launch()
      if (outcome.action === 'refuse') {
        process.stderr.write(`${outcome.line}\n`)
        process.exitCode = 1
      } else if (outcome.action === 'exit') {
        process.exitCode = outcome.code
      } else {
        // The default action of the signal ends this process the way it ended the child; a handler that survives it still exits.
        process.exitCode = signalStatus(outcome.signal)
        process.kill(process.pid, outcome.signal)
      }
    })
    .catch((error: unknown) => {
      process.stderr.write(`Delorun could not leave Yarn's Plug'n'Play: ${error instanceof Error ? error.message : String(error)}. Set "nodeLinker: node-modules" in .yarnrc.yml, or run "npx delorun" instead.\n`)
      process.exitCode = 1
    })
}

const refusal = nodeRefusal(process.versions.node)
if (refusal !== undefined) {
  process.stderr.write(`${refusal}\n`)
  process.exitCode = 1
} else if (pnpVersion === undefined) {
  launch()
} else {
  leavePlugAndPlay()
}
