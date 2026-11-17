/** Private stdio browser fixture; each process owns independent state. */
import { appendFileSync, existsSync, watch } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const [root, mode] = process.argv.slice(2)
const record = (event, values = {}) => appendFileSync(join(root, 'events.ndjson'), JSON.stringify({ event, pid: process.pid, ...values }) + '\n')
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
let counter = 0
let rootsAdvertised = false
record('start', { cwd: process.cwd() })
process.once('exit', () => record('exit'))
const lines = createInterface({ input: process.stdin })
lines.once('close', () => process.exit(0))
lines.on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  if (request.method === undefined) {
    if (request.id === 'roots') record('roots', { roots: request.result?.roots ?? null, error: request.error?.message ?? null })
    return
  }
  switch (request.method) {
    case 'server/discover':
      record('probe')
      if (mode === 'fail') process.exit(1)
      if (mode === 'hold') return
      {
        const respond = () => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Legacy browser fixture' } }) + '\n')
        if (mode === 'gate' && !existsSync(join(root, 'release'))) {
          const watcher = watch(root, () => {
            if (!existsSync(join(root, 'release'))) return
            watcher.close()
            respond()
          })
          if (existsSync(join(root, 'release'))) { watcher.close(); respond() }
        } else respond()
      }
      break
    case 'initialize':
      rootsAdvertised = request.params.capabilities?.roots !== undefined
      record('initialize', { rootsAdvertised })
      if (mode === 'fail') process.exit(1)
      if (mode === 'hold') return
      reply(request.id, {
        protocolVersion: request.params.protocolVersion, capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'browser-fixture', version: '1' }, instructions: 'BROWSER_FIXTURE_INSTRUCTION: use this Session browser.',
      })
      break
    case 'tools/list':
      if (rootsAdvertised) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'roots', method: 'roots/list' }) + '\n')
      reply(request.id, { tools: [
        { name: 'visit', description: 'Visit the fixture page.', inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false } },
        { name: 'disconnect', description: 'Disconnect the fixture.', inputSchema: { type: 'object', properties: {} } },
      ] })
      break
    case 'tools/call':
      record('call', { name: request.params.name, cwd: process.cwd() })
      if (request.params.name === 'disconnect') process.exit(0)
      counter += 1
      if (request.params.arguments.label === 'missing-browser') {
        reply(request.id, { isError: true, content: [{ type: 'text', text: '### Error\nError: Browser "chromium" is not installed; expected executable at /cache/chromium-1/chrome. Run `npx @playwright/mcp install-browser chromium` to install' }] })
        break
      }
      reply(request.id, { content: [{ type: 'text', text: `Visit ${counter}: ${request.params.arguments.label}` }], structuredContent: { counter, pid: process.pid } })
      break
    case 'resources/list':
      record('resource', { name: request.method })
      reply(request.id, { resources: [{ uri: 'browser-fixture://state', name: 'Browser state' }] })
      break
    case 'resources/templates/list':
      record('resource', { name: request.method })
      reply(request.id, { resourceTemplates: [] })
      break
    case 'resources/read':
      record('resource', { name: request.method })
      reply(request.id, { contents: [{ uri: request.params.uri, text: JSON.stringify({ counter, pid: process.pid }) }] })
      break
    default:
      throw new Error(`Unexpected method ${request.method}`)
  }
})
