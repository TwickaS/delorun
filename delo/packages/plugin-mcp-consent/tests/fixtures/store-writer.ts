/**
 * Test-only second profile's process: takes the MCP acceptance store's lock of the store in argv[2], prints `held`,
 * waits for a line on standard input, then reads the store, adds an acceptance for the server `other` and writes it,
 * releases the lock, prints `done` and exits.
 */
import { createInterface } from 'node:readline'
import { acceptanceOfStart, EMPTY_ACCEPTANCE_STORE, readAcceptanceStore, withAcceptanceStoreLock, writeAcceptanceStore } from '../../src/store.ts'

const path = process.argv[2] as string
const input = createInterface({ input: process.stdin })
await withAcceptanceStoreLock(path, async () => {
  process.stdout.write('held\n')
  await new Promise<void>((resolve) => { input.once('line', () => { resolve() }) })
  const read = await readAcceptanceStore(path)
  if (read.kind === 'refused') throw new Error(read.problem)
  const store = read.kind === 'readable' ? read.store : EMPTY_ACCEPTANCE_STORE
  const other = { command: 'other', args: [], cwd: '', resolvedCommand: '/usr/bin/other', resolvedCwd: '/', env: {}, files: [{ path: '/usr/bin/other', sha256: `sha256:${'1'.repeat(64)}` }] }
  await writeAcceptanceStore(path, { ...store, acceptances: new Map(store.acceptances).set('other', acceptanceOfStart(other, 2)) })
})
process.stdout.write('done\n')
input.close()
