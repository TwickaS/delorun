/**
 * Another chat's conversation as the text `chat_read` answers: one line per
 * message the person or the agent wrote, per tool call and per notice, cut
 * to a byte budget from the oldest end.
 *
 * @module @delorun/plugin-main-chat/chat-text
 */
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SurfaceEvent } from '@deepseek-ai/dsh-session'

const encoder = new TextEncoder()

const bytesOf = (value: string): number => encoder.encode(value).length

function textOf(message: UserMessage): string {
  return message.content.map((block) => {
    switch (block.type) {
      case 'text': return block.text
      case 'image': return '[image]'
      case 'file': return `[file ${block.attachment.name}]`
      default:
        // The other user blocks carry no text the person wrote.
        return ''
    }
  }).join(' ').trim()
}

/**
 * One chat's surface as lines: the person's messages, the agent's replies,
 * one line per tool call and one per notice.
 * @param events - the chat's current surface events.
 * @returns the lines, oldest first.
 */
export function chatLines(events: readonly SurfaceEvent[]): string[] {
  const lines: string[] = []
  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        const { source } = event.data
        if (source.kind === 'user') lines.push(`Person: ${textOf(event.data)}`)
        else if ('form' in source && source.form === 'notice') lines.push(`Notice: ${source.summary}`)
        break
      }
      case 'assistant/message': {
        const { content } = event.data.message
        const text = content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('').trim()
        if (text !== '') lines.push(`Agent: ${text}`)
        for (const block of content) if (block.type === 'tool-call') lines.push(`Agent called ${block.name}`)
        break
      }
      default:
        // System, developer and tool-result messages are the harness's, not the conversation's.
        break
    }
  }
  return lines
}

const leftOut = (count: number): string => `(${String(count)} earlier message${count === 1 ? '' : 's'} left out)`

// The line's start that fits in `bytes`, ending with `...` when cut.
function cut(line: string, bytes: number): string {
  if (bytesOf(line) <= bytes) return line
  let kept = ''
  let used = 0
  for (const char of line) {
    const size = bytesOf(char)
    if (used + size > bytes - 3) break
    kept += char
    used += size
  }
  return `${kept}...`
}

/**
 * The newest lines that fit in a byte budget, after a first line that counts
 * the ones left out. A newest line larger than the budget on its own is cut
 * to fit and ends with `...`.
 * @param lines - the lines, oldest first.
 * @param budget - the largest answer in UTF-8 bytes, newlines included.
 * @returns the kept lines joined by newlines, newest last.
 */
export function newestWithin(lines: readonly string[], budget: number): string {
  const whole = lines.join('\n')
  if (bytesOf(whole) <= budget) return whole
  const kept: string[] = []
  let used = 0
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!
    // Keeping this line leaves the `index` lines before it out; each kept line costs its newline.
    if (used + bytesOf(line) + 1 + bytesOf(leftOut(index)) > budget) break
    kept.unshift(line)
    used += bytesOf(line) + 1
  }
  if (kept.length > 0) return [leftOut(lines.length - kept.length), ...kept].join('\n')
  const earlier = lines.length - 1
  const marker = earlier === 0 ? '' : `${leftOut(earlier)}\n`
  return `${marker}${cut(lines.at(-1) ?? '', budget - bytesOf(marker))}`
}
