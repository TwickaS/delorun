/**
 * Switch registry of Delo's parity composition, the configuration that replays
 * upstream's recorded scenarios unchanged. The specification is
 * `delo/docs/contracts/c16-parity-composition.md`.
 *
 * This module holds readonly constants and types only.
 *
 * @module @delo/contract-parity-composition
 */

/** Registry version. Changing an entry's parity value or removing an entry increments it. */
export const PARITY_REGISTRY_VERSION = 1 as const

/** Upstream release tag whose recorded scenarios the parity composition replays. */
export const PARITY_BASE_TAG = 'dsh-v0.2.2-rc.1' as const

/** Repository path of the Cordis overlay that sets every switch and default to its parity value. */
export const PARITY_OVERLAY_PATH = 'delo/apps/tools/src/parity/composition/parity.overlay.yml' as const

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
 * A Config key whose presence on the module's row is the switch: Delo's default composition sets the key on that row,
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
 * configuration under `delo/apps/tools/src/parity/composition/scenarios`: it tells nobody that the switch was ever
 * observed to change anything, and `parity-switches` reports it as pending instead of counting it as evidence.
 */
export type ParityScenarioState = 'recorded' | 'pending recording'

/** Fields every registry entry carries. */
interface ParitySwitchBase {
  /** Lower snake case, never reused. */
  readonly id: string
  /** The package or upstream edit that registers the switch. */
  readonly registeredBy: string
  /** The value in Delo's default composition; `true` leaves the change active. */
  readonly defaultValue: boolean
  /** The value in the parity composition. */
  readonly parityValue: boolean
  /**
   * Whether the change reaches a model request: a tool, tool schema, tool description, tool result text, system
   * prompt context or runtime context. A switch that does not is a feature switch and has no switch-on scenario.
   */
  readonly modelVisible: boolean
  /** The switch-on scenario, `<profile>/delo-<id with hyphens>` under `snapshots/`, for a model-visible switch. */
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
 * The registry: one entry per model-visible Delo change, plus the feature switches of the doctor and the studio
 * additions. `defaultValue` applies in
 * Delo's default composition and `parityValue` applies in the parity composition.
 */
export const PARITY_SWITCHES = [
  {
    id: 'studio_additions',
    state: 'built',
    registeredBy: '@delo/plugin-theme, which @delo/bundle-studio mounts with the switch on',
    defaultValue: true,
    parityValue: false,
    // The theme, sidebar, chat states, settings layout and onboarding change what the person sees, not what reaches
    // the model: a feature switch. The theme provides the `deloStudio` browser service only while it is on, and every
    // other studio plugin requires that service.
    modelVisible: false,
    field: {
      module: '@delo/plugin-theme',
      source: 'delo/packages/plugin-theme/src/config.ts',
      key: 'studioAdditions',
    },
    sources: [],
  },
  {
    id: 'main_chat',
    state: 'built',
    registeredBy: '@delo/plugin-main-chat',
    // The main chat is experimental and no Delo profile mounts it; every row that mounts it turns the switch on, so
    // `true` is its value wherever Delo's composition includes it.
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'web/delo-main-chat',
    scenarioState: 'pending recording',
    field: {
      module: '@delo/plugin-main-chat',
      source: 'delo/packages/plugin-main-chat/src/index.ts',
      key: 'enabled',
    },
    sources: [
      'delo/packages/plugin-main-chat/src/account-tools.ts',
      'delo/packages/plugin-main-chat/src/guard.ts',
      'delo/packages/plugin-main-chat/src/index.ts',
      'delo/packages/plugin-main-chat/src/tools.ts',
    ],
  },
  {
    id: 'permission_defaults',
    state: 'built',
    registeredBy: '@delo/plugin-permission-defaults',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delo-permission-defaults',
    scenarioState: 'pending recording',
    field: {
      module: '@delo/plugin-permission-defaults',
      source: 'delo/packages/plugin-permission-defaults/src/index.ts',
      key: 'enabled',
    },
    // The plugin registers everything behind the switch: off, it mounts no
    // service, no guard and no seed, so these are the files whose runtime
    // behaviour the switch turns off at its parity value.
    sources: [
      'delo/packages/plugin-permission-defaults/src/index.ts',
    ],
  },
  {
    id: 'fetch_guard',
    state: 'built',
    registeredBy: '@delo/plugin-fetch-guard',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delo-fetch-guard',
    scenarioState: 'pending recording',
    field: {
      module: '@delo/plugin-fetch-guard',
      source: 'delo/packages/plugin-fetch-guard/src/index.ts',
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
    id: 'preset_inspect',
    state: 'built',
    registeredBy: 'Delo edit of upstream preset tools',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'web/delo-preset-inspect',
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
    registeredBy: 'Delo edit of upstream doctor app, @deepseek-ai/dsh-doctor/app',
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
    registeredBy: '@delo/reach',
    defaultValue: true,
    parityValue: false,
    modelVisible: false,
    field: {
      module: '@delo/reach',
      source: 'delo/packages/reach/src/service.ts',
      key: 'enabled',
    },
    sources: [],
  },
  {
    id: 'plugin_manager_read_exemption',
    state: 'built',
    registeredBy: 'Delo edit of upstream plugin_manager tool',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delo-plugin-manager-read-exemption',
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
    registeredBy: 'Delo edit of upstream plugin_manager tool',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delo-profile-history',
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
    registeredBy: '@delo/plugin-schedule-consent',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delo-scheduled-task-consent',
    scenarioState: 'pending recording',
    field: {
      module: '@delo/plugin-schedule-consent',
      source: 'delo/packages/plugin-schedule-consent/src/index.ts',
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
    registeredBy: 'Delo approval for instruction-layer files',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delo-instruction-layer-consent',
    scenarioState: 'pending recording',
    field: {
      module: '@delo/plugin-instruction-consent',
      source: 'delo/packages/plugin-instruction-consent/src/index.ts',
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
    id: 'mcp_add_consent',
    state: 'built',
    registeredBy: 'Delo MCP server add flow',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delo-mcp-add-consent',
    scenarioState: 'pending recording',
    field: {
      module: '@delo/plugin-mcp-consent',
      source: 'delo/packages/plugin-mcp-consent/src/index.ts',
      key: 'enabled',
    },
    // The gate reaches the model through the server start the review holds,
    // not through a registration; these files are the ones whose runtime
    // behaviour the switch turns off at its parity value.
    sources: [
      'packages/mcp/mcp-client/src/consent.ts',
      'packages/mcp/mcp-client/src/index.ts',
    ],
  },
  {
    id: 'container_denial_marker',
    state: 'built',
    registeredBy: 'Delo edit of upstream container denial reporting',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delo-container-denial-marker',
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
    registeredBy: 'Delo edit of upstream fs search and present tools, the protected-read fence',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delo-sandbox-protected-reads',
    scenarioState: 'pending recording',
    // The sandbox row's protected home decides the refusal: Delo's composition sets it, and the parity composition
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
    registeredBy: '@delo/bundle-local, its delo-update-gate row',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delo-update-turn-refusal',
    scenarioState: 'pending recording',
    field: {
      module: '@delo/bundle-local/update-gate',
      source: 'delo/packages/bundle-local/src/update-gate.ts',
      key: 'enabled',
    },
    // The plugin registers its `agent/pre-step` listener behind the switch: off,
    // it mounts no service and no listener, so every turn starts as upstream's.
    sources: ['delo/packages/bundle-local/src/update-gate.ts'],
  },
  {
    id: 'one_time_launch_tokens',
    state: 'built',
    registeredBy: 'Delo edit of upstream\'s connection, which @delo/bundle-local mounts with the switch on',
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
    registeredBy: '@delo/bundle-local, its workspace-controller row, which `delorun start` fills',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'web/delo-default-workspace-directory',
    scenarioState: 'pending recording',
    // The workspace controller row's folder decides where the first-use workspace lies: Delo's composition sets it, and
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
] as const satisfies readonly ParitySwitchEntry[]

/** One registry entry, as declared. */
export type ParitySwitch = (typeof PARITY_SWITCHES)[number]

/** Identifier of a registry entry; the union of every `id` in {@link PARITY_SWITCHES}. */
export type ParitySwitchId = ParitySwitch['id']
