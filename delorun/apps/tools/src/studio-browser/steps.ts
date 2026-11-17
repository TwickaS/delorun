/**
 * The JSON step script of `studio-browser run --steps`: a short list of page actions for the Playwright adapter, so a
 * click-through needs no hand-written JavaScript. {@link parseSteps} validates the document before any browser starts.
 *
 * @module @delorun/tools/studio-browser/steps
 */
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { z } from 'zod'

const selector = z.string().min(1)

/** One action. A step is an object with exactly one of these keys. */
const stepSchema = z.union([
  z.strictObject({ goto: z.string().min(1) }),
  z.strictObject({ click: selector }),
  z.strictObject({ type: z.strictObject({ selector, text: z.string() }) }),
  z.strictObject({ press: z.string().min(1) }),
  z.strictObject({ waitFor: selector }),
  z.strictObject({ waitMs: z.number().int().min(0).max(60_000) }),
  z.strictObject({ screenshot: z.string().min(1) }),
])

/** One validated step; `goto` is a path or an address on the studio's own origin and `screenshot` an absolute PNG path. */
export type Step = z.infer<typeof stepSchema>

/**
 * Parse and validate a step script.
 * @param text - the JSON text of an array of steps.
 * @param cwd - the directory a relative `screenshot` path resolves against.
 * @returns the steps, each `screenshot` path made absolute.
 * @throws Error naming the first problem when the text is not a JSON array of valid steps or a screenshot path does not end in `.png`.
 */
export function parseSteps(text: string, cwd: string): readonly Step[] {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    throw new Error(`--steps is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = z.array(stepSchema).safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`--steps is not a list of steps (click, type, press, waitFor, waitMs, goto, screenshot): ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim())
  }
  return parsed.data.map(step => {
    if (!('screenshot' in step)) return step
    if (!step.screenshot.endsWith('.png')) throw new Error('a screenshot step must name a .png file')
    return { screenshot: isAbsolute(step.screenshot) ? step.screenshot : resolvePath(cwd, step.screenshot) }
  })
}
