/**
 * Head-and-tail capping of a program tool's output. The spill policy does not see seat records, so the executor
 * keeps the ends of a large output inline and saves the full text through the spill store.
 * @module @delorun/plugin-agent-seats/executor/output-cap
 */

/** How much of a large output stays inline, in UTF-16 code units. */
export interface OutputCap {
  /** The leading part kept. */
  readonly headChars: number
  /** The trailing part kept. */
  readonly tailChars: number
}

/** The inline share of a record's output: about 12,500 tokens in all, the size at which the spill policy acts on native results. */
export const SEAT_OUTPUT_CAP: OutputCap = { headChars: 25_000, tailChars: 25_000 }

/** A large output cut into its kept ends and the size of what lies between them. */
export interface CutOutput {
  /** The kept start. */
  readonly head: string
  /** The kept end. */
  readonly tail: string
  /** UTF-8 bytes of the omitted middle. */
  readonly omittedBytes: number
}

/**
 * Cut an output that exceeds the cap. A cut never splits a surrogate pair.
 * @param text - the program's full output.
 * @param cap - how much to keep.
 * @returns the cut, or undefined when the whole text fits inline.
 */
export function cutOutput(text: string, cap: OutputCap): CutOutput | undefined {
  if (text.length <= cap.headChars + cap.tailChars) return undefined
  let headEnd = cap.headChars
  if (isHighSurrogate(text.charCodeAt(headEnd - 1))) headEnd--
  let tailStart = text.length - cap.tailChars
  if (isLowSurrogate(text.charCodeAt(tailStart))) tailStart++
  return {
    head: text.slice(0, headEnd),
    tail: text.slice(tailStart),
    omittedBytes: Buffer.byteLength(text.slice(headEnd, tailStart), 'utf8'),
  }
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff
}
