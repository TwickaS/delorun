/**
 * An update's successor that hands off as the signed installation does and then hangs at boot: `handed-off-successor.ts
 * <socket>` connects to the socket, says `parent <pid>`, and runs a child through the hand-off's `runChild`, which
 * connects too, says `child <pid>` and never answers the handover.
 */
import { connect } from 'node:net'
import { runChild } from '../../src/changes/harness-start.ts'

const [socket] = process.argv.slice(2)
if (socket === undefined) throw new Error('usage: handed-off-successor.ts <socket>')
const parent = connect(socket, () => { parent.write(`parent ${String(process.pid)}\n`) })
const child = `const s = require('node:net').connect(${JSON.stringify(socket)}, () => { s.write('child ' + process.pid + '\\n') }); setInterval(() => {}, 1000)`
await runChild({ node: process.execPath, args: ['-e', child] }, process.env, 'inherit', 'the child did not start')
