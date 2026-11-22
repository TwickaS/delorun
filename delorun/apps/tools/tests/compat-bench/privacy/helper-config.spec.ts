import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HELPER_LIMITS, helperName, helperRunArgs } from '../../../src/compat-bench/privacy/helper/image.ts'

const dockerfile = readFileSync(new URL('../../../src/compat-bench/privacy/helper/Dockerfile', import.meta.url), 'utf8')
const args = helperRunArgs('bench-helper-r1', 'delorun-bench-helper:abc', { runId: 'r1', outDir: '/out', canaries: { 'chat word': 'w' }, publish: { host: 18755, container: 18755 } })
const after = (flag: string): string[] => args.flatMap((arg, index) => arg === flag ? [args[index + 1] ?? ''] : [])

describe('the helper container\'s configuration', () => {
  it('pins the proxy image by digest', () => {
    expect(dockerfile).toMatch(/^FROM mitmproxy\/mitmproxy@sha256:[0-9a-f]{64}$/m)
  })

  it('drops every capability but NET_ADMIN, takes no new privileges and is not privileged', () => {
    expect(after('--cap-drop')).toEqual(['ALL'])
    expect(after('--cap-add')).toEqual(['NET_ADMIN'])
    expect(after('--security-opt')).toEqual(['no-new-privileges'])
    expect(args).not.toContain('--privileged')
    expect(args.some(arg => arg === '--network' || arg === '--net' || arg.startsWith('--network='))).toBe(false)
    expect(args).not.toContain('--pid')
  })

  it('has a read-only root, limits, the bench label, and no bind mounts', () => {
    expect(args).toContain('--read-only')
    expect(after('--memory')).toEqual([HELPER_LIMITS.memory])
    expect(after('--pids-limit')).toEqual([String(HELPER_LIMITS.pids)])
    expect(after('--label')).toContain('delorun.bench=1')
    expect(args).not.toContain('--volume')
    expect(args).not.toContain('-v')
    expect(args.some(arg => arg.startsWith('--mount'))).toBe(false)
  })

  it('publishes the studio port on the loopback address only', () => {
    expect(after('--publish')).toEqual(['127.0.0.1:18755:18755'])
    expect(helperRunArgs('n', 'i', { runId: 'r', outDir: '/o', canaries: {} }).includes('--publish')).toBe(false)
  })

  it('names the container after the run, safely', () => {
    expect(helperName('run 1/x')).toBe('bench-helper-run-1-x')
  })

  it('exempts only uid 0 and local traffic from the redirect, and the plugin container never runs as uid 0', () => {
    const entry = readFileSync(new URL('../../../src/compat-bench/privacy/helper/entry.sh', import.meta.url), 'utf8')
    expect(entry).toContain('--uid-owner 0 -j RETURN')
    expect(entry).toContain('--dst-type LOCAL -j RETURN')
    expect(entry).toContain('-p tcp -j REDIRECT --to-ports 8080')
  })
})
