/**
 * The read route of the preview flags and its JSON answer. The module imports no Host code, so the studio reads it.
 * @module @delorun/preview-flags/wire
 */
import { z } from 'zod'
import { PREVIEW_FLAG_ID } from './flags.ts'

/** The routes under `/api`. */
export const PREVIEW_FLAG_ROUTES = {
  /** `GET`: every declared flag with its state, as {@link PreviewFlagsAnswer}. */
  list: '/api/delorunPreviewFlags.list',
} as const

const Copy = z.object({ en: z.string(), zh: z.string() })

/** One declared flag and whether the profile turns it on. */
export const PreviewFlagView = z.object({
  id: z.string().regex(PREVIEW_FLAG_ID),
  kind: z.literal('boolean'),
  owner: z.string(),
  title: Copy,
  description: Copy,
  on: z.boolean(),
})

/** One declared flag and whether the profile turns it on. */
export type PreviewFlagView = z.infer<typeof PreviewFlagView>

/** What the read route answers: the flags the running plugins declare. A flag whose plugin is off is absent. */
export const PreviewFlagsAnswer = z.object({ flags: z.array(PreviewFlagView) })

/** What the read route answers. */
export type PreviewFlagsAnswer = z.infer<typeof PreviewFlagsAnswer>
