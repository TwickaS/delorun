/**
 * Setup's `reach` section, asked in the main flow of the remote use case, under "More settings" for the others, and as `delorun setup reach`: whether the studio is reachable from the
 * person's phone over their own tailnet. Turning it on runs the Tailscale checks of `delorun reach on tailscale`, Funnel,
 * the removal of a serve rule the home would not keep and the test that the person's user may configure
 * `tailscale serve` included (`checkServeAccess`), and shows the trust statement; a check that fails leaves remote
 * access off and names what to fix, with the one command to run for a user who may not configure serve. Applying it
 * records the fixed listener port, chosen once; the home removes any other serve rule on the port when it starts. It
 * then asks who may ask to pair a device without an approval window: only devices signed in as this computer's
 * Tailscale user (the default), or any device on the tailnet; the choice is written to the `pairing` configuration of
 * the profile's `delorun-home-auth` row. The answer is `tailscale-private` with the factor
 * `tailnet-membership`, or `none`.
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

export function reachSection(tailscale: TailscaleRunner, running: (home: string, profile: string) => boolean): SetupSection {
  return {
    id: 'reach',
    title: 'Remote access',
    plan: { local: 'more', remote: 'asked', automation: 'never' },
    asks: () => true,
    appliesTo: () => true,
    async ask(io, draft, environment) {
      io.note('Needs Tailscale installed and signed in. Delorun turns on a private https address; a device you approve here with a code can read and reply to chats, and can never grant full access or change settings.\nChange later: delorun setup reach, or delorun reach off.', 'Phone and other devices')
      const on = await io.confirm('Open Delorun from your phone or another device over Tailscale?', draft.answers.reach.option === 'tailscale-private' || (draft.answers.useCase === 'remote' && draft.phase !== 'single' && !environment.profileExists))
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
      const anyDevice = await io.confirm('Let any device on your tailnet ask to pair, not only devices signed in as your own Tailscale user? Every request still needs the code from its screen, typed at this computer.', draft.answers.reach.pairing === 'tailnet')
      if (anyDevice === BACK) return BACK
      return { answers: { reach: { option: 'tailscale-private', identityFactor: 'tailnet-membership', pairing: anyDevice ? 'tailnet' : 'own-user' } }, status: 'answered' }
    },
    unchanged: (before, after) => before.reach.option === after.reach.option && before.reach.pairing === after.reach.pairing,
    review: answers => `Remote access: ${answers.reach.option === 'tailscale-private' ? `from your phone over Tailscale; ${answers.reach.pairing === 'tailnet' ? 'any device on your tailnet may ask to pair' : 'only your own Tailscale user may ask to pair'}` : 'off'}`,
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
