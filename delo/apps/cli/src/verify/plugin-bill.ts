/**
 * The plugin install check as the trust bill reads it: the profile's plugins against the install records
 * `@delo/plugin-install-check` wrote, compared by hashing every installed file.
 *
 * @module @delo/cli/verify/plugin-bill
 */
import { checkProfileTrust, readInstallRecord, type PluginTrustEntry } from '@delo/plugin-install-check/check'
import type { TrustPlugin, TrustPluginMatch, TrustPlugins } from '@delo/bundle-local/trust-bill'
import { profileCheckSettings } from '../plugin-install-check.ts'
import { profileDirectory } from '../profile.ts'
import { boundedDetail } from './checks.ts'
import { listedPlugins } from './bill-profile.ts'
import { reasonOf } from './bill-release.ts'
import type { PluginInstallCheck } from './bill.ts'

/**
 * How a plugin compares with its record.
 * @param entry - the trust status's entry for the plugin; absent for a plugin the status leaves out, such as a linked folder.
 * @returns `match` for unchanged files, `mismatch` for changed ones, `unrecorded` otherwise.
 */
function matchOf(entry: PluginTrustEntry | undefined): TrustPluginMatch {
  if (entry === undefined || entry.state === 'unrecorded') return 'unrecorded'
  return entry.state === 'changed' ? 'mismatch' : 'match'
}

/**
 * The install check over a Delo home, with the installation's `package.json` that locates the profile's `delo-plugin-install-check` row.
 * @param installAnchor - the installation's `package.json`, as upstream's profile boot names it.
 * @returns the check; it hashes every installed file of the profile's plugins, as `delorun verify` does.
 */
export function installedPluginsCheck(installAnchor: string): PluginInstallCheck {
  return {
    async check(home: string, profile: string): Promise<TrustPlugins> {
      const profileDir = profileDirectory(home, profile)
      let settings: ReturnType<typeof profileCheckSettings>
      try {
        settings = profileCheckSettings(home, profileDir, installAnchor)
      } catch (error) {
        return listedPlugins(home, profile, boundedDetail(`the profile's plugin install check settings do not read: ${reasonOf(error)}`))
      }
      if (settings === undefined) return listedPlugins(home, profile, 'the plugin install check is switched off for this profile')
      const status = await checkProfileTrust(profileDir, { full: true, now: Date.now, maxFiles: settings.settings.maxFiles })
      if (status.problem !== undefined) return listedPlugins(home, profile, boundedDetail(`the plugin install check could not read the profile's lockfile: ${status.problem}`))
      const listed = await listedPlugins(home, profile)
      const entries = await Promise.all(listed.entries.map(async (plugin): Promise<TrustPlugin> => {
        const trust = status.plugins.find(entry => entry.name === plugin.name)
        const record = await readInstallRecord(profileDir, plugin.name)
        const findings = record?.findings ?? []
        return {
          ...plugin,
          integrity: record?.source.integrity ?? null,
          commit: record?.source.commit ?? null,
          match: matchOf(trust),
          warnings: findings.filter(finding => finding.severity === 'warning').map(finding => boundedDetail(finding.title)),
          criticalAdvisories: findings.flatMap(finding => finding.severity === 'critical' && finding.advisory !== undefined ? [finding.advisory] : []),
        }
      }))
      return { status: 'known', entries }
    },
  }
}
