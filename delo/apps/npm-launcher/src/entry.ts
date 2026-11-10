#!/usr/bin/env node
/**
 * The published package's `bin`: refuses a Node older than the package's `engines` range with one line, before the
 * launcher's main module is read, and otherwise installs the process's last-resort handler ([refusals](./refusals.ts))
 * and runs the launcher. The refusal comes first because a module written for a newer Node can fail on syntax an older
 * one cannot read.
 *
 * @module @delo/npm-launcher/entry
 */
import { nodeRefusal } from './node-version.ts'

const refusal = nodeRefusal(process.versions.node)
if (refusal !== undefined) {
  process.stderr.write(`${refusal}\n`)
  process.exitCode = 1
} else {
  void import('./refusals.ts')
    .then(({ installLauncherLastResort }) => {
      installLauncherLastResort()
      return import('./bin.ts')
    })
    .then(async ({ main }) => {
      process.exitCode = await main(process.argv.slice(2))
    })
}
