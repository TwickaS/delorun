/** How the flow writes file sizes. */
import { describe, expect, it } from 'vitest'
import { formatSize } from '../src/client/paths.ts'

describe('a file size', () => {
  it.each([
    [0, '0 B'], [812, '812 B'], [1023, '1023 B'], [1024, '1 KB'], [1536, '1.5 KB'], [4300, '4.2 KB'], [10_240, '10 KB'],
    [2_300_000, '2.2 MB'], [5 * 1024 ** 3, '5 GB'], [3 * 1024 ** 4, '3 TB'], [5000 * 1024 ** 4, '5000 TB'],
  ])('reads %i bytes as %s', (bytes, text) => {
    expect(formatSize(bytes)).toBe(text)
  })
})
