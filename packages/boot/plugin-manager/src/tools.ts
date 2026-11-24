/**
 * Agent-facing current-profile management using the same service as Web controls. Two Config switches, both off by
 * default, add Delorun's behaviour: `profileHistory` (C16 switch `profile_history`) offers the settings and history
 * actions, and `readActionsExempt` (C16 switch `plugin_manager_read_exemption`) runs the read actions without the
 * escalation. With both off, the tool's description, parameters and approvals are upstream's.
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import { assertNever, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from './index.ts'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-config-editor'
import { redactSecrets } from '@deepseek-ai/dsh-settings/redact'
import { approveEscalation } from '@deepseek-ai/dsh-sandbox'
import type {
  ChangeResult, ManagementError, PluginEntryId, PluginInstallFailureKind, ProfileVersionChanges, ProfileVersionId, RestartReason,
} from './types.ts'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createConfigProjector, getDshRuntimeVersion, isNativeConfigSchema, LOADER_EXPRESSION_SCHEMA } from '@deepseek-ai/dsh-app-boot'

/** What the model does next for each refusal the manager reports. */
const ERROR_STEPS: Record<ManagementError['code'], string> = {
  'management-required': 'This entry belongs to plugin management itself and cannot be changed.',
  'unaddressable': 'This entry has no unique profile patch target; tell the user to edit the profile patch file directly.',
  'unknown-plugin': 'Call list_plugins and retry with an exact entryId.',
  'invalid-spec': 'Retry with an npm package name, a git URL, a tarball URL, or an absolute local directory.',
  'already-installed': 'The package is already installed; to install another version, call remove_bundle first, then install_bundle again.',
  'ambiguous-install': 'The dependency change named no single package; call list_bundles to see what was installed.',
  'not-bundle': 'The package declares no dsh.bundle and cannot be managed as a plugin; install a DSH plugin bundle instead.',
  'not-removable': 'Call list_bundles; only bundles marked removable can be removed.',
  'stop-profile': 'This profile runs without HMR; tell the user to stop DSH and run `dsh plugin --profile <profile> remove <bundle>`.',
  'bundle-in-use': 'Call list_plugins, disable the entries from other layers that still use this bundle, then retry.',
  'stale-approval': 'Call install_bundle again without approvedBuilds to read the current pendingBuilds.',
  'incompatible-version': 'Install a version compatible with the running DSH. A version exemption needs the user\'s explicit acceptance of crash and data-loss risk.',
  'unsupported-platform': 'This bundle cannot run on the current Host platform; ask the user to use a supported Host.',
  'unexpected-package': 'The source installed another package or version than requested and was rolled back; report this to the user.',
  'audit-findings': 'The plugin audit found what error.audit lists; tell the user. Only the user can accept findings, by installing the package again on the Plugins page after reading them; you cannot accept them for the user.',
  'audit-refused': 'The plugin audit refused this package for a critical finding in error.audit; tell the user it cannot be installed or enabled here.',
  'nothing-to-undo': 'The profile\'s history holds no earlier version to go back to.',
  'unknown-version': 'Call history and retry with an id it lists.',
  'history-unavailable': 'The profile\'s history cannot be read or written, so undo and restore are unavailable; tell the user the diagnostic, and make the reverse change with set_plugin, set_bundle, install_bundle or remove_bundle instead.',
  'operation-error': 'Report the diagnostic to the user; retry only after its cause is addressed.',
}

/**
 * What the model does next for a `management-required` refusal whose diagnostic names modules the profile protects
 * through the manager's `protectedPlugins`, rather than modules plugin management itself needs. Only a profile that
 * configures `protectedPlugins` produces it, so a composition without that setting reads {@link ERROR_STEPS} alone.
 */
const PROFILE_PROTECTED_STEP = 'This change would disable, reconfigure, replace or remove a guard the profile protects (named in error.diagnostic), so plugin management refuses it; tell the user, who alone can change it, by editing the profile outside plugin management.'

/** Why `configure` refuses a `management-required` entry, which is either a management component or a protected guard. */
const CONFIGURE_PROTECTED_STEP = 'plugin management protects this entry, as one of its own components or as a guard the profile protects; only the user can change its settings, outside this tool.'

/** What the model does next for each package-manager failure. */
const FAILURE_STEPS: Partial<Record<PluginInstallFailureKind, string>> = {
  'pnpm-missing': 'pnpm is not available to DSH; tell the user to install pnpm.',
  'timeout': 'Retry, or retry with another registry.',
  'not-found': 'Check the package name and version with the user, then retry.',
  'no-matching-version': 'Retry with a published version.',
  'network': 'Retry later or pass another registry.',
  'disk-full': 'Tell the user to free disk space, then retry.',
  'permission': 'Tell the user DSH cannot write the profile directory; retry after they fix its permissions.',
  'build-blocked': 'Ask the user whether to allow the install scripts of the packages in pendingBuilds; if they approve, retry with approvedBuilds.',
}

/** Why a change waits for a restart, as the model tells the user. */
const RESTART_STEPS: Record<RestartReason, string> = {
  'no-hmr': 'this profile applies changes only at startup',
  'package-moved': 'an installed package now resolves to another directory, or the change replaces a package the DSH installation provides; remove a package before installing it from another location',
  'host-module': 'the change reaches modules DSH itself loaded',
  'unmanaged-plugin': 'the change reaches a plugin running outside the plugin list',
  'module-comparison': 'DSH could not compare loaded plugins with their files',
  'service-replaced': 'the change turns off a plugin that provides a service running chats depend on; restart Delorun to apply it',
}

/**
 * The model-facing result of a change: the manager's result plus the next step its outcome calls for.
 * @param result The manager's result.
 * @returns The result with `nextStep` when it is not plainly applied.
 */
function withNextStep(result: ChangeResult): ChangeResult & { nextStep?: string } {
  switch (result.application) {
    case 'applied':
      return result
    case 'cancelled':
      return { ...result, nextStep: 'The installation was cancelled and its files restored; nothing changed.' }
    case 'overridden':
      return { ...result, nextStep: 'Saved, but a higher-priority layer such as the agent preset overrides it; tell the user it is not in effect.' }
    case 'restart-required': {
      const reason = result.restartReason === undefined ? '' : `: ${RESTART_STEPS[result.restartReason]}`
      return { ...result, nextStep: `Tell the user to restart DSH to apply this change${reason}.` }
    }
    case 'failed': {
      const code = result.error?.code ?? 'operation-error'
      // A refusal code is more specific than the package manager's failure kind.
      const kind = code === 'operation-error' ? result.packageResult?.kind : undefined
      const refusal = code === 'management-required' && result.error?.diagnostic !== undefined ? PROFILE_PROTECTED_STEP : ERROR_STEPS[code]
      return { ...result, nextStep: (kind === undefined ? undefined : FAILURE_STEPS[kind]) ?? refusal }
    }
    /* v8 ignore next -- ChangeResult.application is a closed union */
    default: return assertNever(result.application)
  }
}


/** The tool's switches, each off by default so the tool stays upstream's. */
export interface Config {
  /**
   * Run `list_plugins`, `list_bundles`, `list_version_exemptions`, `history` and `read_config` without the
   * `danger-full-access` escalation, and say so in the description; every other action still requires it. This is
   * Delorun's C16 switch `plugin_manager_read_exemption`, off in the parity composition.
   */
  readActionsExempt?: boolean
  /**
   * Offer `read_config`, `configure`, `history`, `undo` and `restore`, with the description and parameters that
   * state them. This is Delorun's C16 switch `profile_history`, off in the parity composition.
   */
  profileHistory?: boolean
}

/** Validates the tool's switches; each defaults to off. */
export const Config: z<Config> = z.object({
  readActionsExempt: z.boolean().default(false),
  profileHistory: z.boolean().default(false),
})

/** The actions upstream's tool offers, in its order. */
const STOCK_ACTIONS = ['list_plugins', 'list_bundles', 'set_plugin', 'set_bundle', 'install_bundle', 'remove_bundle', 'list_version_exemptions', 'set_version_exemption'] as const

/** The actions the tool offers with `profileHistory` on: upstream's, the settings actions and the history actions. */
const HISTORY_ACTIONS = ['list_plugins', 'list_bundles', 'set_plugin', 'set_bundle', 'read_config', 'configure', 'install_bundle', 'remove_bundle', 'list_version_exemptions', 'set_version_exemption', 'undo', 'history', 'restore'] as const

type Action = (typeof HISTORY_ACTIONS)[number]

/**
 * The actions that only read the profile. With `readActionsExempt` on they run without the escalation; every other
 * action, `undo`, `restore` and `configure` included, requires it.
 */
const READ_ACTIONS: ReadonlySet<Action> = new Set(['list_plugins', 'list_bundles', 'list_version_exemptions', 'history', 'read_config'])

/** The validated arguments of either parameter set; upstream's set lacks `config` and `reset` and the history actions. */
interface ManagerArgs {
  action: Action
  target?: string
  config?: Record<string, JsonValue>
  reset?: string[]
  enabled?: boolean
  runtimeVersion?: string
  acceptRisk?: boolean
  approvedBuilds?: string[]
  registry?: string
  offset?: number
  limit?: number
}

const STOCK_OPENING = 'List plugins or bundles in the current profile, enable or disable them, install a bundle, or remove an installed bundle.'
const HISTORY_OPENING = 'List plugins or bundles in the current profile, enable or disable them, read or change a plugin\'s settings, install a bundle, remove an installed bundle, undo the last change, list the profile\'s versions, or restore one.'
const EVERY_ACTION_ESCALATES = 'Every action requires danger-full-access permission or approval for this call.'
const STOCK_READS_EXEMPT = 'Every change requires danger-full-access permission or approval for this call; listing does not.'
const HISTORY_READS_EXEMPT = 'Every change requires danger-full-access permission or approval for this call; listing, history and read_config do not.'
const COMMON_DESCRIPTION = 'Approval does not change the session permission mode. Changes affect every session in this profile. List first to obtain exact identifiers. Package installation can execute allowed build scripts. Live profiles apply changes immediately, including upgrades of installed packages; a change result that is not applied carries nextStep, which says what to do or tell the user. Unmet DSH version requirements (engines.dsh, else DSH peer dependencies) block installation and activation. Version exemptions risk crashes and data loss: warn the user and obtain explicit permission for the exact plugin and runtime versions before granting one.'
const HISTORY_DESCRIPTION = 'Every change, including one made outside plugin management, is saved as a version of the profile: history lists the saved versions newest first with when, what and who, and an edit made outside plugin management is saved as its own version by the next change, undo or restore. restore puts the profile back as the version target names and applies it; undo restores the version before the latest. Both audit the plugins they bring back before any of their code runs, and their approval lists the plugins, builds and exemptions they change; each is itself a version, and its result names the version in undone or restored and lists what changed in changes. read_config returns a plugin entry\'s settings (config), what the bundles give it (inherited), whether the profile overrides them, and their JSON Schema; secret fields are left out and listed in secrets, and for a plugin whose settings have no schema the values are left out and valuesWithheld is true. configure sets the top-level fields in config, each replacing that field\'s whole value, and puts the fields named in reset back to the inherited value; the plugin\'s schema validates the result before it is saved, and the result lists each changed field before and after. Tell the user what a settings change will do before making it.'

/**
 * The tool description for one combination of switches; with both off it is upstream's text.
 * @param history - whether `profileHistory` is on.
 * @param exempt - whether `readActionsExempt` is on.
 * @returns the description.
 */
function description(history: boolean, exempt: boolean): string {
  const escalation = !exempt ? EVERY_ACTION_ESCALATES : history ? HISTORY_READS_EXEMPT : STOCK_READS_EXEMPT
  return [history ? HISTORY_OPENING : STOCK_OPENING, escalation, COMMON_DESCRIPTION, ...history ? [HISTORY_DESCRIPTION] : []].join(' ')
}

const ENABLED = { type: 'boolean', description: 'Required for set operations; defaults to true for installation. For set_version_exemption, true grants and false revokes.' } as const
const RUNTIME_VERSION = { type: 'string', description: 'For set_version_exemption: exact DSH version from list_version_exemptions. Target must be the manifest package-name@version, not an alias or version range.' } as const
const ACCEPT_RISK = { type: 'boolean', description: 'For granting an exemption: true only after warning the user about possible crashes and data loss and receiving explicit permission for this exact plugin/runtime pair. General installation permission is not enough.' } as const
const APPROVED_BUILDS = { type: 'array', items: { type: 'string' }, description: 'For install_bundle: pass names from pendingBuilds only after the user explicitly approves running their install scripts in the conversation. This grants persistent permission for this profile.' } as const
const REGISTRY = { type: 'string', description: 'For install_bundle: the npm registry URL asked first, when the user names one; otherwise the configured registry is asked, and its configured fallbacks while a registry is unreachable.' } as const
const OFFSET = { type: 'number', description: 'Zero-based list offset; defaults to 0.' } as const

/** Upstream's parameters, in upstream's order. */
const STOCK_PARAMETERS = {
  action: { type: 'string', required: true, enum: STOCK_ACTIONS, description: 'Management operation.' },
  target: { type: 'string', description: 'Plugin entry id, bundle package name, or installation spec, according to action. For an Official catalog entry, pass list_bundles installTarget.spec to install_bundle.' },
  enabled: ENABLED,
  runtimeVersion: RUNTIME_VERSION,
  acceptRisk: ACCEPT_RISK,
  approvedBuilds: APPROVED_BUILDS,
  registry: REGISTRY,
  offset: OFFSET,
  limit: { type: 'number', description: 'List page size, from 1 to 100; defaults to 25.' },
} as const

/** The parameters with `profileHistory` on: upstream's, the history actions, and the settings fields. */
const HISTORY_PARAMETERS = {
  action: { type: 'string', required: true, enum: HISTORY_ACTIONS, description: 'Management operation.' },
  target: { type: 'string', description: 'Plugin entry id, bundle package name, installation spec, or for restore a version id from history, according to action. For read_config and configure, the entry\'s patchId from list_plugins. For an Official catalog entry, pass list_bundles installTarget.spec to install_bundle.' },
  config: { type: 'object', additionalProperties: true, description: 'For configure: the top-level settings fields to set, each replacing that field\'s whole value.' },
  reset: { type: 'array', items: { type: 'string' }, description: 'For configure: top-level settings fields to put back to the value the bundles give them.' },
  enabled: ENABLED,
  runtimeVersion: RUNTIME_VERSION,
  acceptRisk: ACCEPT_RISK,
  approvedBuilds: APPROVED_BUILDS,
  registry: REGISTRY,
  offset: OFFSET,
  limit: { type: 'number', description: 'List page size, from 1 to 100; defaults to 25. For history, the most versions to list.' },
} as const

/** Required services for the management tool. */
export const inject = ['tools', 'pluginManager', 'sandboxPolicy']

/** Register one management tool for discovery and the persistent actions, and with `profileHistory` on their undo.
 * @param ctx Agent-scoped tool registration context.
 * @param config The tool's switches.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const exempt = config.readActionsExempt === true
  const history = config.profileHistory === true
  const shared = {
    name: 'plugin_manager',
    description: description(history, exempt),
    output: {
      schema: { type: 'string' },
      render: (_args: ManagerArgs, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: (args: ManagerArgs, exec: ToolRunContext): Promise<string> => execute(ctx, args, exec, exempt),
    presentCall: (args: ManagerArgs) => ({ card: 'generic' as const, title: 'Manage profile plugins', kind: READ_ACTIONS.has(args.action) ? 'read' as const : 'other' as const, rawInput: args }),
  } as const
  ctx.tools.register(history
    ? defineTool({ ...shared, parameters: HISTORY_PARAMETERS })
    : defineTool({ ...shared, parameters: STOCK_PARAMETERS }))
}

/**
 * Run one validated call. Every action outside {@link READ_ACTIONS}, and with `readActionsExempt` off every action,
 * first requires the `danger-full-access` escalation. An undo or a restore that asks for approval lists what it would
 * change in the approval, read before the prompt without saving a version.
 */
async function execute(ctx: Context, args: ManagerArgs, exec: ToolRunContext, exempt: boolean): Promise<string> {
  const manager = ctx.pluginManager
  if (!(exempt && READ_ACTIONS.has(args.action))) {
    const policy = ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
    let listing = ''
    let refusal: ChangeResult | undefined
    if ((args.action === 'undo' || args.action === 'restore') && policy.mode !== 'danger-full-access') {
      const preview = args.action === 'undo' ? await manager.previewUndo() : await manager.previewRestore(versionOf(args.target))
      if (preview.ok) listing = ` It puts the profile back as version ${preview.version.version} ("${preview.version.summary}") and changes ${describeChanges(preview.changes)}.`
      else {
        listing = ` It cannot run: ${preview.error.code}${preview.error.diagnostic === undefined ? '' : ` (${preview.error.diagnostic})`}; nothing will change.`
        refusal = { changed: false, application: 'failed', stage: args.action, target: args.target ?? '', error: preview.error }
      }
    }
    await approveEscalation({
      requestedMode: 'danger-full-access', effectiveMode: policy.mode, subject: 'plugin management operation',
      justification: `plugin_manager ${JSON.stringify(args)}.${listing} Profile changes persist across sessions; installed Host code runs outside the workspace sandbox.`,
    }, { approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId,
      toolName: 'plugin_manager', signal: exec.signal })
    if (refusal !== undefined) return JSON.stringify(withNextStep(refusal))
  }
  exec.signal.throwIfAborted()
  switch (args.action) {
    case 'list_version_exemptions':
      return JSON.stringify({ runtimeVersion: getDshRuntimeVersion(), ...manager.listVersionExemptions() })
    case 'set_version_exemption':
      if (args.target === undefined || args.runtimeVersion === undefined || args.enabled === undefined) {
        throw new Error('target package-name@version, runtimeVersion, and enabled are required')
      }
      return JSON.stringify(withNextStep(
        await manager.setVersionExemption(args.target, args.runtimeVersion, args.enabled, args.acceptRisk)))
    case 'list_plugins':
    case 'list_bundles': {
      const offset = args.offset ?? 0
      const limit = args.limit ?? 25
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error('offset must be a non-negative integer and limit must be an integer from 1 to 100')
      }
      const rows = args.action === 'list_plugins' ? await manager.listPlugins() : await manager.listBundles()
      const entries = rows.slice(offset, offset + limit).map(({ meta: _meta, ...row }) =>
        'rows' in row
          // GUI listing and update eligibility do not change the tool's management operations.
          ? (({ update: _update, listedByDefault: _listedByDefault, ...bundle }) => ({
            ...bundle, rows: bundle.rows.map(({ meta: _rowMeta, ...declared }) => declared),
          }))(row)
          : row)
      return JSON.stringify({ entries, total: rows.length,
        nextOffset: offset + entries.length < rows.length ? offset + entries.length : null })
    }
    case 'set_plugin':
    case 'set_bundle': {
      if (args.target === undefined || args.enabled === undefined) throw new Error('target and enabled are required')
      return JSON.stringify(withNextStep(await (args.action === 'set_plugin'
        ? manager.setPluginEnabled(args.target as PluginEntryId, args.enabled)
        : manager.setBundleEnabled(args.target, args.enabled))))
    }
    case 'read_config':
    case 'configure':
      if (args.target === undefined) throw new Error('target entry patchId is required')
      return JSON.stringify(args.action === 'read_config' ? await readConfig(ctx, args.target) : await configure(ctx, args.target, args.config ?? {}, args.reset ?? []))
    case 'install_bundle':
      if (args.target === undefined) throw new Error('target package spec is required')
      return JSON.stringify(withNextStep(await manager.installBundle(args.target, {
        ...args.enabled === undefined ? {} : { enabled: args.enabled },
        ...args.approvedBuilds === undefined ? {} : { approvedBuilds: args.approvedBuilds },
        ...args.registry === undefined ? {} : { registry: args.registry },
      })))
    case 'remove_bundle':
      if (args.target === undefined) throw new Error('target bundle name is required')
      return JSON.stringify(withNextStep(await manager.removeBundle(args.target)))
    case 'undo':
      return JSON.stringify(withNextStep(await manager.undo()))
    case 'history': {
      const limit = args.limit ?? 25
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100')
      // A read lists the versions only: saving an outside edit as a version, or starting the history, is a change.
      return JSON.stringify(await manager.listHistory(limit))
    }
    case 'restore':
      return JSON.stringify(withNextStep(await manager.restore(versionOf(args.target))))
    /* v8 ignore next -- tool JSON validation rejects actions outside the declared enum */
    default: return assertNever(args.action)
  }
}

/** The version a restore names, which the call must give. */
function versionOf(target: string | undefined): ProfileVersionId {
  if (target === undefined) throw new Error('target version id from history is required')
  return brandString<ProfileVersionId>(target)
}

/**
 * What an undo or a restore changes, as its approval names it.
 * @param changes - the changes the manager read.
 * @returns a clause listing the plugins, bundles, builds, exemptions and patch layers it changes.
 */
export function describeChanges(changes: ProfileVersionChanges): string {
  const plugins = changes.plugins.map((plugin) => {
    switch (plugin.change) {
      case 'added': return `adds ${plugin.name} ${plugin.to}`
      case 'removed': return `removes ${plugin.name} ${plugin.from}`
      case 'version': return `puts ${plugin.name} at ${plugin.to} (now ${plugin.from})`
      /* v8 ignore next -- ProfilePluginChange.change is a closed union */
      default: return assertNever(plugin)
    }
  })
  const bundles = changes.bundles.map(bundle => `${bundle.selected ? 'selects' : 'deselects'} ${bundle.name}`)
  const decision = (value: string | undefined): string => value ?? 'no decision'
  const builds = changes.builds.map(build => `${build.name} ${decision(build.to)} (now ${decision(build.from)})`)
  const exemptions = changes.exemptions.map(exemption => `${exemption.change === 'added' ? 'grants' : 'revokes'} ${exemption.packageVersion} on DSH ${exemption.runtimeVersion}`)
  const parts = [
    ...plugins.length > 0 ? [`plugins: ${plugins.join(', ')}`] : [],
    ...bundles.length > 0 ? [`bundles: ${bundles.join(', ')}`] : [],
    ...builds.length > 0 ? [`build scripts: ${builds.join(', ')}`] : [],
    ...exemptions.length > 0 ? [`version exemptions: ${exemptions.join(', ')}`] : [],
    ...changes.patchChanged ? ['the profile patch cordis.patch.yml'] : [],
    ...changes.homePatchChanged ? ['the home patch cordis.patch.yml, which applies over every profile'] : [],
    ...changes.unreadable.length > 0 ? [`files it cannot read, whose changes are not listed: ${changes.unreadable.join(', ')}`] : [],
  ]
  return parts.length === 0 ? 'no plugins, builds or exemptions' : parts.join('; ')
}

/**
 * A value as the model reads it: secret fields removed and their positions listed. Only a native schema can tell
 * secret fields apart, so a value whose Config is not one is withheld whole.
 */
function readable(schema: unknown, value: unknown): { value: JsonValue; secrets: Array<{ path: string[]; set: boolean }> } | undefined {
  if (!isNativeConfigSchema(schema)) return undefined
  const redacted = redactSecrets(schema as never, value)
  return { value: JSON.parse(JSON.stringify(redacted.value ?? {})) as JsonValue, secrets: redacted.secrets }
}

/** The configuration editor's row for a profile patch id, or why the agent cannot edit it. */
function configRow(ctx: Context, patchId: string): { editor: Context['configEditor']; row: ReturnType<Context['configEditor']['configuration']>[number] } {
  const editor = ctx.get('configEditor')
  if (editor === undefined) throw new Error('This profile has no configuration editor, so plugin settings cannot be read or changed here')
  const row = editor.configuration().find(item => item.entry.options.id === patchId)
  if (row === undefined) throw new Error(`No running plugin entry has the patchId ${JSON.stringify(patchId)}; call list_plugins for exact patchIds. An entry inside a nested bundle cannot be configured from the profile`)
  return { editor, row }
}

/**
 * A plugin entry's settings as the model reads them.
 * @param ctx The tool's context, whose configuration editor reads the entry.
 * @param patchId The entry's profile patch id.
 * @returns The current, inherited and overridden settings with secrets left out, and the settings' JSON Schema; for a
 * Config that is not a native schema, no values, with `valuesWithheld: true`.
 */
async function readConfig(ctx: Context, patchId: string): Promise<JsonValue> {
  const { row } = configRow(ctx, patchId)
  const native: unknown = row.entry.fiber?.runtime?.Config
  const overridden = Object.keys(row.override).length > 0
  const current = readable(native, row.entry.options.config)
  const inherited = readable(native, row.inherited)
  if (!isNativeConfigSchema(native) || current === undefined || inherited === undefined) {
    return { patchId, name: row.entry.options.name, overridden, valuesWithheld: true, schema: null }
  }
  const projected = (await createConfigProjector())(native, 'config')
  const document = { $defs: { ...projected.definitions, loaderExpression: LOADER_EXPRESSION_SCHEMA }, ...projected.schema }
  return {
    patchId, name: row.entry.options.name, config: current.value, inherited: inherited.value,
    overridden, secrets: current.secrets, schema: JSON.parse(JSON.stringify(document)) as JsonValue,
  }
}

/**
 * Change a plugin entry's settings through the configuration editor, which validates the result against the plugin's
 * schema before saving and applies it; the plugin manager records the edit as a version. An entry the manager lists
 * with a read-only reason, or does not list, is refused before anything is saved, with that reason's code.
 * @param ctx The tool's context, whose configuration editor edits the entry.
 * @param patchId The entry's profile patch id.
 * @param fields Top-level fields to set, each replacing that field's value.
 * @param reset Top-level fields to put back to the inherited value.
 * @returns Each changed field before and after, secrets left out; for a Config that is not a native schema, the changed
 * fields' names only, with `valuesWithheld: true`.
 */
async function configure(ctx: Context, patchId: string, fields: Record<string, unknown>, reset: readonly string[]): Promise<JsonValue> {
  if (Object.keys(fields).length === 0 && reset.length === 0) throw new Error('configure needs config fields to set or reset fields to put back')
  const { editor, row } = configRow(ctx, patchId)
  // The read-only reason that refuses set_plugin for an entry refuses changing its settings; an entry the inventory
  // does not list, such as a group of rows, has no plugin settings of its own to change.
  const listed = (await ctx.pluginManager.listPlugins()).find(plugin => plugin.entryId === row.entry.id)
  if (listed === undefined) throw new Error(`The entry ${JSON.stringify(patchId)} is not a plugin that list_plugins lists, so its settings cannot be changed here`)
  if (listed.readOnlyReason !== undefined) {
    const step = listed.readOnlyReason === 'management-required' ? CONFIGURE_PROTECTED_STEP : ERROR_STEPS[listed.readOnlyReason]
    throw new Error(`The settings of the entry ${JSON.stringify(patchId)} cannot be changed (${listed.readOnlyReason}): ${step}`)
  }
  const native: unknown = row.entry.fiber?.runtime?.Config
  const previous: Record<string, unknown> = { ...row.entry.options.config as Record<string, unknown> | undefined }
  let next: Record<string, unknown> = {}
  await editor.edit(row.entry, (current, inherited) => {
    // A reset field takes the inherited value, or is left out where the bundles give it none.
    const resets = Object.fromEntries(reset.filter(field => Object.hasOwn(inherited, field)).map(field => [field, inherited[field]]))
    next = { ...Object.fromEntries(Object.entries({ ...current, ...fields }).filter(([field]) => !reset.includes(field))), ...resets }
    return next
  })
  const fieldsOf = (before: Record<string, unknown>, after: Record<string, unknown>): string[] =>
    [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter(field => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
  const before = readable(native, previous)
  const after = readable(native, next)
  if (before === undefined || after === undefined) {
    return { patchId, valuesWithheld: true, changed: fieldsOf(previous, next).map(field => ({ field })) }
  }
  const [shownBefore, shownAfter] = [before.value as Record<string, JsonValue>, after.value as Record<string, JsonValue>]
  const changed = fieldsOf(shownBefore, shownAfter)
    .map(field => ({ field, before: shownBefore[field] ?? null, after: shownAfter[field] ?? null }))
  return { patchId, changed }
}
