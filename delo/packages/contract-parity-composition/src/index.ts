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

/**
 * The registry: one entry per model-visible Delo change. `defaultValue` applies in
 * Delo's default composition and `parityValue` applies in the parity composition.
 * `true` means the switch is on, which leaves the change active.
 */
export const PARITY_SWITCHES = [
  {
    id: 'studio_additions',
    registeredBy: '@delo/bundle-studio and @delo/plugin-main-chat',
    defaultValue: true,
    parityValue: false,
    scenario: 'delo-studio-additions',
  },
  {
    id: 'permission_defaults',
    registeredBy: '@delo/plugin-permission-defaults',
    defaultValue: true,
    parityValue: false,
    scenario: 'delo-permission-defaults',
  },
  {
    id: 'fetch_guard',
    registeredBy: '@delo/plugin-fetch-guard',
    defaultValue: true,
    parityValue: false,
    scenario: 'delo-fetch-guard',
  },
  {
    id: 'preset_inspect',
    registeredBy: 'Delo edit of upstream preset tools',
    defaultValue: true,
    parityValue: false,
    scenario: 'delo-preset-inspect',
  },
  {
    id: 'doctor',
    registeredBy: 'delo/apps/cli/src/doctor',
    defaultValue: true,
    parityValue: false,
    scenario: 'delo-doctor',
  },
  {
    id: 'plugin_manager_read_exemption',
    registeredBy: 'Delo edit of upstream plugin_manager tool',
    defaultValue: true,
    parityValue: false,
    scenario: 'delo-plugin-manager-read-exemption',
  },
  {
    id: 'profile_history',
    registeredBy: 'Delo edit of upstream plugin_manager tool',
    defaultValue: true,
    parityValue: false,
    scenario: 'delo-profile-history',
  },
  {
    id: 'scheduled_task_consent',
    registeredBy: 'Delo edit of upstream schedule tools',
    defaultValue: true,
    parityValue: false,
    scenario: 'delo-scheduled-task-consent',
  },
  {
    id: 'instruction_layer_consent',
    registeredBy: 'Delo approval for instruction-layer files',
    defaultValue: true,
    parityValue: false,
    scenario: 'delo-instruction-layer-consent',
  },
  {
    id: 'mcp_add_consent',
    registeredBy: 'Delo MCP server add flow',
    defaultValue: true,
    parityValue: false,
    scenario: 'delo-mcp-add-consent',
  },
  {
    id: 'container_denial_marker',
    registeredBy: 'Delo edit of upstream container denial reporting',
    defaultValue: true,
    parityValue: false,
    scenario: 'delo-container-denial-marker',
  },
] as const

/** One registry entry. */
export type ParitySwitch = (typeof PARITY_SWITCHES)[number]

/** Identifier of a registry entry; the union of every `id` in {@link PARITY_SWITCHES}. */
export type ParitySwitchId = ParitySwitch['id']
