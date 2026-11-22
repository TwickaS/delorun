/**
 * Setup's `reach` section, asked in the main flow as "Use it from your phone too?" and as `delorun setup reach`: whether
 * the studio is reachable from the person's phone over their own tailnet. Turning it on runs the Tailscale checks of `delorun reach on tailscale`, Funnel,
 * the removal of a serve rule the home would not keep and the test that the person's user may configure
 * `tailscale serve` included (`checkServeAccess`), and shows the trust statement; a check that fails leaves remote
 * access off and names what to fix, with the one command to run for a user who may not configure serve. Applying it
 * records the fixed listener port, chosen once; the home removes any other serve rule on the port when it starts. The
 * main flow keeps who may ask to pair a device without an approval window at the safe default (only devices signed in as
 * this computer's Tailscale user); `delorun setup reach` also asks whether any device on the tailnet may. The choice is
 * written to the `pairing` configuration of the profile's `delorun-home-auth` row. The answer is `tailscale-private`
 * with the factor `tailnet-membership`, or `none`.
 *
 * @module @delorun/cli/reach/setup-section
 */
import { join } from 'node:path'
import { DEFAULT_SERVE_PORT } from '@delorun/contract-reach-providers'
import { checkServeAccess, ReachError, readTailscale, tailscaleAddress, type TailscaleRunner } from '@delorun/reach'
import { profileDirectory } from '../profile.ts'
import type { SetupSection } from '../setup/sections.ts'
import { BACK } from '../setup/steps.ts'
import { writeMayAskAt } from './pairing-row.ts'
import { listenerPortFor, readReachRowAt, writeReachRowAt } from './row.ts'
import { TRUST_STATEMENT } from './trust.ts'

/** The section's place in the flow: right after the privacy note. */
export const REACH_SECTION_ORDER = 12

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
    inMainFlow: 'asked',
    asks: () => true,
    appliesTo: () => true,
    async ask(io, draft, environment) {
      let on: boolean | typeof BACK
      if (draft.phase === 'main') {
        const answer = await io.select('Use it from your phone too?', [
          { value: 'no', label: 'No, just this computer' },
          { value: 'yes', label: 'Yes, over Tailscale' },
        ], draft.answers.reach.option === 'tailscale-private' ? 'yes' : 'no')
        on = answer === BACK ? BACK : answer === 'yes'
      } else {
        io.note('Needs Tailscale installed and signed in. Delorun turns on a private https address; a device you approve here with a code can read and reply to chats, and asks for Face ID or its PIN for each sensitive action, such as granting full access or changing settings.\nChange later: delorun setup reach, or delorun reach off.', 'Phone and other devices')
        on = await io.confirm('Open Delorun from your phone or another device over Tailscale?', draft.answers.reach.option === 'tailscale-private')
      }
      if (on === BACK) return BACK
      // The main flow's phone answer is the one place the use case is set: Yes is `remote` even when the check below leaves access off.
      const useCase = draft.phase === 'main' ? { useCase: on ? 'remote' : 'local' } as const : {}
      if (!on) return { answers: { ...useCase, reach: { option: 'none', identityFactor: null } }, status: 'answered' }
      try {
        const { dnsName } = await readTailscale(tailscale)
        const row = readReachRowAt(join(profileDirectory(environment.home, environment.profile), 'cordis.patch.yml'))
        const holds = row.enabled && running(environment.home, environment.profile)
        const listenerPort = await listenerPortFor(row.listenerPort, holds)
        await checkServeAccess(tailscale, { host: dnsName, servePort: DEFAULT_SERVE_PORT, listenerPort, keepOwn: holds, next: 'then try again' })
      } catch (error) {
        if (!(error instanceof ReachError)) throw error
        io.note(`${error.detail}\nRemote access stays off; run delorun reach on tailscale once that is fixed.`, 'Remote access')
        return { answers: { ...useCase, reach: { option: 'none', identityFactor: null } }, status: 'answered' }
      }
      io.note(TRUST_STATEMENT.join('\n'), 'Remote access')
      if (draft.phase === 'main') return { answers: { ...useCase, reach: { option: 'tailscale-private', identityFactor: 'tailnet-membership', pairing: draft.answers.reach.pairing ?? 'own-user' } }, status: 'answered' }
      const anyDevice = await io.confirm('Let any device on your tailnet ask to pair, not only devices signed in as your own Tailscale user? Every request still needs the code from its screen, typed at this computer.', draft.answers.reach.pairing === 'tailnet')
      if (anyDevice === BACK) return BACK
      return { answers: { reach: { option: 'tailscale-private', identityFactor: 'tailnet-membership', pairing: anyDevice ? 'tailnet' : 'own-user' } }, status: 'answered' }
    },
    unchanged: (before, after) => before.reach.option === after.reach.option && before.reach.pairing === after.reach.pairing,
    async apply(context, answers) {
      if (answers.reach.option !== 'tailscale-private') return undefined
      const { dnsName } = await readTailscale(tailscale)
      const path = join(context.directory, 'cordis.patch.yml')
      const row = readReachRowAt(path)
      const listenerPort = await listenerPortFor(row.listenerPort, false)
      writeReachRowAt(path, { ...row, enabled: true, address: tailscaleAddress(dnsName, DEFAULT_SERVE_PORT), servePort: DEFAULT_SERVE_PORT, listenerPort })
      writeMayAskAt(path, answers.reach.pairing ?? 'own-user')
      return 'Remote access starts with Delorun. Open the sign-in address on your phone and ask to pair; type the code it shows when the studio at this computer asks.'
    },
  }
}
