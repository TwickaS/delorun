// The bench's mock model: the repository's llm-mock-server on loopback, plus a log of each request body (never the
// headers, so no key reaches the log) for the privacy observer's comparison. Runs inside a bench container.
import { appendFileSync, mkdirSync } from 'node:fs'
import { startMockLlmServer } from '/opt/bench/mock/index.ts'

const port = Number(process.argv[2] ?? 18591)
const apiKey = process.env.DEEPSEEK_API_KEY
mkdirSync('/out/logs', { recursive: true })
const server = await startMockLlmServer({
  port, sequence: ['success'], repeatLast: true, successText: 'Bench mock reply: hello from the mock model.',
  ...(apiKey === undefined || apiKey === '' ? {} : { apiKey }),
})
let logged = 0
setInterval(() => {
  for (; logged < server.requests.length; logged++) appendFileSync('/out/logs/mock-requests.jsonl', `${JSON.stringify(server.requests[logged].body)}\n`)
}, 250)
process.stdout.write(`${JSON.stringify({ type: 'ready', port })}\n`)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void server.close().finally(() => process.exit(0)) })
