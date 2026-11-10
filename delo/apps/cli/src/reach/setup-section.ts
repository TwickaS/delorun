/**
 * Setup's `reach` section, shown in Full setup and as `delorun setup reach`: whether the studio is reachable from the
 * person's phone over their own tailnet. Turning it on runs the same Tailscale checks as `delorun reach on tailscale`
 * and shows the trust statement; a check that fails leaves remote access off and names what to fix. The answer is
 * `tailscale-private` with the factor `tailnet-membership`, or `none`.
 *
 * @module @delo/cli/reach/setup-section
 */
import { join } from 'node:path'
import { DEFAULT_SERVE_PORT } from '@delo/contract-reach-providers'
import { ReachError, readTailscale, tailscaleAddress, type TailscaleRunner } from '@delo/reach'
import type { SetupSection } from '../setup/sections.ts'
import { BACK } from '../setup/steps.ts'
import { writeReachRowAt } from './row.ts'
import { TRUST_STATEMENT } from './trust.ts'

/** The section's place in the flow: after background, before the profile. */
export const REACH_SECTION_ORDER = 45

/**
 * Build the section over a `tailscale` runner.
 * @param tailscale - the runner.
 * @returns the section.
 */
export function reachSection(tailscale: TailscaleRunner): SetupSection {
  return {
    id: 'reach',
    title: 'Remote access',
    mode: 'full',
    asks: true,
    appliesTo: () => true,
    async ask(io, draft) {
      const on = await io.confirm('Reach this studio from your phone over your own tailnet (Tailscale)?', draft.answers.reach.option === 'tailscale-private')
      if (on === BACK) return BACK
      if (!on) return { answers: { reach: { option: 'none', identityFactor: null } }, status: 'answered' }
      try {
        await readTailscale(tailscale)
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
      writeReachRowAt(join(context.directory, 'cordis.patch.yml'), { enabled: true, address: tailscaleAddress(dnsName, DEFAULT_SERVE_PORT), servePort: DEFAULT_SERVE_PORT })
      return 'Remote access starts with Delo. Add your phone with delorun devices approve, then type the code it shows.'
    },
  }
}
