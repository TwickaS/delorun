/**
 * Switch registry of Delorun's parity composition, the configuration that replays
 * upstream's recorded scenarios unchanged. The specification is
 * `delorun/docs/contracts/c16-parity-composition.md`.
 *
 * This module holds readonly constants and types only.
 *
 * @module @delorun/contract-parity-composition
 */

/** Registry version. Changing an entry's parity value or removing an entry increments it. */
export const PARITY_REGISTRY_VERSION = 1 as const

/** Upstream release tag whose recorded scenarios the parity composition replays. */
export const PARITY_BASE_TAG = 'dsh-v0.2.2-rc.3' as const

/** Repository path of the Cordis overlay that sets every switch and default to its parity value. */
export const PARITY_OVERLAY_PATH = 'delorun/apps/tools/src/parity/composition/parity.overlay.yml' as const

/** Environment variable through which the replay lane hands the overlay to every snapshot adapter. */
export const PARITY_OVERLAY_ENV = 'DSH_SNAPSHOT_PATCH' as const

/**
 * The validated boolean Config field that holds a built switch. Its JSDoc names the switch as `C16 switch \`<id>\``,
 * and its schema default is the switch's parity value.
 */
export interface ParityBooleanField {
  /** Absent or `boolean`: the switch is the field's boolean value. */
  readonly kind?: 'boolean'
  /** The module a `cordis.yml` row names to mount the plugin, such as `@deepseek-ai/dsh-plugin-manager/tools`. */
  readonly module: string
  /** Repository path of that module's source, which declares the `Config` interface and schema. */
  readonly source: string
  /** The Config key. */
  readonly key: string
}

/**
 * A Config key whose presence on the module's row is the switch: Delorun's default composition sets the key on that row,
 * to any value, and the parity composition does not set it. The key's JSDoc in the `Config` interface names the switch
 * as `C16 switch \`<id>\``, and its schema declares no boolean default. The entry's `defaultValue` is `true` and its
 * `parityValue` is `false`.
 */
export interface ParityPresenceField {
  readonly kind: 'presence'
  /** The module a `cordis.yml` row names to mount the plugin, such as `@deepseek-ai/dsh-sandbox-local`. */
  readonly module: string
  /** Repository path of that module's source, which declares the `Config` interface. */
  readonly source: string
  /** The Config key. */
  readonly key: string
}

/** The Config field that holds a built switch: a boolean field, or the presence of a key on the module's row. */
export type ParitySwitchField = ParityBooleanField | ParityPresenceField

/**
 * The state of a model-visible switch's switch-on scenario.
 *
 * `recorded` means `snapshots/<scenario>` holds the recorded Session and the expectation its replay is diffed against,
 * so the parity-replay lane proves the switch. `pending recording` means the scenario exists only as staged
 * configuration under `delorun/apps/tools/src/parity/composition/scenarios`: it tells nobody that the switch was ever
 * observed to change anything, and `parity-switches` reports it as pending instead of counting it as evidence.
 */
export type ParityScenarioState = 'recorded' | 'pending recording'

/** Fields every registry entry carries. */
interface ParitySwitchBase {
  /** Lower snake case, never reused. */
  readonly id: string
  /** The package or upstream edit that registers the switch. */
  readonly registeredBy: string
  /** The value in Delorun's default composition; `true` leaves the change active. */
  readonly defaultValue: boolean
  /** The value in the parity composition. */
  readonly parityValue: boolean
  /**
   * Whether the change reaches a model request: a tool, tool schema, tool description, tool result text, system
   * prompt context or runtime context. A switch that does not is a feature switch and has no switch-on scenario.
   */
  readonly modelVisible: boolean
  /** The switch-on scenario, `<profile>/delorun-<id with hyphens>` under `snapshots/`, for a model-visible switch. */
  readonly scenario?: string
  /**
   * Whether that scenario is recorded or still waits for its recording. A built, model-visible switch states this,
   * so a scenario with no recorded expectation cannot be mistaken for a passing one; `parity-switches` holds the
   * claim against the tree in both directions.
   */
  readonly scenarioState?: ParityScenarioState
}

/** A switch whose Config field exists in the tree. */
export interface BuiltParitySwitch extends ParitySwitchBase {
  readonly state: 'built'
  readonly field: ParitySwitchField
  /**
   * Repository paths of the files whose model-visible contributions the switch turns off at its parity value. The
   * `parity-switches` scan accepts a contribution only in one of these files.
   */
  readonly sources: readonly string[]
}

/** A switch C16 lists whose change and Config field are not in the tree yet; it has no field and covers no file. */
export interface PlannedParitySwitch extends ParitySwitchBase {
  readonly state: 'planned'
  /** The work package that builds the change and turns the entry into a built one. */
  readonly plannedBy: string
}

/** One registry entry. */
export type ParitySwitchEntry = BuiltParitySwitch | PlannedParitySwitch

/**
 * The registry: one entry per model-visible Delorun change, plus the feature switches of the doctor, the studio
 * additions and the update check. `defaultValue` applies in
 * Delorun's default composition and `parityValue` applies in the parity composition.
 */
export const PARITY_SWITCHES = [
  {
    id: 'studio_additions',
    state: 'built',
    registeredBy: '@delorun/plugin-theme, which @delorun/bundle-studio mounts with the switch on',
    defaultValue: true,
    parityValue: false,
    // The theme, sidebar, chat states, settings layout and onboarding change what the person sees, not what reaches
    // the model: a feature switch. The theme provides the `delorunStudio` browser service only while it is on, and every
    // other studio plugin requires that service.
    modelVisible: false,
    field: {
      module: '@delorun/plugin-theme',
      source: 'delorun/packages/plugin-theme/src/config.ts',
      key: 'studioAdditions',
    },
    sources: [],
  },
  {
    id: 'main_chat',
    state: 'built',
    registeredBy: '@delorun/plugin-main-chat',
    // The main chat is experimental and no Delorun profile mounts it; every row that mounts it turns the switch on, so
    // `true` is its value wherever Delorun's composition includes it.
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'web/delorun-main-chat',
    scenarioState: 'pending recording',
    field: {
      module: '@delorun/plugin-main-chat',
      source: 'delorun/packages/plugin-main-chat/src/index.ts',
      key: 'enabled',
    },
    sources: [
      'delorun/packages/plugin-main-chat/src/account-tools.ts',
      'delorun/packages/plugin-main-chat/src/guard.ts',
      'delorun/packages/plugin-main-chat/src/index.ts',
      'delorun/packages/plugin-main-chat/src/tools.ts',
    ],
  },
  {
    id: 'permission_defaults',
    state: 'built',
    registeredBy: '@delorun/plugin-permission-defaults',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delorun-permission-defaults',
    scenarioState: 'pending recording',
    field: {
      module: '@delorun/plugin-permission-defaults',
      source: 'delorun/packages/plugin-permission-defaults/src/index.ts',
      key: 'enabled',
    },
    // The plugin registers everything behind the switch: off, it mounts no
    // service, no guard and no seed, so these are the files whose runtime
    // behaviour the switch turns off at its parity value.
    sources: [
      'delorun/packages/plugin-permission-defaults/src/index.ts',
      'delorun/packages/plugin-permission-defaults/src/command-network.ts',
      'delorun/packages/plugin-permission-defaults/src/sandbox-tmp.ts',
    ],
  },
  {
    id: 'fetch_guard',
    state: 'built',
    registeredBy: '@delorun/plugin-fetch-guard',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delorun-fetch-guard',
    scenarioState: 'pending recording',
    field: {
      module: '@delorun/plugin-fetch-guard',
      source: 'delorun/packages/plugin-fetch-guard/src/index.ts',
      key: 'enabled',
    },
    // The refusal reaches the model through the provider's typed error, not
    // through a registration; these files are the ones whose runtime behaviour
    // the switch turns off at its parity value.
    sources: [
      'packages/web/web-fetch-http/src/provider.ts',
      'packages/web/web-fetch-http/src/index.ts',
    ],
  },
  {
    id: 'tool_failure_guard',
    state: 'built',
    registeredBy: '@delorun/plugin-tool-failure-guard',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delorun-tool-failure-guard',
    scenarioState: 'recorded',
    field: {
      module: '@delorun/plugin-tool-failure-guard',
      source: 'delorun/packages/plugin-tool-failure-guard/src/index.ts',
      key: 'enabled',
    },
    // The reminder text and the turn stop are registered here; off, the plugin registers no listener.
    sources: [
      'delorun/packages/plugin-tool-failure-guard/src/index.ts',
    ],
  },
  {
    id: 'preset_inspect',
    state: 'built',
    registeredBy: 'Delorun edit of upstream preset tools',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'web/delorun-preset-inspect',
    scenarioState: 'recorded',
    field: {
      module: '@deepseek-ai/dsh-agent-preset-registry/tools',
      source: 'packages/preset/agent-preset-registry/src/tools.ts',
      key: 'presetInspect',
    },
    sources: ['packages/preset/agent-preset-registry/src/tools.ts'],
  },
  {
    id: 'doctor',
    state: 'built',
    registeredBy: 'Delorun edit of upstream doctor app, @deepseek-ai/dsh-doctor/app',
    defaultValue: true,
    parityValue: false,
    modelVisible: false,
    field: {
      module: '@deepseek-ai/dsh-doctor/app',
      source: 'packages/boot/doctor/src/app.ts',
      key: 'doctor',
    },
    sources: [],
  },
  {
    id: 'reach',
    state: 'built',
    registeredBy: '@delorun/reach',
    defaultValue: true,
    parityValue: false,
    modelVisible: false,
    field: {
      module: '@delorun/reach',
      source: 'delorun/packages/reach/src/service.ts',
      key: 'enabled',
    },
    sources: [],
  },
  {
    id: 'plugin_manager_read_exemption',
    state: 'built',
    registeredBy: 'Delorun edit of upstream plugin_manager tool',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delorun-plugin-manager-read-exemption',
    scenarioState: 'recorded',
    field: {
      module: '@deepseek-ai/dsh-plugin-manager/tools',
      source: 'packages/boot/plugin-manager/src/tools.ts',
      key: 'readActionsExempt',
    },
    sources: ['packages/boot/plugin-manager/src/tools.ts'],
  },
  {
    id: 'profile_history',
    state: 'built',
    registeredBy: 'Delorun edit of upstream plugin_manager tool',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delorun-profile-history',
    scenarioState: 'recorded',
    field: {
      module: '@deepseek-ai/dsh-plugin-manager/tools',
      source: 'packages/boot/plugin-manager/src/tools.ts',
      key: 'profileHistory',
    },
    sources: ['packages/boot/plugin-manager/src/tools.ts'],
  },
  {
    id: 'scheduled_task_consent',
    state: 'built',
    registeredBy: '@delorun/plugin-schedule-consent',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delorun-scheduled-task-consent',
    scenarioState: 'pending recording',
    field: {
      module: '@delorun/plugin-schedule-consent',
      source: 'delorun/packages/plugin-schedule-consent/src/index.ts',
      key: 'enabled',
    },
    sources: [
      'packages/schedule/schedule/src/index.ts',
      'packages/schedule/schedule/src/runtime.ts',
      'packages/schedule/schedule/src/storage.ts',
      'packages/schedule/schedule/src/types.ts',
      'packages/schedule/tool-schedule/src/index.ts',
    ],
  },
  {
    id: 'instruction_layer_consent',
    state: 'built',
    registeredBy: 'Delorun approval for instruction-layer files',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delorun-instruction-layer-consent',
    scenarioState: 'pending recording',
    field: {
      module: '@delorun/plugin-instruction-consent',
      source: 'delorun/packages/plugin-instruction-consent/src/index.ts',
      key: 'enabled',
    },
    // The consent reaches the model through the approval ask and the typed
    // refusal the dispatch throws, not through a registration; these files are
    // the ones whose runtime behaviour the switch turns off at its parity
    // value.
    sources: [
      'packages/fs/tool-fs/src/consent.ts',
      'packages/fs/tool-fs/src/index.ts',
      'packages/fs/tool-fs/src/sandbox.ts',
      'packages/sandbox/sandbox-policy/src/session-mode.ts',
    ],
  },
  {
    id: 'approved_plugin_write_consent',
    state: 'built',
    registeredBy: 'Delorun approval for writes to approved plugins',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delorun-approved-plugin-write-consent',
    scenarioState: 'pending recording',
    field: {
      module: '@delorun/plugin-instruction-consent',
      source: 'delorun/packages/plugin-instruction-consent/src/index.ts',
      key: 'approvedPluginWrites',
    },
    // The consent reaches the model through the approval ask and the typed
    // refusal (WriteConsentRefusedError) its intent listeners throw, not
    // through a registration; these files are the ones whose runtime behaviour
    // the switch turns off at its parity value.
    sources: [
      'delorun/packages/plugin-instruction-consent/src/index.ts',
      'delorun/packages/plugin-instruction-consent/src/plugin-folders.ts',
    ],
  },
  {
    id: 'mcp_add_consent',
    state: 'built',
    registeredBy: 'Delorun MCP server add flow',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delorun-mcp-add-consent',
    scenarioState: 'pending recording',
    field: {
      module: '@delorun/plugin-mcp-consent',
      source: 'delorun/packages/plugin-mcp-consent/src/index.ts',
      key: 'enabled',
    },
    // The gate reaches the model through the server start the review holds,
    // not through a registration; these files are the ones whose runtime
    // behaviour the switch turns off at its parity value. In the browser
    // runtime, a start the consent refuses leaves that Session without the
    // browser tools; with no consent mounted no start is refused.
    sources: [
      'packages/experimental/browser-use-runtime/src/mcp.ts',
      'packages/mcp/mcp-client/src/consent.ts',
      'packages/mcp/mcp-client/src/index.ts',
    ],
  },
  {
    id: 'browser_additions',
    state: 'built',
    registeredBy: 'Delorun edit of upstream\'s Playwright browser provider, which @delorun/bundle-browser mounts with the switch on',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delorun-browser-additions',
    scenarioState: 'pending recording',
    field: {
      module: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp',
      source: 'packages/experimental/browser-use-playwright-mcp/src/index.ts',
      key: 'browserAdditions',
    },
    // Off, a browser tool failure that reports a browser build which is not
    // installed reaches the model as Playwright's own text, not the Browser
    // setup message, and the output folder gets no .gitignore. The scan also
    // reads, in these files, the security invariants that the switch never
    // turns off and that hold with every switch off: the MCP client never
    // registers a denied tool (browser_run_code_unsafe always), the provider
    // refuses a call to one and a call whose file argument really leads
    // outside the Session's folder, and the server is told that folder as its
    // one MCP root, the folder the guard checks against. The provider spec
    // `keeps the tool denial, the folder guard and the MCP root with
    // browser_additions off` holds them.
    sources: [
      'packages/experimental/browser-use-playwright-mcp/src/index.ts',
      'packages/experimental/browser-use-runtime/src/mcp.ts',
      'packages/mcp/mcp-client/src/tools.ts',
    ],
  },
  {
    id: 'use_my_browser',
    state: 'built',
    registeredBy: '@delorun/browser-use-browse, whose row @delorun/bundle-real-browser inserts with the switch on',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delorun-use-my-browser',
    scenarioState: 'recorded',
    field: {
      module: '@delorun/browser-use-browse',
      source: 'delorun/packages/browser-use-browse/src/config.ts',
      key: 'enabled',
    },
    // Off, the row mounts nothing: no use_my_browser tool, no guard on browse
    // calls and no browse server, so no browse tool or its system-prompt
    // section reaches a model request.
    sources: [
      'delorun/packages/browser-use-browse/src/index.ts',
      'delorun/packages/browser-use-browse/src/tool.ts',
    ],
  },
  {
    id: 'external_agent_consent',
    state: 'built',
    registeredBy: '@delorun/plugin-delegation-consent',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delorun-external-agent-consent',
    scenarioState: 'pending recording',
    field: {
      module: '@delorun/plugin-delegation-consent',
      source: 'delorun/packages/plugin-delegation-consent/src/index.ts',
      key: 'enabled',
    },
    // The consent reaches the model through the external delegation tool's
    // description, the refusal an unapproved start throws and the refusal of a
    // plugin_manager call; these files are the ones whose behaviour the switch
    // turns off at its parity value.
    // `archive-admission.ts` lists and stops the external runs beneath an archived chat; with the consent off no
    // external run it could list is started under review, and the file's pre-step rejection is upstream's own.
    sources: [
      'packages/subagent/subagent/src/archive-admission.ts',
      'packages/subagent/subagent/src/consent.ts',
      'packages/subagent/subagent/src/index.ts',
      'packages/subagent/tool-subagent/src/index.ts',
      'delorun/packages/plugin-delegation-consent/src/index.ts',
    ],
  },
  {
    id: 'external_agent_limit_refusal',
    state: 'built',
    registeredBy: '@delorun/external-agents',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delorun-external-agent-limit-refusal',
    scenarioState: 'pending recording',
    field: {
      module: '@delorun/external-agents',
      source: 'delorun/packages/external-agents/src/index.ts',
      key: 'limitRefusal',
    },
    // The refusal reaches the model as the error of a refused live start and
    // of a refused one-shot run; these files hold the check and its sentence.
    sources: [
      'delorun/packages/external-agents/src/gate.ts',
      'delorun/packages/external-agents/src/copy.ts',
      'delorun/packages/plugin-delegation-consent/src/service.ts',
    ],
  },
  {
    id: 'container_denial_marker',
    state: 'built',
    registeredBy: 'Delorun edit of upstream container denial reporting',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delorun-container-denial-marker',
    scenarioState: 'recorded',
    field: {
      module: '@deepseek-ai/dsh-sandbox-policy',
      source: 'packages/sandbox/sandbox-policy/src/index.ts',
      key: 'containerDenialMarker',
    },
    sources: [
      'packages/core/tool-executor-ptc/src/ptc.ts',
      'packages/sandbox/sandbox-policy/src/index.ts',
      'packages/shell/tool-bash/src/index.ts',
      'packages/shell/tool-pwsh/src/index.ts',
    ],
  },
  {
    id: 'sandbox_protected_reads',
    state: 'built',
    registeredBy: 'Delorun edit of upstream fs search and present tools, the protected-read fence',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delorun-sandbox-protected-reads',
    scenarioState: 'pending recording',
    // The sandbox row's protected home decides the refusal: Delorun's composition sets it, and the parity composition
    // leaves the row to upstream, which sets none.
    field: {
      kind: 'presence',
      module: '@deepseek-ai/dsh-sandbox-local',
      source: 'packages/sandbox/sandbox-local/src/index.ts',
      key: 'protectedHome',
    },
    // The refusal reaches the model through each tool's typed error and filtered result, decided by the sandbox
    // provider's protected home; these are the files whose behaviour that home changes.
    sources: [
      'packages/deliverables/tool-present/src/index.ts',
      'packages/fs/tool-fs-search/src/glob.ts',
      'packages/fs/tool-fs-search/src/grep.ts',
      'packages/fs/tool-fs-search/src/search-core.ts',
    ],
  },
  {
    id: 'update_turn_refusal',
    state: 'built',
    registeredBy: '@delorun/bundle-local, its delorun-update-gate row',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delorun-update-turn-refusal',
    scenarioState: 'pending recording',
    field: {
      module: '@delorun/bundle-local/update-gate',
      source: 'delorun/packages/bundle-local/src/update-gate.ts',
      key: 'enabled',
    },
    // The plugin registers its `agent/pre-step` listener behind the switch: off,
    // it mounts no service and no listener, so every turn starts as upstream's.
    sources: ['delorun/packages/bundle-local/src/update-gate.ts'],
  },
  {
    id: 'one_time_launch_tokens',
    state: 'built',
    registeredBy: 'Delorun edit of upstream\'s connection, which @delorun/bundle-local mounts with the switch on',
    defaultValue: true,
    parityValue: false,
    // Who signs in to the studio changes, not what reaches the model: a feature switch.
    modelVisible: false,
    field: {
      module: '@deepseek-ai/dsh-client-connection',
      source: 'packages/client/connection/src/index.ts',
      key: 'oneTimeLaunchTokens',
    },
    sources: [],
  },
  {
    id: 'default_workspace_directory',
    state: 'built',
    registeredBy: '@delorun/bundle-local, its workspace-controller row, which `delorun start` fills',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'web/delorun-default-workspace-directory',
    scenarioState: 'pending recording',
    // The workspace controller row's folder decides where the first-use workspace lies: Delorun's composition sets it, and
    // the parity composition leaves the row to upstream, which sets none and runs its own documents lookup.
    field: {
      kind: 'presence',
      module: '@deepseek-ai/dsh-api-workspace-controller',
      source: 'packages/api/workspace-controller/src/index.ts',
      key: 'defaultWorkspaceDirectory',
    },
    // The folder reaches the model as the working directory of a chat in that workspace, through the absolute paths in
    // tool results; this is the file that places the workspace there.
    sources: ['packages/api/workspace-controller/src/index.ts'],
  },
  {
    id: 'update_check',
    state: 'built',
    registeredBy: '@delorun/bundle-local, its delorun-update-check row',
    defaultValue: true,
    parityValue: false,
    // A request for the channel's newest release and a notice in the studio change nothing a model reads: a feature
    // switch. Off, the row provides no service and registers no route, so no check runs, as in stock DSH.
    modelVisible: false,
    field: {
      module: '@delorun/bundle-local/update-check',
      source: 'delorun/packages/bundle-local/src/update-check.ts',
      key: 'enabled',
    },
    sources: [],
  },
  {
    id: 'plugin_changes_pending',
    state: 'built',
    registeredBy: '@delorun/plugin-changes',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delorun-plugin-changes-pending',
    scenarioState: 'pending recording',
    field: {
      module: '@delorun/plugin-changes',
      source: 'delorun/packages/plugin-changes/src/index.ts',
      key: 'enabled',
    },
    // The plugin registers its `tools/pre-execute` listener and its tool guard
    // behind the switch: off, it registers nothing, so every plugin_manager
    // call runs and asks as upstream's does.
    sources: ['delorun/packages/plugin-changes/src/index.ts'],
  },
  {
    id: 'rename_workspace_tool',
    state: 'built',
    registeredBy: '@delorun/bundle-local/workspace-rename',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delorun-rename-workspace-tool',
    scenarioState: 'pending recording',
    field: {
      module: '@delorun/bundle-local/workspace-rename',
      source: 'delorun/packages/bundle-local/src/workspace-rename.ts',
      key: 'enabled',
    },
    // Off, the plugin registers no `rename_workspace` tool, so the model has no tool for renaming a workspace.
    sources: ['delorun/packages/bundle-local/src/workspace-rename.ts'],
  },
] as const satisfies readonly ParitySwitchEntry[]

/** One registry entry, as declared. */
export type ParitySwitch = (typeof PARITY_SWITCHES)[number]

/** Identifier of a registry entry; the union of every `id` in {@link PARITY_SWITCHES}. */
export type ParitySwitchId = ParitySwitch['id']
