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

/** `WIN_CERTIFICATE.wRevision` of the attribute certificate table's current format. */
const WIN_CERT_REVISION_2_0 = 0x0200

/** `WIN_CERTIFICATE.wCertificateType` of an Authenticode PKCS #7 SignedData signature. */
const WIN_CERT_TYPE_PKCS_SIGNED_DATA = 0x0002

/**
 * The length of the DER SEQUENCE that starts a range: tag 0x30 and a definite length in its shortest form.
 * @param data - the file's bytes.
 * @param offset - the range's start.
 * @param end - the range's end.
 * @returns the SEQUENCE's length with its header, or `undefined` when the range does not start with one that fits.
 */
function derSequenceLength(data: Buffer, offset: number, end: number): number | undefined {
  if (offset + 2 > end || data[offset] !== 0x30) return undefined
  const first = data[offset + 1]!
  if (first < 0x80) return offset + 2 + first <= end ? 2 + first : undefined
  const count = first & 0x7f
  if (count === 0 || count > 4 || offset + 2 + count > end || data[offset + 2] === 0) return undefined
  let length = 0
  for (let index = 0; index < count; index += 1) length = length * 256 + data[offset + 2 + index]!
  if (length < 0x80 || offset + 2 + count + length > end) return undefined
  return 2 + count + length
}

/**
 * Whether every byte of a range is zero.
 * @param data - the file's bytes.
 * @param from - the range's start.
 * @param to - the range's end.
 * @returns true for an empty or all-zero range.
 */
function isZero(data: Buffer, from: number, to: number): boolean {
  for (let index = from; index < to; index += 1) if (data[index] !== 0) return false
  return true
}

/**
 * Whether a certificate table holds only Authenticode `WIN_CERTIFICATE` entries that fill it exactly: each entry's
 * `dwLength` covers its 8-byte header, its revision is 2.0 and its type PKCS #7 SignedData; its body is one DER
 * SEQUENCE followed by fewer than 8 zero bytes, the alignment padding some signing tools count in `dwLength`; and the
 * entries, each padded with zero bytes to 8 bytes except the last, end where the table ends. Data hidden after the
 * signature, as in CVE-2013-3900, fails the check.
 * @param data - the file's bytes.
 * @param offset - the table's file offset.
 * @param length - the table's length.
 * @returns true for a well-formed table of at least one entry.
 */
function certificateTableIsAuthenticode(data: Buffer, offset: number, length: number): boolean {
  const end = offset + length
  let cursor = offset
  while (cursor < end) {
    if (cursor + 8 > end) return false
    const entryLength = data.readUInt32LE(cursor)
    const entryEnd = cursor + entryLength
    if (entryLength < 8 || entryEnd > end) return false
    if (data.readUInt16LE(cursor + 4) !== WIN_CERT_REVISION_2_0 || data.readUInt16LE(cursor + 6) !== WIN_CERT_TYPE_PKCS_SIGNED_DATA) return false
    const signature = derSequenceLength(data, cursor + 8, entryEnd)
    if (signature === undefined || entryEnd - (cursor + 8 + signature) >= 8 || !isZero(data, cursor + 8 + signature, entryEnd)) return false
    const next = cursor + Math.ceil(entryLength / 8) * 8
    if (!isZero(data, entryEnd, Math.min(next, end))) return false
    cursor = next
  }
  // The last entry may end the table without its padding.
  return cursor > offset && cursor - end < 8
}

/**
 * The bytes of a PE file without its Authenticode signature and checksum.
 * @param data - the file's bytes.
 * @returns the normalised bytes, or `undefined` when the file is not a PE image, or its certificate table is not a
 * table of Authenticode entries that ends the file, which no signing tool produces.
 */
export function stripAuthenticode(data: Buffer): Buffer | undefined {
  const pe = layout(data)
  if (pe === undefined) return undefined
  const signed = pe.certificateLength > 0
  if (signed && (pe.certificateOffset % 8 !== 0 || pe.certificateOffset < pe.securityEntryOffset + 8 || pe.certificateOffset + pe.certificateLength !== data.byteLength
    || !certificateTableIsAuthenticode(data, pe.certificateOffset, pe.certificateLength))) return undefined
  const kept = signed ? pe.certificateOffset : data.byteLength
  const normalised = Buffer.alloc(Math.ceil(kept / 8) * 8)
  data.copy(normalised, 0, 0, kept)
  normalised.fill(0, pe.checksumOffset, pe.checksumOffset + 4)
  normalised.fill(0, pe.securityEntryOffset, pe.securityEntryOffset + 8)
  return normalised
}
