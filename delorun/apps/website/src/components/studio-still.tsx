/**
 * The studio picture that stands for the replica until it loads, and with scripts off.
 *
 * @module @delorun/website/studio-still
 */
import { HERO_IMAGE_PATH } from '../site/config.ts'

/** The studio picture's own size, which fixes the hero frame's shape. */
const STUDIO_STILL = { width: 1440, height: 900 } as const

/**
 * The studio picture as a still.
 * @param props.alt - its text alternative; empty where a caption names the frame.
 * @param props.eager - true in the hero, which is on the first screen.
 * @returns the picture.
 */
export function StudioStill({ alt, eager = false }: { alt: string, eager?: boolean }) {
  return <img src={HERO_IMAGE_PATH} alt={alt} width={STUDIO_STILL.width} height={STUDIO_STILL.height} loading={eager ? 'eager' : 'lazy'} decoding="async" />
}
