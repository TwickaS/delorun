import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { manualSource } from '../src/manual-source.ts'

describe('a manual release source', () => {
  let directory: string
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'delo-manual-source-')) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  it('serves the folder\'s files, with root files from root/ or the top level', async () => {
    await writeFile(join(directory, 'timestamp.json'), 'stamp')
    await mkdir(join(directory, 'root'))
    await writeFile(join(directory, 'root', '2.root.json'), 'root two')
    await writeFile(join(directory, '3.root.json'), 'root three')
    const { source, downloader } = manualSource(directory)
    expect((await downloader.bytes(`${source.metadata}/timestamp.json`, 100)).bytes.toString()).toBe('stamp')
    expect((await downloader.bytes(`${source.metadata}/root/2.root.json`, 100)).bytes.toString()).toBe('root two')
    expect((await downloader.bytes(`${source.metadata}/root/3.root.json`, 100)).bytes.toString()).toBe('root three')
  })

  it('names a file the folder lacks', async () => {
    const { source, downloader } = manualSource(directory)
    await expect(downloader.bytes(source.files('0.2.0' as never, 'delorun-0.2.0.manifest.json'), 100)).rejects.toThrow(/delorun-0\.2\.0\.manifest\.json.*404|404/su)
  })

  it('refuses an address that is not https, and a request for any host but the one named', async () => {
    expect(() => manualSource('http://example.com/release')).toThrow(/https:/u)
    expect(() => manualSource('ftp://example.com/release')).toThrow(/https:/u)
    const { downloader } = manualSource('https://mirror.example/release/')
    await expect(downloader.bytes('https://other.example/timestamp.json', 100)).rejects.toMatchObject({ code: 'DOWNLOAD_REFUSED' })
    await expect(downloader.bytes('http://mirror.example/timestamp.json', 100)).rejects.toMatchObject({ code: 'DOWNLOAD_REFUSED' })
  })

  it('never reads outside the folder', async () => {
    const { source, downloader } = manualSource(directory)
    await expect(downloader.bytes(`${source.metadata}/..%2f..%2fetc%2fpasswd`, 100)).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' })
  })
})
