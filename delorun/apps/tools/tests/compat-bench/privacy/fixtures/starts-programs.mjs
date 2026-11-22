// A plugin that runs ordinary programs it declares: node itself, three ways.
import { exec, execFileSync, spawn } from 'node:child_process'
execFileSync(process.execPath, ['-e', '0'])
await new Promise(done => spawn(process.execPath, ['-v'], { stdio: 'ignore' }).on('close', done))
await new Promise(done => exec(`${JSON.stringify(process.execPath)} -e 0`, done))
console.log('done')
