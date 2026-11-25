import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const library = resolve(import.meta.dirname, 'rootless-builder-user.sh')
const bash = ['/bin/bash', '/usr/bin/bash'].find(candidate => existsSync(candidate)) ?? 'bash'

// Answers `docker info` with the security options the fixture names, and records every call, so a spec reads the
// decision the script makes without a Docker engine.
const fakeDocker = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [[ "$1" == info ]]; then
  printf '%s\\n' "\${FAKE_SECURITY_OPTIONS:-[]}"
  exit 0
fi
echo "the fixture answers only docker info" >&2
exit 1
`

interface Fixture {
  readonly root: string
  readonly dockerLog: string
  readonly env: NodeJS.ProcessEnv
}

const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createFixture(securityOptions?: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rootless-builder-user-'))
  fixtureRoots.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'docker'), fakeDocker)
  chmodSync(join(bin, 'docker'), 0o755)
  const dockerLog = join(root, 'docker.log')
  writeFileSync(dockerLog, '')
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin + delimiter + (process.env.PATH ?? ''), FAKE_DOCKER_LOG: dockerLog }
  delete env.FAKE_SECURITY_OPTIONS
  if (securityOptions !== undefined) env.FAKE_SECURITY_OPTIONS = securityOptions
  return { root, dockerLog, env }
}

function builderUser(fixture: Fixture): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(bash, ['-c', 'set -euo pipefail; source "$1"; builder_user', 'builder-user', library], { encoding: 'utf8', env: fixture.env, timeout: 30_000 })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function dockerCalls(fixture: Fixture): string[] {
  return readFileSync(fixture.dockerLog, 'utf8').split('\n').filter(line => line !== '')
}

describe.skipIf(process.platform === 'win32')('builder_user', () => {
  it('runs the container as uid 0 on a rootless engine', () => {
    const fixture = createFixture('["name=apparmor,profile=default","name=rootless"]')

    const result = builderUser(fixture)

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('0:0\n')
    expect(dockerCalls(fixture)).toEqual(['info --format {{json .SecurityOptions}}'])
  })

  it('runs the container as the caller on a rootful engine', () => {
    const fixture = createFixture('["name=apparmor,profile=default","name=seccomp,profile=builtin","name=cgroupns"]')

    const result = builderUser(fixture)

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${String(process.getuid?.())}:${String(process.getgid?.())}\n`)
  })

  it('runs the container as the caller when the engine lists no security options', () => {
    const fixture = createFixture()

    expect(builderUser(fixture).stdout).toBe(`${String(process.getuid?.())}:${String(process.getgid?.())}\n`)
  })
})
