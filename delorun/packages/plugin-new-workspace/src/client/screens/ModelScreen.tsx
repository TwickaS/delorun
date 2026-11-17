/** Screen 4: the model and thinking level the workspace's new chats start with. */
import { useId } from 'react'
import type { ReactNode } from 'react'
import { DialogFooter } from '../footer.tsx'
import type { ModelPick, Problem } from '../flow.ts'
import type { Translate } from '../locales.ts'
import { selectionOf, type ModelCatalogView, type ModelOption, type ModelsState } from '../models.ts'
import { problemText } from '../problems.ts'
import { ChatsBlock } from './ChatsBlock.tsx'
import css from './screens.module.css'

/** The props of the model screen. */
export interface ModelScreenProps {
  /** This plugin's copy. */
  readonly t: Translate
  /** The catalogue, while it is read, once it was, or that it could not be. */
  readonly models: ModelsState
  /** The model picked; undefined while the workspace follows the home's default. */
  readonly pick: ModelPick | undefined
  /** Whether a request is running. */
  readonly busy: boolean
  /** The reason the last attempt failed. */
  readonly problem: Problem | undefined
  /** Whether Create now is offered. */
  readonly canCreateNow: boolean
  /**
   * Pick a model or a thinking level.
   * @param pick - the pick.
   */
  readonly onPick: (pick: ModelPick) => void
  /** Go on to the safety screen. */
  readonly onContinue: () => void
  /** Create the workspace with the choices made so far. */
  readonly onCreateNow: () => void
  /** Go back to the place screen. */
  readonly onBack: () => void
}

/**
 * The text of one model in the list.
 * @param t - this plugin's copy.
 * @param catalog - the catalogue.
 * @param option - the model.
 * @returns its name, marked when it is the home's default.
 */
function optionLabel(t: Translate, catalog: ModelCatalogView, option: ModelOption): string {
  const isDefault = option.provider === catalog.default.provider && option.id === catalog.default.model
  return isDefault ? t('model.yours', { name: option.name }) : option.name
}

/**
 * The model screen.
 * @param props - the catalogue, the pick and what changes it.
 * @returns the screen.
 */
export function ModelScreen({ t, models, pick, busy, problem, canCreateNow, onPick, onContinue, onCreateNow, onBack }: ModelScreenProps): ReactNode {
  const modelId = useId()
  const effortId = useId()
  const catalog = models.status === 'ready' ? models.catalog : undefined
  const selection = catalog === undefined ? undefined : selectionOf(catalog, pick)
  const options = catalog?.options ?? []
  const index = selection === undefined ? -1 : options.indexOf(selection.option)
  const providers = new Set(options.map(option => option.provider))
  const optionNode = (option: ModelOption, at: number): ReactNode => (
    <option key={`${option.provider}/${option.id}`} value={String(at)}>{catalog === undefined ? option.name : optionLabel(t, catalog, option)}</option>
  )
  return (
    <div className={css.screen}>
      <h3 className={css.question} data-modal-autofocus tabIndex={-1}>{t('model.title')}</h3>
      {models.status === 'loading' && <p className={css.hint} role="status">{t('model.loading')}</p>}
      {models.status === 'unavailable' && <p className={css.hint}>{t('model.unavailable')}</p>}
      {catalog !== undefined && selection !== undefined && (
        <>
          <div className={css.field}>
            <label htmlFor={modelId} className={css.label}>{t('model.model')}</label>
            <select id={modelId} className={css.select} value={String(index)} disabled={busy}
              onChange={(event) => {
                const next = options[Number(event.target.value)]
                if (next !== undefined) onPick({ provider: next.provider, model: next.id, effort: undefined })
              }}>
              {providers.size > 1
                ? [...providers].map(provider => (
                  <optgroup key={provider} label={options.find(option => option.provider === provider)?.providerName ?? provider}>
                    {options.flatMap((option, at) => option.provider === provider ? [optionNode(option, at)] : [])}
                  </optgroup>
                ))
                : options.map(optionNode)}
            </select>
          </div>
          <div className={css.field}>
            <label htmlFor={effortId} className={css.label}>{t('model.thinking')}</label>
            <select id={effortId} className={css.select} value={selection.effort ?? ''} disabled={busy || selection.option.efforts.length === 0}
              onChange={(event) => { onPick({ provider: selection.option.provider, model: selection.option.id, effort: event.target.value }) }}>
              {selection.option.efforts.length === 0 && <option value="">{t('model.noThinking')}</option>}
              {selection.option.efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
            </select>
          </div>
          <p className={css.hint}>{t('model.kept')}</p>
        </>
      )}
      {problem !== undefined && <p className={css.failure} role="alert">{problemText(t, problem)}</p>}
      <ChatsBlock t={t} />
      <DialogFooter back={{ label: t('back'), onClick: onBack, disabled: busy }}
        extra={{ label: t('createNow'), onClick: onCreateNow, disabled: busy || !canCreateNow }}
        primary={{ label: t('continue'), onClick: onContinue, disabled: busy }} />
    </div>
  )
}
