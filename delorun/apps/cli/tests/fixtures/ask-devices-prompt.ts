/** Asks the `delorun devices approve` question the way bin.ts runs a command: a top-level await on the prompt. */
import { askInTerminal } from '../../src/devices/command.ts'

try {
  await askInTerminal('Type the number of the device to approve')
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
