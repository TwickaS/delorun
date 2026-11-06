/**
 * The PE comparison of contract C2's first rebuild exception: a PE file is compared with its Authenticode signature
 * and header checksum removed, because the release workflow signs every PE file of the Windows closure and a
 * rebuild outside it cannot. Removing the signature truncates the file at the certificate table, zeroes the security
 * data directory entry and the optional header's `CheckSum`, then pads the file with zero bytes to a multiple of
 * 8 bytes, the alignment signing tools pad to before appending the table.
 *
 * @module @delo/release/rebuild/pe
 */

const SECURITY_DIRECTORY = 4

/** Where the fields that signing changes lie in one PE file. */
interface PeLayout {
  readonly checksumOffset: number
  readonly securityEntryOffset: number
  readonly certificateOffset: number
  readonly certificateLength: number
}

function layout(data: Buffer): PeLayout | undefined {
  if (data.byteLength < 0x40 || data[0] !== 0x4d || data[1] !== 0x5a) return undefined
  const header = data.readUInt32LE(0x3c)
  if (header + 24 > data.byteLength || data.readUInt32LE(header) !== 0x00004550) return undefined
  const optionalLength = data.readUInt16LE(header + 20)
  const optional = header + 24
  if (optional + optionalLength > data.byteLength || optionalLength < 2) return undefined
  const magic = data.readUInt16LE(optional)
  const countOffset = magic === 0x10b ? 92 : magic === 0x20b ? 108 : undefined
  if (countOffset === undefined || countOffset + 4 > optionalLength) return undefined
  const directories = optional + countOffset + 4
  const securityEntryOffset = directories + SECURITY_DIRECTORY * 8
  if (data.readUInt32LE(optional + countOffset) <= SECURITY_DIRECTORY || securityEntryOffset + 8 > optional + optionalLength) return undefined
  return {
    checksumOffset: optional + 64,
    securityEntryOffset,
    certificateOffset: data.readUInt32LE(securityEntryOffset),
    certificateLength: data.readUInt32LE(securityEntryOffset + 4),
  }
}

/**
 * Whether bytes are a PE image with the headers this comparison reads.
 * @param data - the file's bytes.
 * @returns true for a PE32 or PE32+ image with a security data directory entry.
 */
export function isPeFile(data: Buffer): boolean {
  return layout(data) !== undefined
}

/**
 * The bytes of a PE file without its Authenticode signature and checksum.
 * @param data - the file's bytes.
 * @returns the normalised bytes, or `undefined` when the file is not a PE image, or its certificate table does not
 * end the file, which no signing tool produces.
 */
export function stripAuthenticode(data: Buffer): Buffer | undefined {
  const pe = layout(data)
  if (pe === undefined) return undefined
  const signed = pe.certificateLength > 0
  if (signed && (pe.certificateOffset < pe.securityEntryOffset + 8 || pe.certificateOffset + pe.certificateLength !== data.byteLength)) return undefined
  const kept = signed ? pe.certificateOffset : data.byteLength
  const normalised = Buffer.alloc(Math.ceil(kept / 8) * 8)
  data.copy(normalised, 0, 0, kept)
  normalised.fill(0, pe.checksumOffset, pe.checksumOffset + 4)
  normalised.fill(0, pe.securityEntryOffset, pe.securityEntryOffset + 8)
  return normalised
}
