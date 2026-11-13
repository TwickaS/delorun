/**
 * The channel's bucket naming, shared by the stack and the commands so a stage cannot name another stage's bucket.
 *
 * @module @delo/release-channel/bucket
 */

const STAGE = /^[a-z][a-z0-9-]{0,30}$/u

/**
 * The bucket of a stage: `delo-releases-<stage>`. Stages never share a bucket.
 * @param stage - the stage name: lower-case letters, digits and hyphens, starting with a letter.
 * @returns the bucket name.
 * @throws Error when the stage name is not of that form.
 */
export function releaseBucket(stage: string): string {
  if (!STAGE.test(stage)) throw new Error(`stage "${stage}" is not lower-case letters, digits and hyphens starting with a letter`)
  return `delo-releases-${stage}`
}
