// What the host under test does in the end-to-end spec with or without a plugin: serves on the loopback address, reads
// the model key variable, and starts one helper program.
import { spawnSync } from 'node:child_process'
import net from 'node:net'
const server = net.createServer().listen(18590, '127.0.0.1')
void process.env.DEEPSEEK_API_KEY
spawnSync('node', ['-e', '0'], { timeout: 20_000 })
setTimeout(() => { server.close() }, 200)
