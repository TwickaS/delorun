// A plugin that reads the files named on the command line, three ways, and ignores errors.
import { createReadStream, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
const [first, second, third] = process.argv.slice(2)
try { readFileSync(first) } catch { /* a missing file is fine */ }
try { await readFile(second) } catch { /* a missing file is fine */ }
try { createReadStream(third).on('error', () => {}).resume() } catch { /* a missing file is fine */ }
await new Promise(done => setTimeout(done, 50))
console.log('done')
