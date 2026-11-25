import { describe, expect, it } from 'vitest'
import { BENCH_LABEL, hardenedRunArgs, inspectProblems, pickBenchPort, type InspectedContainer, type RunSpec } from '../../src/compat-bench/docker.ts'

const OUT = '/tmp/bench-out'
const spec: RunSpec = { name: 'bench-x', image: 'img:1', runId: 'r1', outDir: OUT, user: '1000:1000' }

/** A container as `docker inspect` reports one that follows the hardening. */
function hardened(): InspectedContainer {
  return {
    Config: { User: '1000:1000', Env: ['PATH=/usr/bin', 'HOME=/home/bench'], Labels: { 'delorun.bench': '1' } },
    HostConfig: { CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], Privileged: false, NetworkMode: 'bridge', Memory: 4 * 1024 ** 3, PidsLimit: 1024, PortBindings: { '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18700' }] } },
    Mounts: [{ Type: 'bind', Source: OUT, Destination: '/out' }, { Type: 'volume', Name: 'bench-home-r1', Destination: '/home/bench/home' }],
  }
}

describe('the run arguments', () => {
  it('drop every capability, forbid new privileges, run unprivileged with limits and one bind mount', () => {
    const args = hardenedRunArgs(spec).join(' ')
    expect(args).toContain('--cap-drop ALL')
    expect(args).toContain('--security-opt no-new-privileges')
    expect(args).toContain('--user 1000:1000')
    expect(args).toContain('--pids-limit')
    expect(args).toContain('--memory ')
    expect(args).toContain(`--label ${BENCH_LABEL}`)
    expect(args.match(/--volume/g)).toHaveLength(1)
    expect(args).not.toContain('--privileged')
    expect(args).not.toContain('--network host')
    expect(args).not.toContain('--publish')
  })

  it('publishes only on 127.0.0.1 inside the bench port range', () => {
    expect(hardenedRunArgs({ ...spec, publish: { host: 18701, container: 3080 } }).join(' ')).toContain('--publish 127.0.0.1:18701:3080')
    expect(() => hardenedRunArgs({ ...spec, publish: { host: 3080, container: 3080 } })).toThrow('outside')
    expect(() => hardenedRunArgs({ ...spec, publish: { host: 18200, container: 3080 } })).toThrow('outside')
  })

  it('refuses an environment name that is not on the allow-list or that names a secret', () => {
    expect(() => hardenedRunArgs({ ...spec, env: { DEEPSEEK_API_KEY: 'x' } })).toThrow('not one a plugin container')
    expect(() => hardenedRunArgs({ ...spec, env: { SOME_OTHER: 'x' } })).toThrow('not one a plugin container')
    expect(hardenedRunArgs({ ...spec, env: { BENCH_HOST: 'delorun' } }).join(' ')).toContain('--env BENCH_HOST=delorun')
  })
})

describe('the inspect check', () => {
  it('finds nothing wrong with a hardened container', () => {
    expect(inspectProblems(hardened(), { outDir: OUT, volumes: ['bench-home-r1'] })).toEqual([])
  })

  it('names each way a container departs from the hardening', () => {
    const base = hardened()
    const check = (change: (value: InspectedContainer) => InspectedContainer): string[] => inspectProblems(change(structuredClone(base)), { outDir: OUT, volumes: ['bench-home-r1'] })
    expect(check(value => ({ ...value, HostConfig: { ...value.HostConfig, CapDrop: [] } }))).toContain('capabilities are not all dropped')
    expect(check(value => ({ ...value, HostConfig: { ...value.HostConfig, CapAdd: ['NET_ADMIN'] } }))).toContain('capabilities were added: NET_ADMIN')
    expect(check(value => ({ ...value, HostConfig: { ...value.HostConfig, SecurityOpt: [] } }))).toContain('no-new-privileges is not set')
    expect(check(value => ({ ...value, HostConfig: { ...value.HostConfig, Privileged: true } }))).toContain('the container is privileged')
    expect(check(value => ({ ...value, Config: { ...value.Config, User: '' } }))[0]).toContain('runs as root')
    expect(check(value => ({ ...value, Config: { ...value.Config, User: 'root' } }))[0]).toContain('runs as root')
    expect(check(value => ({ ...value, HostConfig: { ...value.HostConfig, NetworkMode: 'host' } }))).toContain('the container uses the host network')
    expect(check(value => ({ ...value, Mounts: [{ Type: 'bind', Source: '/home/vadim', Destination: '/host' }] }))[0]).toContain('is not the output folder')
    expect(check(value => ({ ...value, Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' }] }))).toHaveLength(1)
    expect(check(value => ({ ...value, HostConfig: { ...value.HostConfig, PortBindings: { '3080/tcp': [{ HostIp: '0.0.0.0', HostPort: '18700' }] } } }))[0]).toContain('0.0.0.0')
    expect(check(value => ({ ...value, HostConfig: { ...value.HostConfig, PortBindings: { '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: '3080' }] } } }))[0]).toContain('outside the bench range')
    expect(check(value => ({ ...value, HostConfig: { ...value.HostConfig, Memory: 0 } }))).toContain('there is no memory limit')
    expect(check(value => ({ ...value, HostConfig: { ...value.HostConfig, PidsLimit: null } }))).toContain('there is no process limit')
    expect(check(value => ({ ...value, Config: { ...value.Config, Env: ['DEEPSEEK_API_KEY=x'] } }))).toContain('the environment holds DEEPSEEK_API_KEY')
    expect(check(value => ({ ...value, Config: { ...value.Config, Env: ['FOO=1'] } }))[0]).toContain('not on the allow-list')
    expect(check(value => ({ ...value, Config: { ...value.Config, Labels: {} } }))).toContain('the container does not carry the bench label')
  })

  it('picks a port inside the bench range', async () => {
    const port = await pickBenchPort()
    expect(port).toBeGreaterThanOrEqual(18700)
    expect(port).toBeLessThanOrEqual(18749)
    expect(await pickBenchPort([port])).not.toBe(port)
  })
})
