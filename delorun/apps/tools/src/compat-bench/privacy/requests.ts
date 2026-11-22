/**
 * The mock model's "request changed" signal: compare the model request a run's Delorun sent with the one a no-plugin
 * baseline run sent for the same test chat. The runner writes every request body the mock model received to
 * `<outDir>/logs/mock-requests.jsonl`, one JSON object per line. A difference (a tool added, the system prompt longer, a
 * message rewritten, more requests) means the plugin changes what the model is sent.
 *
 * @module @delorun/tools/compat-bench/privacy/requests
 */
import { createHash } from 'node:crypto'

/** What of a model request the comparison keeps. */
export type RequestSignature = Readonly<{
  model: string
  system: string
  tools: ReadonlyArray<string>
  messages: ReadonlyArray<Readonly<{ role: string; text: string }>>
  /** How many requests the run made in all. */
  count: number
}>

/**
 * @param value - a message's `content`, a string or a list of blocks.
 * @returns its text.
 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((block: unknown) => {
    if (typeof block === 'string') return block
    if (typeof block === 'object' && block !== null && 'text' in block && typeof block.text === 'string') return block.text
    if (typeof block === 'object' && block !== null && 'type' in block && typeof block.type === 'string') return `[${block.type}]`
    return ''
  }).join('\n')
}

/**
 * Make text comparable between runs: the chat's marker word, numbers and long identifiers differ per run.
 * @param text - text of a request.
 * @param chatWord - this run's marker word.
 * @returns the text with those parts replaced.
 */
export function normaliseText(text: string, chatWord: string): string {
  return text.split(chatWord).join('<chat>').replace(/[0-9a-f]{8,}/gi, '<id>').replace(/\d+/g, '#').replace(/(?:\/[\w.@-]+){2,}/g, '<path>')
}

/**
 * Read the signature of a run's requests from the mock's log: the first request, and the count.
 * @param jsonl - the log's text.
 * @param chatWord - the run's marker word.
 * @returns the signature, or undefined when the log holds no request.
 */
export function signatureOf(jsonl: string, chatWord: string): RequestSignature | undefined {
  const bodies: Record<string, unknown>[] = []
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (typeof value === 'object' && value !== null) bodies.push(value as Record<string, unknown>)
    } catch { /* a torn line */ }
  }
  const first = bodies[0]
  if (first === undefined) return undefined
  const messages = Array.isArray(first.messages) ? first.messages : []
  const tools = Array.isArray(first.tools) ? first.tools : []
  return {
    model: typeof first.model === 'string' ? first.model : '',
    system: normaliseText(textOf(first.system), chatWord),
    tools: tools.map((tool: unknown) => typeof tool === 'object' && tool !== null && 'name' in tool && typeof tool.name === 'string' ? tool.name : '?').sort(),
    messages: messages.map((message: unknown) => {
      const role = typeof message === 'object' && message !== null && 'role' in message && typeof message.role === 'string' ? message.role : '?'
      const content = typeof message === 'object' && message !== null && 'content' in message ? message.content : ''
      return { role, text: normaliseText(textOf(content), chatWord) }
    }),
    count: bodies.length,
  }
}

/**
 * @param text - text.
 * @returns a short hash, for evidence that must not print the text.
 */
function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8)
}

/**
 * Say how an inserted part of a text differs from the baseline: the common start and end are trimmed.
 * @param baseline - the baseline's text.
 * @param run - the run's text.
 * @returns the change in plain words, with a short excerpt of what was added.
 */
function describeTextChange(baseline: string, run: string): string {
  let start = 0
  while (start < baseline.length && start < run.length && baseline[start] === run[start]) start++
  let end = 0
  while (end < baseline.length - start && end < run.length - start && baseline[baseline.length - 1 - end] === run[run.length - 1 - end]) end++
  const added = run.slice(start, run.length - end)
  const removed = baseline.length - start - end
  const parts: string[] = []
  if (added.length > 0) parts.push(`added ${added.length} characters ("${added.replace(/\s+/g, ' ').slice(0, 80)}${added.length > 80 ? '…' : ''}")`)
  if (removed > 0) parts.push(`removed ${removed} characters`)
  return parts.join(' and ')
}

/**
 * Compare a run's request with the baseline's.
 * @param run - the run's signature.
 * @param baseline - the baseline's signature.
 * @returns what differs, in plain words; empty when nothing does.
 */
export function compareRequests(run: RequestSignature, baseline: RequestSignature): ReadonlyArray<string> {
  const changes: string[] = []
  if (run.model !== baseline.model) changes.push(`the model name changed from ${baseline.model} to ${run.model}`)
  if (run.system !== baseline.system) changes.push(`the system prompt ${describeTextChange(baseline.system, run.system)}`)
  const added = run.tools.filter(tool => !baseline.tools.includes(tool))
  const removed = baseline.tools.filter(tool => !run.tools.includes(tool))
  if (added.length > 0) changes.push(`${added.length === 1 ? 'a tool was' : `${added.length} tools were`} added (${added.slice(0, 5).join(', ')}${added.length > 5 ? ', …' : ''})`)
  if (removed.length > 0) changes.push(`${removed.length === 1 ? 'a tool was' : `${removed.length} tools were`} removed (${removed.slice(0, 5).join(', ')}${removed.length > 5 ? ', …' : ''})`)
  if (run.messages.length !== baseline.messages.length) changes.push(`the request carried ${run.messages.length} messages instead of ${baseline.messages.length}`)
  run.messages.forEach((message, index) => {
    const other = baseline.messages[index]
    if (other !== undefined && (other.text !== message.text || other.role !== message.role)) changes.push(`message ${index + 1} (${message.role}) differs: ${describeTextChange(other.text, message.text) || `different text (${shortHash(other.text)} → ${shortHash(message.text)})`}`)
  })
  if (run.count > baseline.count) changes.push(`${run.count - baseline.count} more model ${run.count - baseline.count === 1 ? 'request was' : 'requests were'} made`)
  return changes
}
