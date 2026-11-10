/**
 * `delorun stop` (contract C19, "Commands"): sends the home process `stop` over the update channel. Without `--now`
 * the mode is `drain`: new turns are refused and running chats are waited for at most 1,800 seconds. `--now` sends
 * `cancel`, which cancels running turns and background jobs first. With no home process running, it prints that and
 * exits 0.
 *
 * @module @delo/cli/stop
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { START_WAIT_MS } from '@delo/contract-home-process'
import { holderAlive, readHomeLock, resolveDeloHome, runDirectory } from '@delo/home'
import { sendHomeRequest } from '@delo/home-process'
import { EXIT } from './exit.ts'
import { parseOptions, type CliCommand } from './command.ts'
import { selectProfile } from './profile.ts'

/** `delorun stop [--now] [--profile <name>]`. */
export const stopCommand: CliCommand = {
  name: 'stop',
  summary: 'Stop the home process once running chats end, or at once with --now',
  async run(args, context) {
    const values = parseOptions('stop', args, { now: { type: 'boolean', default: false }, profile: { type: 'string' } })
    const profile = selectProfile(values.profile, context.env)
    const home = await resolveDeloHome(context.env)
    const directory = runDirectory(home.path, profile)
    const record = readHomeLock(directory)
    if (record === undefined || !holderAlive(record)) {
      context.stdout(`Delo is not running for the profile ${profile}.\n`)
      return EXIT.ok
    }
    let lines
    try {
      lines = await sendHomeRequest(home.path, profile, { op: 'stop', args: { mode: values.now === true ? 'cancel' : 'drain' } }, {
        onLine: (line) => {
          if (line.ok && typeof line.chats === 'number' && line.chats > 0) context.stdout(`Waiting for ${String(line.chats)} running chat(s) to end…\n`)
        },
      })
    } catch (error) {
      context.stderr(`delorun stop: process ${String(record.pid)} holds the profile's lock but its update channel did not answer: ${error instanceof Error ? error.message : String(error)}\n`)
      return EXIT.failed
    }
    const final = lines.at(-1)
    if (final?.ok !== true) {
      context.stderr(`delorun stop: the home process refused to stop: ${String(final?.error ?? 'no answer')}${typeof final?.detail === 'string' ? ` (${final.detail})` : ''}\n`)
      return EXIT.failed
    }
    const deadline = Date.now() + START_WAIT_MS
    while (holderAlive(record) && readHomeLock(directory)?.startId === record.startId) {
      if (Date.now() > deadline) {
        context.stderr(`delorun stop: process ${String(record.pid)} accepted the stop but has not exited\n`)
        return EXIT.failed
      }
      await sleep(100)
    }
    context.stdout(`Delo stopped for the profile ${profile}.\n`)
    return EXIT.ok
  },
}
