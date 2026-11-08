import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SemanticVersion } from '@delo/contract-release-manifest'
import { CliError, EXIT } from '../src/exit.ts'
import type { CommandContext } from '../src/command.ts'
import {
  applyDeloVersionEnvironment, DeloVersionError, deloVersion, dshVersion, versionCommand, versionJson, versionLines, versions,
} from '../src/version.ts'
import { main } from '../src/main.ts'

/** A context that records what a command printed, for the assertions below. */
function recorder(): CommandContext & { readonly stdoutText: string, readonly stderrText: string } {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    env: { ...process.env },
    stdout: text => void stdout.push(text),
    stderr: text => void stderr.push(text),
    get stdoutText() { return stdout.join('') },
    get stderrText() { return stderr.join('') },
  }
}

/** A semantic version standing for a fixed one, as the contract's brand requires. */
function at(version: string): SemanticVersion {
  return brandString<SemanticVersion>(version)
}

let scratch: string | undefined

afterEach(() => {
  vi.unstubAllEnvs()
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})

describe('the versions Delo reports', () => {
  it('reads Delo\'s version from the CLI package manifest', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(deloVersion()).toBe(manifest.version)
  })

  it('reads DSH\'s version the way upstream does', () => {
    expect(dshVersion()).toBe(getDshRuntimeVersion())
  })

  it('reports both', () => {
    expect(versions()).toEqual({ delo: deloVersion(), dsh: dshVersion() })
  })

  it('refuses a malformed version string instead of reporting it', () => {
    scratch = mkdtempSync(join(tmpdir(), 'delo-version-'))
    const filename = join(scratch, 'package.json')
    writeFileSync(filename, `${JSON.stringify({ name: '@delo/cli', version: 'not-a-version' })}\n`)
    expect(() => deloVersion(filename)).toThrow(/is "not-a-version", which is not a semantic version such as 1\.0\.0/)
    expect(() => deloVersion(filename)).toThrow(DeloVersionError)
  })

  it('refuses a manifest without a version', () => {
    scratch = mkdtempSync(join(tmpdir(), 'delo-version-'))
    const filename = join(scratch, 'package.json')
    writeFileSync(filename, `${JSON.stringify({ name: '@delo/cli' })}\n`)
    expect(() => deloVersion(filename)).toThrow(/is undefined, which is not a semantic version/)
  })

  it('refuses a manifest it cannot read', () => {
    expect(() => deloVersion(join(tmpdir(), 'delo-version-missing', 'package.json'))).toThrow(/cannot be read from/)
  })
})

describe('the version output', () => {
  it('prints the two lines, Delo first', () => {
    expect(versionLines({ delo: at('1.0.0'), dsh: at('0.2.2') })).toBe('Delo 1.0.0\nDSH 0.2.2\n')
  })

  it('prints one JSON line with --json', () => {
    expect(versionJson({ delo: at('1.0.0'), dsh: at('0.2.2') })).toBe('{"delo":"1.0.0","dsh":"0.2.2"}\n')
  })

  it('prints both versions through delorun --version, before a home is resolved', async () => {
    const context = recorder()
    expect(await main(['--version'], context)).toBe(EXIT.ok)
    expect(context.stdoutText).toBe(`Delo ${deloVersion()}\nDSH ${dshVersion()}\n`)
    expect(context.stderrText).toBe('')
  })

  it('prints one line through delorun --version --json', async () => {
    const context = recorder()
    expect(await main(['--version', '--json'], context)).toBe(EXIT.ok)
    expect(context.stdoutText).toBe(`${JSON.stringify({ delo: deloVersion(), dsh: dshVersion() })}\n`)
  })

  it('reports a wrong option as a usage error', () => {
    expect(() => versionCommand(['--jsn'], recorder(), { delo: at('1.0.0'), dsh: at('0.2.2') })).toThrow(CliError)
  })
})

describe('the exported Delo version', () => {
  it('exports Delo\'s version for the plugin check', () => {
    const env: Record<string, string | undefined> = {}
    applyDeloVersionEnvironment(env)
    expect(env.DELO_VERSION).toBe(deloVersion())
  })
})
