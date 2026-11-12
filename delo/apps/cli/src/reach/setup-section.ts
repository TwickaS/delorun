/**
 * Setup's `reach` section, shown in Full setup and as `delorun setup reach`: whether the studio is reachable from the
 * person's phone over their own tailnet. Turning it on runs the Tailscale checks of `delorun reach on tailscale`, Funnel,
 * the removal of a serve rule the home would not keep and the test that the person's user may configure
 * `tailscale serve` included (`checkServeAccess`), and shows the trust statement; a check that fails leaves remote
 * access off and names what to fix, with the one command to run for a user who may not configure serve. Applying it
 * records the fixed listener port, chosen once; the home removes any other serve rule on the port when it starts. The
 * answer is `tailscale-private` with the factor `tailnet-membership`, or `none`.
 *
 * @module @delo/cli/reach/setup-section
 */
import { join } from 'node:path'
import { DEFAULT_SERVE_PORT } from '@delo/contract-reach-providers'
import { checkServeAccess, ReachError, readTailscale, tailscaleAddress, type TailscaleRunner } from '@delo/reach'
import { profileDirectory } from '../profile.ts'
import type { SetupSection } from '../setup/sections.ts'
import { BACK } from '../setup/steps.ts'
import { listenerPortFor, readReachRowAt, writeReachRowAt } from './row.ts'
import { TRUST_STATEMENT } from './trust.ts'

/** The section's place in the flow: after background, before the profile. */
export const REACH_SECTION_ORDER = 45

/**
 * Build the section over a `tailscale` runner.
 * @param tailscale - the runner.
 * @param running - whether a profile's home process runs; `homeRuns` of `delorun reach` in a real setup.
 * @returns the section.
 */
export function reachSection(tailscale: TailscaleRunner, running: (home: string, profile: string) => boolean): SetupSection {
  return {
    id: 'reach',
    title: 'Remote access',
    mode: 'full',
    asks: () => true,
    appliesTo: () => true,
    async ask(io, draft, environment) {
      const on = await io.confirm('Reach this studio from your phone over your own tailnet (Tailscale)?', draft.answers.reach.option === 'tailscale-private')
      if (on === BACK) return BACK
      if (!on) return { answers: { reach: { option: 'none', identityFactor: null } }, status: 'answered' }
      try {
        const { dnsName } = await readTailscale(tailscale)
        const row = readReachRowAt(join(profileDirectory(environment.home, environment.profile), 'cordis.patch.yml'))
        const holds = row.enabled && running(environment.home, environment.profile)
        const listenerPort = await listenerPortFor(row.listenerPort, holds)
        await checkServeAccess(tailscale, { host: dnsName, servePort: DEFAULT_SERVE_PORT, listenerPort, keepOwn: holds, next: 'then try again' })
      } catch (error) {
        if (!(error instanceof ReachError)) throw error
        io.note(`${error.detail}\nRemote access stays off; run delorun reach on tailscale once that is fixed.`, 'Remote access')
        return { answers: { reach: { option: 'none', identityFactor: null } }, status: 'answered' }
      }
      io.note(TRUST_STATEMENT.join('\n'), 'Remote access')
      return { answers: { reach: { option: 'tailscale-private', identityFactor: 'tailnet-membership' } }, status: 'answered' }
    },
    review: answers => `Remote access: ${answers.reach.option === 'tailscale-private' ? 'from your phone over Tailscale' : 'off'}`,
    async apply(context, answers) {
      if (answers.reach.option !== 'tailscale-private') return undefined
      const { dnsName } = await readTailscale(tailscale)
      const path = join(context.directory, 'cordis.patch.yml')
      const row = readReachRowAt(path)
      const listenerPort = await listenerPortFor(row.listenerPort, false)
      writeReachRowAt(path, { ...row, enabled: true, address: tailscaleAddress(dnsName, DEFAULT_SERVE_PORT), servePort: DEFAULT_SERVE_PORT, listenerPort })
      return 'Remote access starts with Delo. Add your phone with delorun devices approve, then type the code it shows.'
    },
  }
}
