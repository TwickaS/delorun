/**
 * The model-facing `preset_inspect` tool: which presets (modes) the profile
 * offers, which plugin rows one composes, and, for the calling Agent's own
 * preset, the skills it mounts with each skill's discovery source and
 * provider. It reads the registry's roster and composition inventory and the
 * mounted `skills` service; it changes nothing.
 *
 * The tool is registered only when the `presetInspect` Config switch is on. The
 * switch is Delorun's C16 switch `preset_inspect`, off in the parity composition.
 * @module @deepseek-ai/dsh-agent-preset-registry/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from './index.ts'
import type { AgentPresetComposition, CompositionRowEnablement } from './composition-inventory.ts'

/** Required services. `skills` is optional: a preset without skill rows lists none. */
export const inject = ['tools', 'agentPresets']

/** The module's switch. */
export interface Config {
  /**
   * Register `preset_inspect`. This is Delorun's C16 switch `preset_inspect`, off in the parity composition, where the
   * model sees the stock tool list.
   */
  presetInspect?: boolean
}

/** Validates the module's switch; it defaults to off. */
export const Config: z<Config> = z.object({
  presetInspect: z.boolean().default(false),
})

/** One preset in the roster answer. */
interface RosterEntry {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly isDefault: boolean
  readonly current: boolean
  readonly broken?: string
}

/** One skill the calling Agent's preset mounts. */
interface SkillEntry {
  readonly name: string
  readonly description: string
  readonly source: string
  readonly provider: string
}

/** The answer for one named preset. */
interface PresetEntry {
  readonly id: string
  readonly current: boolean
  readonly broken?: string
  readonly rows: readonly { readonly entryId: string | null; readonly moduleName: string; readonly enabled: CompositionRowEnablement }[]
  /** Present only for the calling Agent's own preset, whose skills are mounted. */
  readonly skills?: readonly SkillEntry[]
}

type InspectValue = { readonly kind: 'roster'; readonly presets: readonly RosterEntry[] } | ({ readonly kind: 'preset' } & PresetEntry)

/**
 * A row's enablement as a suffix.
 * @param enabled - the row's effective enablement.
 * @returns nothing for an enabled row, otherwise the state in parentheses.
 */
function enablementText(enabled: CompositionRowEnablement): string {
  return enabled === true ? '' : enabled === false ? ' (disabled)' : ' (conditional)'
}

/**
 * Render the value as the model reads it.
 * @param value - the tool's value.
 * @returns one line per preset, or the preset's rows then its skills.
 */
function render(value: InspectValue): string {
  if (value.kind === 'roster') {
    return value.presets.map((preset) => {
      const marks = [preset.isDefault ? 'default' : undefined, preset.current ? 'current' : undefined, preset.broken === undefined ? undefined : `broken: ${preset.broken}`].filter(mark => mark !== undefined)
      const title = [preset.name, preset.description].filter(part => part !== undefined).join(': ')
      return `${preset.id}${marks.length === 0 ? '' : ` (${marks.join(', ')})`}${title === '' ? '' : ` — ${title}`}`
    }).join('\n')
  }
  const lines = [`preset ${value.id}${value.current ? ' (current)' : ''}${value.broken === undefined ? '' : ` — broken: ${value.broken}`}`]
  lines.push('rows:', ...value.rows.length === 0 ? ['  (none)'] : value.rows.map(row => `  ${row.entryId ?? '(no id)'} ${row.moduleName}${enablementText(row.enabled)}`))
  if (value.skills === undefined) lines.push('skills: listed only for the current preset, whose skills are mounted')
  else lines.push('skills:', ...value.skills.length === 0 ? ['  (none)'] : value.skills.map(skill => `  ${skill.name} [${[...new Set([skill.source, skill.provider])].join(', ')}] — ${skill.description}`))
  return lines.join('\n')
}

/**
 * The skills the calling Agent's preset mounts.
 * @param ctx - the tool's context, inside that preset's scope.
 * @param agent - the calling Agent.
 * @param signal - the tool call's cancellation.
 * @returns each skill's name, description, discovery source and provider.
 */
async function mountedSkills(ctx: Context, agent: Agent, signal: AbortSignal): Promise<SkillEntry[]> {
  const skills = ctx.get('skills')
  if (skills === undefined) return []
  const cwd = await ctx.get('workingDirectory')?.ensure(agent, signal)
  const listed = await skills.list({ cwd, signal, scope: agent })
  return listed.map(skill => ({ name: skill.name, description: skill.description, source: skill.source, provider: skill.provider }))
}

/**
 * Register `preset_inspect` when the `presetInspect` switch is on; with it off, register nothing.
 * @param ctx - context carrying the tool registry and the preset registry.
 * @param config - the module's switch.
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.presetInspect !== true) return
  ctx.tools.register(defineTool({
    name: 'preset_inspect',
    description: 'Inspect the modes (presets) this harness offers without changing anything. No arguments: every preset, with the default and the current one marked. '
      + '`preset`: that preset\'s plugin rows, and, for the current preset, the skills it mounts with each skill\'s source and provider. '
      + 'Another preset\'s skills load only in that preset.',
    parameters: {
      preset: { type: 'string', description: 'A preset id from the roster.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, text) => [{ type: 'text', text }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('preset_inspect requires a calling agent (exec.agent was undefined)')
      const registry = ctx.agentPresets
      // The revision the Agent joined, which a session that records no choice still has.
      const current = registry.inspectCompositions(agent.ctx)[0]?.id ?? registry.presetForSession(agent.session)
      if (args.preset === undefined) {
        const [presets, inventory] = await Promise.all([registry.list(), registry.compositionInventory()])
        const defaults = new Set(inventory.filter(composition => composition.isDefault).map(composition => composition.id))
        return render({
          kind: 'roster',
          presets: presets.map(preset => ({
            id: preset.id,
            ...preset.name === undefined ? {} : { name: preset.name },
            ...preset.description === undefined ? {} : { description: preset.description },
            isDefault: defaults.has(preset.id),
            current: preset.id === current,
            ...preset.broken === undefined ? {} : { broken: preset.broken },
          })),
        })
      }
      const inventory = await registry.compositionInventory()
      const composition: AgentPresetComposition | undefined = inventory.find(entry => entry.id === args.preset)
      if (composition === undefined) throw new Error(`no preset named "${args.preset}"; call preset_inspect with no arguments for the roster`)
      const own = composition.id === current
      return render({
        kind: 'preset',
        id: composition.id,
        current: own,
        ...composition.broken === undefined ? {} : { broken: composition.broken },
        rows: composition.rows.map(row => ({ entryId: row.entryId, moduleName: row.moduleName, enabled: row.enabled })),
        ...own ? { skills: await mountedSkills(ctx, agent, exec.signal) } : {},
      })
    },
  }))
}
