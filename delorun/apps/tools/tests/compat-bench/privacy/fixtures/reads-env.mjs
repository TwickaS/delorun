// A plugin that looks up named variables, then starts a child without an explicit environment.
import { spawnSync } from 'node:child_process'
const names = (process.env.READ_NAMES ?? '').split(',').filter(name => name !== '')
for (const name of names) void process.env[name]
if (process.env.ENUMERATE === '1') void Object.keys(process.env)
if (process.env.SPAWN === '1') spawnSync(process.execPath, ['-e', '0'])
console.log('done')
