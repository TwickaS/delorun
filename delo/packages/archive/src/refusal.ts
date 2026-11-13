/**
 * How an {@link ArchiveError} reads in `@delo/home`'s refusal format: Delo refused the archive, with contract C8's code
 * and the refused entry. A refusal writes nothing, so the person's chats and workspaces stay as they were. A
 * {@link DshImportError} of the stock-home import reads the same way, with its own code.
 *
 * @module @delo/archive/refusal
 */
import { codedReason, refusalDescriber, type RefusalDescriber } from '@delo/home'
import { DshImportError } from './dsh-import/errors.ts'
import { ArchiveError } from './errors.ts'

/** How an {@link ArchiveError} reads: Delo refused the archive and wrote nothing, with C8's code and the refused entry. */
export const archiveDescriber: RefusalDescriber<ArchiveError> = refusalDescriber(ArchiveError, error => ({
  lead: 'Delorun refused the archive and changed nothing.',
  reason: codedReason(error.code, error.message),
  remedies: [],
}))

/**
 * How a {@link DshImportError} reads: Delo refused the stock-home import, or a start that found an interrupted import it
 * could not withdraw, with the import's code and detail.
 */
export const dshImportDescriber: RefusalDescriber<DshImportError> = refusalDescriber(DshImportError, error => ({
  lead: 'Delorun stopped at the stock DeepSeek Harness home import.',
  reason: codedReason(error.code, error.message),
  remedies: [],
}))
