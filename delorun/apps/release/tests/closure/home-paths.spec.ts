import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPackArchive } from '@delorun/release-formats/packs/archive'
import { builderNeedles, gateBuildOutput, homePathProblems, refuseHomePaths, type BuilderIdentity } from '../../src/closure/home-paths.ts'
import { scratch } from '../support.ts'

const BUILDER: BuilderIdentity = { home: '/home/maker', username: 'maker' }

function plant(directory: string, files: Record<string, string | Buffer>): void {
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(join(directory, path, '..'), { recursive: true })
    writeFileSync(join(directory, path), data)
  }
}

async function archive(entries: Record<string, string>): Promise<Buffer> {
  return (await buildPackArchive('x.tar.gz', Object.entries(entries).map(([path, data]) => ({ path, mode: '0644' as const, data: Buffer.from(data) })), 1_800_000_000)).bytes
}

describe('the gate against the builder\'s own paths', () => {
  it('passes files that name other users, the shared build root and prose', async (test) => {
    const directory = scratch(test)
    plant(directory, {
      'lib/a.js': 'import "/home/someone-else/x.js"\n// /var/tmp/delorun-release-build/source/packages/x\n',
      'notes.txt': 'The maker of this release says hello; /home/maker2x is another folder name\n'.replace('/home/maker2x', '/srv/x'),
      'x.tar.gz': await archive({ 'package.json': '{"name":"x"}', 'lib/b.js': 'export {}\n' }),
    })
    expect(await homePathProblems(directory, BUILDER)).toEqual([])
    await expect(refuseHomePaths(directory, BUILDER)).resolves.toBeUndefined()
  })

  it.for([
    ['the home directory in JavaScript', 'lib/a.js', 'import "/home/maker/src/x.js"\n', "the building user's home directory /home/maker"],
    ['the home directory in a source map', 'lib/a.js.map', '{"sources":["file:///home/maker/x.ts"]}', "the building user's home directory"],
    ['the home directory in YAML', 'cfg/a.yaml', 'dir: /home/maker/.cache\n', "the building user's home directory"],
    ['the home directory in a binary', 'bin/tool', Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from('/home/maker/build\0')]), "the building user's home directory"],
    ['the user name as a folder with slashes', 'a.json', '{"p":"/mnt/c/maker/x"}', 'the user name as a folder (/maker/)'],
    ['the user name as a folder with backslashes', 'a.txt', 'C:\\Users\\maker\\x', 'the user name as a folder (\\maker\\)'],
    ['the unique build root', 'lib/b.js', 'const root = "/var/tmp/delorun-release-build-k3j2/source"\n', "the build's temporary root delorun-release-build-*"],
  ] as const)('refuses $0, naming the file', async ([, path, data, found], test) => {
    const directory = scratch(test)
    plant(directory, { [path]: data, 'clean.txt': 'nothing here\n' })
    expect(await homePathProblems(directory, BUILDER)).toEqual([{ file: path, found: expect.stringContaining(found) }])
    await expect(refuseHomePaths(directory, BUILDER)).rejects.toThrow(new RegExp(`1 file of the release name the builder's own paths.*\\n${path.replaceAll('.', '\\.')}: `, 'u'))
  })

  it('reads inside an archive and names the archive and the entry', async (test) => {
    const directory = scratch(test)
    plant(directory, { 'sub/pack.tar.gz': await archive({ 'lib/ok.js': 'ok\n', 'node_modules/x/dev.js': '// built in /home/maker/delo/packages/x\n' }), 'delorun.tgz': await archive({ 'package/bin.js': 'delorun-release-build-ab12\n' }) })
    expect(await homePathProblems(directory, BUILDER)).toEqual([
      { file: 'delorun.tgz!package/bin.js', found: expect.stringContaining('temporary root') },
      { file: 'sub/pack.tar.gz!node_modules/x/dev.js', found: expect.stringContaining('home directory') },
    ])
  })

  it('names every offending file in the refusal, up to 100, and counts the rest', async (test) => {
    const directory = scratch(test)
    plant(directory, Object.fromEntries(Array.from({ length: 103 }, (_, index) => [`lib/f${String(index).padStart(3, '0')}.js`, '// /home/maker/x\n'])))
    const error = await refuseHomePaths(directory, BUILDER).then(() => undefined, (failure: unknown) => failure as Error)
    expect(error?.message).toMatch(/^103 files of the release name/u)
    expect(error?.message).toContain('lib/f000.js: ')
    expect(error?.message).toContain('lib/f099.js: ')
    expect(error?.message).not.toContain('lib/f100.js')
    expect(error?.message).toContain('and 3 more')
  })

  it('reports an archive it cannot read instead of passing it', async (test) => {
    const directory = scratch(test)
    plant(directory, { 'broken.tar.gz': 'this is not a gzip stream' })
    expect(await homePathProblems(directory, BUILDER)).toEqual([{ file: 'broken.tar.gz', found: expect.stringContaining('could not be read') }])
  })

  it('refuses a build from source and only reports a build from existing artifacts', async (test) => {
    const directory = scratch(test)
    plant(directory, { 'lib/a.js': 'import "/home/maker/src/x.js"\n' })
    await expect(gateBuildOutput(directory, 'build', () => { throw new Error('a build from source does not warn') }, BUILDER)).rejects.toThrow(/lib\/a\.js: the building user's home directory/u)
    const lines: string[] = []
    await gateBuildOutput(directory, 'existing', line => lines.push(line), BUILDER)
    expect(lines).toEqual(["lib/a.js: the building user's home directory /home/maker; the user name as a folder (/maker/); this build is for a local release only"])
  })

  it('leaves out a home directory that is only a separator, and refuses a user name that is not a path segment', () => {
    expect(builderNeedles({ home: '/', username: 'root' }).map(needle => needle.bytes.toString())).toEqual(['delorun-release-build-', '/root/', '\\root\\'])
    expect(() => builderNeedles({ home: '/home/x', username: '' })).toThrow(/not usable as a path segment/u)
    expect(() => builderNeedles({ home: '/home/x', username: 'a/b' })).toThrow(/not usable as a path segment/u)
  })
})
