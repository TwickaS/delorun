/**
 * Making a listed image present in the engine (contract C9, "Images"): the supervisor looks the image up by its
 * listed digest, pulls `<repository>@<digest>` when it is absent and pulling is on, and refuses an image whose
 * recorded digests include none the verified manifest lists. It never pulls or runs a tag.
 *
 * @module @delorun/supervisor/images
 */
import { isNotFound, type Engine } from './docker/engine.ts'
import { SupervisorError } from './errors.ts'
import type { ListedImage } from './manifest.ts'

/** Whether the supervisor may pull a listed image that the engine does not hold. */
export type ImagePull = 'registry' | 'none'

interface ImageRecord {
  readonly Id: string
  readonly RepoDigests?: readonly string[] | null
}

async function inspectImage(engine: Engine, reference: string): Promise<ImageRecord | undefined> {
  try {
    return await engine.call('GET', `/images/${encodeURIComponent(reference)}/json`) as ImageRecord
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

/**
 * Make a listed image present and check its digest.
 * @param engine - the engine.
 * @param image - the image the verified manifest lists.
 * @param pull - `registry` to pull an absent image by digest; `none` to use only an image the engine holds.
 * @returns the image's reference, `<repository>@<digest>`, which the container is created from.
 * @throws {SupervisorError} `IMAGE_PULL_FAILED` when the pull fails; `IMAGE_NOT_IN_MANIFEST` when the image is absent
 *   and pulling is off, or the image the engine holds under the reference records none of the listed digests.
 */
export async function ensureListedImage(engine: Engine, image: ListedImage, pull: ImagePull): Promise<string> {
  let record = await inspectImage(engine, image.reference)
  if (record === undefined) {
    if (pull === 'none') throw new SupervisorError('IMAGE_NOT_IN_MANIFEST', `${image.reference} is not in the engine and pulling is off`)
    try {
      await engine.pull(image.repository, image.digest)
    } catch (error) {
      throw new SupervisorError('IMAGE_PULL_FAILED', `${image.reference} could not be pulled: ${(error as Error).message}`)
    }
    record = await inspectImage(engine, image.reference)
    if (record === undefined) throw new SupervisorError('IMAGE_PULL_FAILED', `${image.reference} is not in the engine after its pull`)
  }
  const recorded = record.RepoDigests ?? []
  if (!image.listed.some(digest => recorded.includes(`${image.repository}@${digest}`))) {
    throw new SupervisorError('IMAGE_NOT_IN_MANIFEST', `the image the engine holds for ${image.reference} records none of the listed digests`)
  }
  return image.reference
}
