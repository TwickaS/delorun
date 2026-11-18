/** Shared file-delivery guidance for clients that render desktop-style file references. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Stable Loader identity. */
export const name = 'deliverable-file-references'

/** Prompt registry shared by the Web and SDK desktop compositions. */
export const inject = ['systemPrompt']

/** Static Web guidance: four rules for results, deliverables, file links, and link labels. */
const FILE_REFERENCE_PROMPT = 'Show the primary results in your final response with a brief explanation, and show an image inline with ![Description](<path/to/image.png>). '
  + 'Use present only for complete deliverables the person may want to open separately (images, Office documents, spreadsheets, slide decks), not to list edited source files. '
  + 'Link every mention of an existing file, outside commands and code blocks, as [name](<path>) with a path relative to the working directory or absolute; keep the angle brackets. '
  + 'Label a link with the file name, adding parent directories only to tell files apart, never a full path; for known lines add :24 or :24–30 to the label.'

/**
 * Register the desktop file-reference guidance without mounting a GUI.
 * @param ctx - context carrying the prompt registry.
 */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'ui:deliverable-file-references',
    order: ctx.systemPrompt.getSectionOrder('DELIVERABLE_FILE_REFERENCES'),
    text: FILE_REFERENCE_PROMPT,
  })
}
