/**
 * Helpers that build a small ZIP container and patch single fields of it, so a
 * spec can produce the malformed containers a reader must refuse. The offsets
 * are the ones of the ZIP specification: the end record, the central-directory
 * records and the local headers.
 */
import { ZipWriter, type ZipEntryInput } from '../src/index.ts'
import { utf8 } from './support.ts'

/** The size of the end-of-central-directory record the writer emits (it writes no comment). */
export const END_RECORD_SIZE = 22

/** The size of a central-directory record before its name. */
export const CENTRAL_RECORD_SIZE = 46

/** The size of a local header before its name. */
export const LOCAL_HEADER_SIZE = 30

/** Where the entries of a written container start and the fields of its records sit. */
export interface ContainerLayout {
  /** The offset of the end record. */
  readonly end: number
  /** The offset of the central directory. */
  readonly directory: number
  /** The offset of each central-directory record, in entry order. */
  readonly central: readonly number[]
  /** The offset of each entry's local header, in entry order. */
  readonly local: readonly number[]
}

/**
 * Write a container of stored entries.
 * @param entries - the entries; by default two stored files, `a.txt` and `b.txt`.
 * @returns the container's bytes.
 */
export function container(entries: readonly ZipEntryInput[] = [
  { name: 'a.txt', bytes: utf8('hello'), method: 'store' },
  { name: 'b.txt', bytes: utf8('world'), method: 'store' },
]): Uint8Array {
  const writer = new ZipWriter()
  for (const entry of entries) writer.add(entry)
  return writer.finish()
}

/**
 * Locate the records of a container the writer produced.
 * @param bytes - the container.
 * @returns the offsets of its end record, central directory, central records and local headers.
 */
export function layoutOf(bytes: Uint8Array): ContainerLayout {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = bytes.length - END_RECORD_SIZE
  const directory = view.getUint32(end + 16, true)
  const count = view.getUint16(end + 10, true)
  const central: number[] = []
  const local: number[] = []
  let cursor = directory
  for (let index = 0; index < count; index++) {
    central.push(cursor)
    local.push(view.getUint32(cursor + 42, true))
    cursor += CENTRAL_RECORD_SIZE + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true)
  }
  return { end, directory, central, local }
}

/** One field write: an offset, a width in bytes and the value. */
export interface FieldPatch {
  readonly at: number
  readonly width: 1 | 2 | 4
  readonly value: number
}

/**
 * Copy a container and overwrite fields of the copy.
 * @param bytes - the container.
 * @param patches - the fields to write, little-endian.
 * @returns the patched copy.
 */
export function patched(bytes: Uint8Array, ...patches: readonly FieldPatch[]): Uint8Array {
  const copy = Uint8Array.from(bytes)
  const view = new DataView(copy.buffer)
  for (const { at, width, value } of patches) {
    if (width === 1) view.setUint8(at, value)
    else if (width === 2) view.setUint16(at, value, true)
    else view.setUint32(at, value, true)
  }
  return copy
}

/**
 * Read one little-endian field of a container.
 * @param bytes - the container.
 * @param at - the field's offset.
 * @param width - the field's width in bytes.
 * @returns the value.
 */
export function field(bytes: Uint8Array, at: number, width: 2 | 4): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return width === 2 ? view.getUint16(at, true) : view.getUint32(at, true)
}
