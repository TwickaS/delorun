/**
 * The terminal questions `delorun trash`, `delorun export` and `delorun import`
 * ask before they change or write anything. Without a terminal on both
 * standard input and standard output no question can be asked, so the answer
 * is the empty string, which every caller treats as no.
 *
 * @module @delo/cli/trash/terminal
 */
import { createInterface } from 'node:readline/promises'

/**
 * Ask one question on the terminal.
 * @param question - the question, with its own prompt suffix.
 * @returns the trimmed answer, or the empty string when no terminal can ask.
 */
export async function askOnTerminal(question: string): Promise<string> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return ''
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await prompt.question(question)).trim()
  } finally {
    prompt.close()
  }
}

/**
 * Whether one answer is yes.
 * @param answer - the answer.
 * @returns true for `y` or `yes`, in any case.
 */
export function isYes(answer: string): boolean {
  return /^y(es)?$/i.test(answer)
}
