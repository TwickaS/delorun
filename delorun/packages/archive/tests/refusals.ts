/**
 * Helpers that run one call expected to refuse and hand back the refusal, so a
 * spec asserts the exact code and message without repeating the try/catch.
 */
import { ArchiveError } from '../src/index.ts'

/**
 * Run one synchronous call that must refuse.
 * @param run - the call.
 * @returns the refusal.
 */
export function refusal(run: () => unknown): ArchiveError {
  try {
    run()
  } catch (error: unknown) {
    if (error instanceof ArchiveError) return error
    throw error
  }
  throw new Error('the call was expected to refuse, and it returned')
}

/**
 * Run one asynchronous call that must refuse.
 * @param run - the call.
 * @returns the refusal.
 */
export async function refusalAsync(run: () => Promise<unknown>): Promise<ArchiveError> {
  try {
    await run()
  } catch (error: unknown) {
    if (error instanceof ArchiveError) return error
    throw error
  }
  throw new Error('the call was expected to refuse, and it returned')
}
