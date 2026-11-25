import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { docker, dockerAvailable, hardenedRunArgs, inspectContainer, inspectProblems, pickBenchPort, removeRun } from '../../src/compat-bench/docker.ts'

/**
 * The live config denial test: a container with no plugin, started as the runner starts one, read back over
 * `docker inspect` and `/proc`. It runs in the Docker lane (`delorun/vitest.docker.config.ts`). With
 * `DELORUN_DOCKER_SPECS=1` an absent engine fails the spec; without it the spec skips, naming the reason.
 */
const required = process.env.DELORUN_DOCKER_SPECS === '1'
const available = await dockerAvailable()
if (required && !available) throw new Error('no Docker engine answers; start Docker and run the Docker lane again')

describe.skipIf(!available)('config denial: a container with no plugin, read back over docker inspect', () => {
  const runId = `denial-${String(process.pid)}`
  const out = mkdtempSync(join(tmpdir(), 'bench-denial-'))
  const name = `bench-denial-${String(process.pid)}`
  const image = 'node:24.22.0-bookworm-slim'

  afterAll(async () => { await removeRun(runId) })

  it('is hardened as the plan lists, and the kernel agrees', async () => {
    const port = await pickBenchPort()
    const run = await docker(hardenedRunArgs({ name, image, runId, outDir: out, user: `${String(process.getuid?.() ?? 1000)}:${String(process.getgid?.() ?? 1000)}`, publish: { host: port, container: 3080 }, command: ['sleep', '120'] }), { timeoutMs: 600_000 })
    expect(run.code, run.stderr).toBe(0)
    const inspected = await inspectContainer(name)
    expect(inspectProblems(inspected, { outDir: out })).toEqual([])
    // What the settings mean in the running container: no capability in the effective set, and no way to gain one.
    const status = (await docker(['exec', name, 'cat', '/proc/1/status'])).stdout
    expect(status).toMatch(/CapEff:\s+0+\b/)
    expect(status).toMatch(/NoNewPrivs:\s+1/)
    const id = (await docker(['exec', name, 'id', '-u'])).stdout.trim()
    expect(id).not.toBe('0')
    const env = (await docker(['exec', name, 'env'])).stdout
    expect(env).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD/i)
    // The only host path in the container is the output folder.
    expect((inspected.Mounts ?? []).map(mount => mount.Destination)).toEqual(['/out'])
  }, 600_000)
})
