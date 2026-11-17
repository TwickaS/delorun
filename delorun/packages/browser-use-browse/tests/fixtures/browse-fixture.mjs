/**
 * A stand-in for `browse mcp` over stdio: browse's execute surface (`execute`, `status`, `tabs`) with fixed answers and
 * no browser. When the first argument names a folder, each start, initialize and call is appended to its `events.ndjson`.
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const [root] = process.argv.slice(2)
const record = (event, values = {}) => root !== undefined && appendFileSync(join(root, 'events.ndjson'), JSON.stringify({ event, pid: process.pid, ...values }) + '\n')
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
const text = value => ({ content: [{ type: 'text', text: value }] })
record('start')
const lines = createInterface({ input: process.stdin })
lines.once('close', () => process.exit(0))
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined || request.method === undefined) return
  switch (request.method) {
    case 'server/discover':
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Legacy browse fixture' } }) + '\n')
      break
    case 'initialize':
      record('initialize')
      reply(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'browse-fixture', version: '0.1.1' } })
      break
    case 'tools/list':
      reply(request.id, { tools: [
        { name: 'execute', description: 'Run a script against a page in the person\'s browser.', inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false } },
        { name: 'status', description: 'Report the relay and the paired browser.', inputSchema: { type: 'object', properties: {} } },
        { name: 'tabs', description: 'List the tabs the agent opened.', inputSchema: { type: 'object', properties: {} } },
      ] })
      break
    case 'tools/call':
      record('call', { name: request.params.name })
      if (request.params.name === 'execute') reply(request.id, text('Example Domain'))
      else if (request.params.name === 'status') reply(request.id, text('relay 0.1.1, one browser paired'))
      else reply(request.id, text('[]'))
      break
    default:
      reply(request.id, {})
  }
})
