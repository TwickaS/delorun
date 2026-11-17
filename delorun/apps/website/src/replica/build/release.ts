/**
 * Which sessions a production build of the site may carry: only real recordings made on the release the site markets.
 * A hand-made stand-in, or a recording from another release, shows what Delorun did not do or no longer does, so a
 * production build refuses it unless the build says it is a preview.
 * @module @delorun/website/replica/build/release
 */
import type { ReplicaFixture } from '../model.ts'

/** What a build accepts. */
export interface SessionPolicy {
  /** The release the site markets, such as `0.1.0`. */
  readonly release: string
  /** Accept stand-ins and other releases, for a preview build that is never published as the site. */
  readonly preview: boolean
}

/**
 * The reasons a build refuses its sessions.
 * @param fixtures - every session the build carries.
 * @param policy - what the build accepts.
 * @returns one sentence per refused session; empty when the build may carry them all.
 */
export function sessionRefusals(fixtures: readonly Pick<ReplicaFixture, 'id' | 'standIn' | 'release'>[], policy: SessionPolicy): string[] {
  if (policy.preview) return []
  return fixtures.flatMap((fixture) => {
    if (fixture.standIn) return [`${fixture.id} is a hand-made stand-in, not a recording.`]
    if (fixture.release !== policy.release) return [`${fixture.id} was recorded on ${fixture.release}, and the site markets ${policy.release}.`]
    return []
  })
}
