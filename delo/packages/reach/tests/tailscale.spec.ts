/**
 * The Tailscale private provider's checks and commands, over a fake `tailscale`: it is never run through `sudo`, each
 * failed check names C7's code and what the person does, and the serve target is the reach listener's bound port.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StudioAddress } from '@delo/contract-admission'
import { TAILSCALE_OPERATOR_COMMAND } from '@delo/contract-reach-providers'
import { TailscalePrivateProvider, TAILSCALE_PRIVATE_VISIBILITY, tailscaleAddress } from '../src/provider.ts'
import { isPermissionRefusal, readTailscale, systemTailscale, unserve, type TailscaleResult, type TailscaleRunner } from '../src/tailscale.ts'

const HOST = 'home.example.ts.net'
const ADDRESS = brandString<StudioAddress>(`https://${HOST}`)

/** A fake `tailscale` whose answers a spec sets per subcommand. */
function fake(answers: Partial<Record<string, TailscaleResult>> = {}): { readonly run: TailscaleRunner; readonly calls: string[][] } {
  const calls: string[][] = []
  const status = { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${HOST}.` }, CertDomains: [HOST] }), stderr: '' }
  return {
    calls,
    run: async (args) => {
      calls.push([...args])
      const answer = answers[args[0] ?? ''] ?? (args[0] === 'status' ? status : { code: 0, stdout: '', stderr: '' })
      return Promise.resolve(answer)
    },
  }
}

const rows = (row: object): Parameters<TailscalePrivateProvider['resolve']>[0] => ({ tailscalePrivate: { enabled: true, address: ADDRESS, servePort: 443, ...row } })

describe('the Tailscale private provider', () => {
  it('declares tailnet-membership and resolves only an https ts.net address', () => {
    const provider = new TailscalePrivateProvider(fake().run)
    expect(provider.factor).toBe('tailnet-membership')
    expect(provider.visibility()).toBe(TAILSCALE_PRIVATE_VISIBILITY)
    expect(provider.resolve({})).toBeUndefined()
    expect(provider.resolve(rows({ enabled: false }))).toBeUndefined()
    expect(provider.resolve(rows({}))).toEqual({ option: 'tailscale-private', listener: 'reach-tailscale-private', address: ADDRESS, servePort: 443 })
    expect(() => provider.resolve(rows({ address: 'https://studio.example.org' }))).toThrow(expect.objectContaining({ code: 'TAILSCALE_ADDRESS_MISMATCH' }))
    expect(() => provider.resolve(rows({ address: `http://${HOST}` }))).toThrow(expect.objectContaining({ code: 'TAILSCALE_ADDRESS_MISMATCH' }))
    expect(() => provider.resolve(rows({ servePort: 0 }))).toThrow(expect.objectContaining({ code: 'PORT_CONFLICT' }))
    expect(tailscaleAddress(HOST, 8443)).toBe(`https://${HOST}:8443`)
  })

  it('configures the serve target to the listener\'s port and removes it, never through sudo', async () => {
    const tailscale = fake()
    const provider = new TailscalePrivateProvider(tailscale.run)
    const spec = provider.resolve(rows({}))
    if (spec === undefined) throw new Error('no spec')
    await provider.start(spec, 41234)
    await provider.stop(spec)
    expect(tailscale.calls).toEqual([
      ['version'], ['status', '--json'], ['serve', '--bg', '--https=443', 'http://127.0.0.1:41234'], ['serve', '--https=443', 'off'],
    ])
    expect(tailscale.calls.flat()).not.toContain('sudo')
  })

  it('names each failed check with C7\'s code', async () => {
    const provider = (answers: Parameters<typeof fake>[0]): TailscalePrivateProvider => new TailscalePrivateProvider(fake(answers).run)
    const spec = new TailscalePrivateProvider(fake().run).resolve(rows({}))
    if (spec === undefined) throw new Error('no spec')
    await expect(provider({ version: { code: null, stdout: '', stderr: '' } }).start(spec, 1)).rejects.toMatchObject({ code: 'TAILSCALE_NOT_INSTALLED' })
    await expect(provider({ status: { code: 1, stdout: '', stderr: 'stopped' } }).start(spec, 1)).rejects.toMatchObject({ code: 'TAILSCALE_NOT_LOGGED_IN' })
    await expect(provider({ status: { code: 0, stdout: 'not json', stderr: '' } }).start(spec, 1)).rejects.toMatchObject({ code: 'TAILSCALE_NOT_LOGGED_IN' })
    await expect(provider({ status: { code: 0, stdout: 'null', stderr: '' } }).start(spec, 1)).rejects.toMatchObject({ code: 'TAILSCALE_NOT_LOGGED_IN' })
    await expect(provider({ status: { code: 0, stdout: '{}', stderr: '' } }).start(spec, 1)).rejects.toMatchObject({ code: 'TAILSCALE_NOT_LOGGED_IN' })
    await expect(provider({ status: { code: 0, stdout: JSON.stringify({ BackendState: 'NeedsLogin' }), stderr: '' } }).start(spec, 1)).rejects.toMatchObject({ code: 'TAILSCALE_NOT_LOGGED_IN' })
    // Pins the HTTPS check: without certificates, tailscale serve answers nothing a browser accepts.
    await expect(provider({ status: { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${HOST}.` }, CertDomains: [] }), stderr: '' } }).start(spec, 1)).rejects.toMatchObject({ code: 'TAILSCALE_HTTPS_DISABLED' })
    await expect(provider({ status: { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'other.example.ts.net.' }, CertDomains: ['other.example.ts.net'] }), stderr: '' } }).start(spec, 1)).rejects.toMatchObject({ code: 'TAILSCALE_ADDRESS_MISMATCH' })
    // Pins "prints the one command and never runs sudo".
    await expect(provider({ serve: { code: 1, stdout: '', stderr: 'Access denied: serve config denied' } }).start(spec, 1)).rejects.toMatchObject({ code: 'TAILSCALE_SERVE_NOT_PERMITTED', detail: expect.stringContaining(TAILSCALE_OPERATOR_COMMAND) })
    await expect(provider({ serve: { code: 1, stdout: '', stderr: '\nsomething else broke\n' } }).start(spec, 1)).rejects.toMatchObject({ code: 'TAILSCALE_NOT_LOGGED_IN', detail: 'tailscale serve failed: something else broke' })
    await expect(provider({ serve: { code: 1, stdout: '', stderr: '' } }).start(spec, 1)).rejects.toMatchObject({ detail: 'tailscale serve failed: no reason given' })
    await expect(unserve(fake({ serve: { code: 1, stdout: '', stderr: '' } }).run, 443)).resolves.toBe(false)
    expect([isPermissionRefusal('permission denied'), isPermissionRefusal('use --operator'), isPermissionRefusal('timeout')]).toEqual([true, true, false])
    await expect(readTailscale(fake({ status: { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: 'x', CertDomains: 'x' }), stderr: '' } }).run)).rejects.toMatchObject({ code: 'TAILSCALE_NOT_LOGGED_IN' })
  })

  it('runs the system tailscale without a shell', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'delo-reach-'))
    try {
      const script = join(directory, 'tailscale')
      await writeFile(script, '#!/bin/sh\necho "$@"\necho oops >&2\nexit 3\n')
      await chmod(script, 0o700)
      // An argument with shell syntax reaches the program as one argument and runs nothing.
      await expect(systemTailscale(script)(['status', '$(touch hacked); --json'])).resolves.toEqual({ code: 3, stdout: 'status $(touch hacked); --json\n', stderr: 'oops\n' })
      await expect(systemTailscale(join(directory, 'missing'))(['version'])).resolves.toMatchObject({ code: null })
      await writeFile(script, '#!/bin/sh\necho ok\n')
      await expect(systemTailscale(script)(['version'])).resolves.toEqual({ code: 0, stdout: 'ok\n', stderr: '' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
