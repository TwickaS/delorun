/**
 * Splits a part's raw text into reading words, each with the letter the eye
 * fixes on and how long it holds the band. Text split by spaces reads by
 * those; a run of Chinese or Japanese, which has none, reads by the browser's
 * word segmentation, with punctuation kept on the word before it. The model
 * writes Markdown, so each word is shown without its markup: emphasis marks,
 * code backticks, link syntax, and at a line's start heading hashes, list
 * bullets, quote marks and code fences. Every word is judged alone, from its
 * own characters and whether it opens a line, so a word's text never depends
 * on text that streams in after it.
 */

/** One word of a part's text, by its offsets into that text. */
export interface WordSpan {
  /** Offset of the word's first character. */
  readonly start: number
  /** Offset after the word's last character. */
  readonly end: number
  /** Index, within the word, of the letter the eye fixes on. */
  readonly pivot: number
  /** How long the word holds the band, as a multiple of one word's interval. */
  readonly dwell: number
  /** The word as shown, without its Markdown markup; never empty. */
  readonly text: string
}

// Markup that stands alone as a word at a line's start: heading hashes, a bullet, a rule.
const LINE_MARK = /^(?:#{1,6}|[-*+•]|([-*_=])\1{2,})$/u
// A code fence opens with three or more backticks or tildes, and may carry the language right after them.
const FENCE = /^(?:`{3,}|~{3,})/
const EDGE_OPEN = /^([^\p{L}\p{N}*_~]*)[*_~]+/u
const EDGE_CLOSE = /[*_~]+([^\p{L}\p{N}*_~]*)$/u

/**
 * Remove a word's Markdown markup, keeping the text it marks up.
 * @param word - a run between whitespace, as written.
 * @param lineStart - whether the word is the first on its line.
 * @returns the word as shown, or undefined when it is markup alone.
 */
export function plainWord(word: string, lineStart: boolean): string | undefined {
  let text = word
  if (lineStart) {
    if (FENCE.test(text) || LINE_MARK.test(text)) return undefined
    text = text.replace(/^>+/, '')
  }
  text = text
    .replace(/\]\([^)]*\)/g, '')
    .replace(/^!?\[+/, '')
    .replace(/\]+(?=[^\p{L}\p{N}]*$)/u, '')
    .replaceAll('`', '')
    .replace(EDGE_OPEN, '$1')
    .replace(EDGE_CLOSE, '$1')
  return text === '' ? undefined : text
}

/**
 * Remove the Markdown markup from a text, keeping its whitespace and the words it marks up.
 * @param text - raw text, such as the rest of a part.
 * @param lineStart - whether the text begins at the start of a line.
 * @returns the text as shown.
 */
export function plainText(text: string, lineStart: boolean): string {
  return text.replace(/\S+/g, (word, offset: number) => plainWord(word, opensLine(text, offset, lineStart)) ?? '')
}

// Sentence and clause marks, before any closing quotes and brackets.
const SENTENCE_END = /[.!?…。！？][\p{Pe}\p{Pf}"']*$/u
const CLAUSE_END = /[,;:—–，；：、][\p{Pe}\p{Pf}"']*$/u

// Leading characters that are not letters or digits, such as an opening quote or bracket.
const LEADING = /^[^\p{L}\p{N}]*/u

/**
 * The letter a reader's eye fixes on: a little left of the middle, counted
 * from the word's first letter or digit.
 * @param word - the word as it appears in the text.
 * @returns its index within the word.
 */
export function pivotOf(word: string): number {
  const lead = LEADING.exec(word)?.[0].length ?? 0
  const letters = word.length - lead
  const offset = letters <= 1 ? 0 : letters <= 5 ? 1 : letters <= 9 ? 2 : letters <= 13 ? 3 : 4
  return Math.min(lead + offset, word.length - 1)
}

/**
 * How long a word holds the band: longer at the end of a sentence or clause,
 * and for a long word.
 * @param word - the word as it appears in the text.
 * @returns the multiple of one word's interval, at least 1.
 */
export function dwellOf(word: string): number {
  const tail = SENTENCE_END.test(word) ? 2 : CLAUSE_END.test(word) ? 1.5 : 1
  return Math.max(tail, word.length > 10 ? 1.3 : 1)
}

/**
 * Read the complete words of a text from an offset on. A word that ends the
 * text is complete only when the text is final, since a streaming text may
 * still extend it.
 * @param text - the part's text so far.
 * @param from - the offset after the last complete word read before.
 * @param final - whether the text will not grow.
 * @returns the new words, and the offset to read from next time.
 */
export function scanWords(text: string, from: number, final: boolean): { readonly words: readonly WordSpan[]; readonly next: number } {
  const words: WordSpan[] = []
  let next = from
  // A run between whitespace; a regular expression of the call's own, since it keeps its place in `lastIndex`.
  const word = /\S+/g
  word.lastIndex = from
  for (let match = word.exec(text); match !== null; match = word.exec(text)) {
    const end = match.index + match[0].length
    const trailing = end === text.length && !final
    if (!UNSPACED.test(match[0])) {
      if (trailing) break
      push(words, match.index, end, text.slice(match.index, end), opensLine(text, match.index))
      next = end
      continue
    }
    const pieces = piecesOf(match[0])
    // The last piece of a run that ends a streaming text may still grow; the ones before it are complete.
    for (const piece of trailing ? pieces.slice(0, -1) : pieces) {
      const start = match.index + piece.start
      const lineStart = piece.start === 0 && opensLine(text, match.index)
      push(words, start, match.index + piece.end, text.slice(start, match.index + piece.end), lineStart)
      next = match.index + piece.end
    }
    if (trailing) break
  }
  return { words, next }
}

// Scripts written without spaces between words.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' })

// Whether only spaces and tabs lie between a line's start and the offset; `origin` says whether the text itself starts a line.
function opensLine(text: string, at: number, origin = true): boolean {
  const before = /[^\S\n]*$/.exec(text.slice(0, at))?.[0].length ?? 0
  return at - before === 0 ? origin : text[at - before - 1] === '\n'
}

// Adds the word as shown, unless it is markup alone.
function push(words: WordSpan[], start: number, end: number, written: string, lineStart: boolean): void {
  const shown = plainWord(written, lineStart)
  if (shown !== undefined) words.push({ start, end, pivot: pivotOf(shown), dwell: dwellOf(shown), text: shown })
}

// A run's words by segmentation: punctuation joins the word before it, or the word after it at the run's start.
function piecesOf(run: string): readonly { readonly start: number; readonly end: number }[] {
  const pieces: { start: number; end: number }[] = []
  let lead: number | undefined
  for (const segment of SEGMENTER.segment(run)) {
    const end = segment.index + segment.segment.length
    const last = pieces.at(-1)
    if (segment.isWordLike === true) {
      pieces.push({ start: lead ?? segment.index, end })
      lead = undefined
    } else if (last !== undefined) last.end = end
    else lead ??= segment.index
  }
  if (lead !== undefined) pieces.push({ start: lead, end: run.length })
  return pieces
}
