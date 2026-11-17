/**
 * A minimal ICO writer: PNG images in one `.ico` container, which every current browser reads for `/favicon.ico`.
 * @module @delorun/brand/ico
 */

/** One square PNG image of an ICO file. */
export interface IcoImage {
  /** The edge in pixels, 1 to 256. */
  readonly size: number
  /** The PNG-encoded image. */
  readonly png: Uint8Array
}

/**
 * Pack square PNG images into one ICO file, in the order given.
 * @param images - at least one image, each with an edge of 1 to 256 pixels.
 * @returns the ICO file's bytes.
 * @throws RangeError when no image is given or an edge is outside 1 to 256.
 */
export function buildIco(images: readonly IcoImage[]): Uint8Array {
  if (images.length === 0) throw new RangeError('An ICO file needs at least one image')
  const headerLength = 6 + 16 * images.length
  const out = new Uint8Array(headerLength + images.reduce((sum, image) => sum + image.png.length, 0))
  const view = new DataView(out.buffer)
  view.setUint16(2, 1, true) // type: icon
  view.setUint16(4, images.length, true)
  let offset = headerLength
  images.forEach(({ size, png }, index) => {
    if (!Number.isInteger(size) || size < 1 || size > 256) throw new RangeError(`An ICO image edge is 1 to 256 pixels, not ${String(size)}`)
    const entry = 6 + 16 * index
    out[entry] = size === 256 ? 0 : size // width; 0 stands for 256
    out[entry + 1] = size === 256 ? 0 : size
    view.setUint16(entry + 4, 1, true) // colour planes
    view.setUint16(entry + 6, 32, true) // bits per pixel
    view.setUint32(entry + 8, png.length, true)
    view.setUint32(entry + 12, offset, true)
    out.set(png, offset)
    offset += png.length
  })
  return out
}
