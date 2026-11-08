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
 * The validated Config field that holds a built switch. Its JSDoc names the switch as `C16 switch \`<id>\``, and its
 * schema default is the switch's parity value.
 */
export interface ParitySwitchField {
  /** The module a `cordis.yml` row names to mount the plugin, such as `@deepseek-ai/dsh-plugin-manager/tools`. */
  readonly module: string
  /** Repository path of that module's source, which declares the `Config` interface and schema. */
  readonly source: string
  /** The Config key. */
  readonly key: string
}

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
 * The registry: one entry per model-visible Delo change, plus the doctor's feature switch. `defaultValue` applies in
 * Delo's default composition and `parityValue` applies in the parity composition.
 */
export const PARITY_SWITCHES = [
  {
    id: 'studio_additions',
    state: 'built',
    registeredBy: '@delo/bundle-studio and @delo/plugin-main-chat',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'web/delo-studio-additions',
    field: {
      module: '@delo/plugin-main-chat',
      source: 'delo/packages/plugin-main-chat/src/index.ts',
      key: 'studioAdditions',
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
    id: 'plugin_manager_read_exemption',
    state: 'built',
    registeredBy: 'Delo edit of upstream plugin_manager tool',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delo-plugin-manager-read-exemption',
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
    registeredBy: 'Delo edit of upstream fs search tools, the protected-read fence',
    defaultValue: true,
    parityValue: false,
    modelVisible: true,
    scenario: 'session/delo-sandbox-protected-reads',
    field: {
      module: '@deepseek-ai/dsh-tool-fs-search',
      source: 'packages/fs/tool-fs-search/src/index.ts',
      key: 'protectedReads',
    },
    sources: [
      'packages/fs/tool-fs-search/src/glob.ts',
      'packages/fs/tool-fs-search/src/grep.ts',
    ],
  },
] as const satisfies readonly ParitySwitchEntry[]

/** One registry entry, as declared. */
export type ParitySwitch = (typeof PARITY_SWITCHES)[number]

/** Identifier of a registry entry; the union of every `id` in {@link PARITY_SWITCHES}. */
export type ParitySwitchId = ParitySwitch['id']
