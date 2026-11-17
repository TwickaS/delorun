/**
 * The "What agents may do on their own" card of Settings → Safety → External agents: one level for Claude Code and one
 * for Codex, chosen from four radio options with a one-line plain description each. A remote studio may only tighten:
 * a level looser than the saved one is disabled there and says it needs the home's own computer, as the home enforces.
 * When Claude Code's command sandbox cannot run on this computer, the card names the missing tools, the install line and
 * the level it affects, as a plain note.
 */
import type { ReactNode } from 'react'
import { AGENT_LEVELS, type AgentLevel, type AgentLevelView } from '@delorun/plugin-delegation-consent/wire'
import { SettingsCard } from '@delorun/settings-controls'
import type { Translate } from './ConsentListing.tsx'
import css from './ConsentSections.module.css'

/** The settings field that holds each agent's level. */
const FIELDS = { 'claude-code': 'claudeCodeLevel', codex: 'codexLevel' } as const

/** The level names a surface shows, by level. */
const TITLES = { careful: 'levels.careful.title', standard: 'levels.standard.title', own: 'levels.own.title', unrestricted: 'levels.unrestricted.title' } as const
const DESCRIPTIONS = {
  careful: 'levels.careful.description', standard: 'levels.standard.description', own: 'levels.own.description', unrestricted: 'levels.unrestricted.description',
} as const

/**
 * The missing tools as one phrase: `socat`, or `bubblewrap and socat`.
 * @param t - the copy.
 * @param tools - the missing tools' names.
 * @returns the phrase.
 */
function toolList(t: Translate, tools: readonly string[]): string {
  return tools.length < 2 ? tools.join('') : `${tools.slice(0, -1).join(', ')}${t('levels.noSandbox.and')}${tools.at(-1)!}`
}

/**
 * The words a chip shows for a level: its name, with ` · no sandbox` while the level promises a command sandbox this
 * computer lacks.
 * @param t - the copy.
 * @param view - the agent's level.
 * @returns the chip text.
 */
export function levelChipText(t: Translate, view: Pick<AgentLevelView, 'level' | 'sandboxMissing'>): string {
  const name = t(TITLES[view.level])
  return view.sandboxMissing === undefined ? name : t('levels.chip.noSandbox', { level: name })
}

/**
 * Render the card.
 * @param props - the copy, the saved levels, the extra facts about the sandbox, whether the studio is remote, whether a
 *   write is under way or impossible, and the writer.
 * @returns the card.
 */
export function AgentLevels({ t, saved, views, remote, disabled, set }: {
  readonly t: Translate
  readonly saved: Readonly<Record<'claudeCodeLevel' | 'codexLevel', AgentLevel>>
  readonly views: readonly AgentLevelView[]
  readonly remote: boolean
  readonly disabled: boolean
  readonly set: (field: 'claudeCodeLevel' | 'codexLevel', level: AgentLevel) => Promise<void>
}): ReactNode {
  return <SettingsCard title={t('levels.heading')} description={t('levels.description')} group="external-agent-levels">
    <ul className={css.list} data-agent-levels="">
      {(['claude-code', 'codex'] as const).map((provider) => {
        const field = FIELDS[provider]
        const current = saved[field]
        const view = views.find(entry => entry.provider === provider)
        const missing = view?.sandboxMissing
        const name = provider === 'codex' ? 'Codex' : 'Claude Code'
        return <li key={provider} className={css.row} data-agent={provider}>
          <fieldset className={css.levelGroup} disabled={disabled}>
            <legend className={css.title}>{name}</legend>
            {AGENT_LEVELS.map((level) => {
              const locked = remote && AGENT_LEVELS.indexOf(level) > AGENT_LEVELS.indexOf(current)
              const title = level === 'own' ? t('levels.own.agentTitle', { agent: name }) : t(TITLES[level])
              return <label key={level} className={css.levelOption} title={locked ? t('levels.computerOnly') : undefined}>
                <input type="radio" name={`level-${provider}`} value={level} checked={current === level} disabled={locked}
                  onChange={() => { void set(field, level) }} />
                <span className={css.levelText}><strong>{title}</strong>{' — '}{t(DESCRIPTIONS[level], { agent: name })}</span>
              </label>
            })}
            {remote ? <p className={css.description}>{t('levels.computerOnly')}</p> : null}
            {missing !== undefined
              ? <p className={css.boxLine} role="status" data-sandbox-missing="">
                {t('levels.noSandbox.needs', { tools: toolList(t, missing.tools) })} <code>{missing.installCommand}</code>. {t(current === 'careful' ? 'levels.noSandbox.careful' : 'levels.noSandbox.standard')}
              </p>
              : null}
          </fieldset>
        </li>
      })}
    </ul>
    <p className={css.boxLine}>{t('levels.mcp')}</p>
  </SettingsCard>
}
