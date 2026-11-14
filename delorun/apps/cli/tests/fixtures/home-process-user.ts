/**
 * A process registered as one profile's home process, as `delorun start` registers it, until its standard input
 * closes: `home-process-user.ts <home> <profile>` prints `registered` once the registration is written.
 */
import { registerHomeProcess } from '../../src/home-exclusion.ts'

const [home, profile] = process.argv.slice(2)
if (home === undefined || profile === undefined) throw new Error('usage: home-process-user.ts <home> <profile>')
const release = await registerHomeProcess(home, profile)
process.stdout.write('registered\n')
process.stdin.resume()
process.stdin.once('end', () => {
  release()
  process.exit(0)
})
