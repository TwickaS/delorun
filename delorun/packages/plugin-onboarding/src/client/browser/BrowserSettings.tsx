/**
 * The Settings Browser page: whether agents may use a web browser, the status of the built-in browser in plain words
 * with the action that fixes what it needs, a test that opens a fixed page and shows its thumbnail without a model turn,
 * and where the person's own Chrome stands. Browser is on until the person turns it off ({@link useBrowser}).
 * @module @delorun/plugin-onboarding/client/browser/BrowserSettings
 */
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { type BrowserFailure, type BrowserPageState } from '@delorun/browser-setup'
import { BrowserCommand } from '@delorun/browser-setup/client'
import { SettingRow, SettingsCard } from '@delorun/brand'
import type { BrowserInstallAnswer, BrowserTestAnswer } from '@delorun/bundle-local/browser-check-api'
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { StepServices } from '../types.ts'
import { useBrowser } from './use-browser.ts'
import css from './BrowserSettings.module.css'

/** What the page reaches. */
export interface BrowserSettingsInjected {
  /** The installer, the Browser face and whether the studio is a phone. */
  readonly services: Pick<StepServices, 'bundles' | 'browser' | 'remote'>
  /** Open Plugins, where the own-Chrome pack is finished. */
  readonly openPlugins: () => void
}

/** The props of the page. */
export type BrowserSettingsProps = PropsLocale<'delorunOnboarding'> & InjectFace<BrowserSettingsInjected>

/** The marks of a line's tones. */
const MARKS = { loading: '…', success: '✓', warning: '!', error: '✕', info: 'i' } as const

/**
 * One status line: a mark and a message, under the control it describes.
 * @param props - the tone and the message.
 * @returns the line.
 */
function Line({ tone, children }: { readonly tone: keyof typeof MARKS; readonly children: ReactNode }): ReactNode {
  return (
    <div className={css.line} data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      <span className={css.mark} aria-hidden="true">{MARKS[tone]}</span>
      <span className={css.lineText}>{children}</span>
    </div>
  )
}

/** The page's translate function. */
type T = BrowserSettingsProps['t']

/**
 * The plain words for a failure to add Browser.
 * @param t - the page's translate function.
 * @param failure - the cause.
 * @returns the sentence.
 */
function failureText(t: T, failure: BrowserFailure): string {
  switch (failure.cause) {
    case 'offline': return t('page.status.offline')
    case 'unavailable': return failure.reason === undefined ? t('page.status.unavailable') : t('page.status.unavailable.why', { reason: failure.reason })
    case 'failed': return failure.reason === undefined ? t('page.status.failed') : t('page.status.failed.why', { reason: failure.reason })
    case 'unread': return t('page.status.unread')
    case 'problem': return t('page.status.problem', { message: failure.message })
    /* v8 ignore next 2 -- closed-union default only defends a future widening of BrowserFailure */
    default: return assertNever(failure)
  }
}

/**
 * Close a union the compiler has narrowed to nothing.
 * @param value - the value that cannot occur.
 * @returns never.
 * @throws always.
 */
/* v8 ignore next 3 -- reached only when a union widens without its switch */
function assertNever(value: never): never {
  throw new Error(`unhandled Browser page state ${JSON.stringify(value)}`)
}

/** Whether a fix is the download of the Chromium build, which the Host runs for the person. */
const isDownload = (state: BrowserPageState): boolean =>
  state.kind === 'needs-setup' && state.fix.kind === 'command' && /\binstall-browser chromium$/u.test(state.fix.command)

/** What the test and the download are doing. */
type Run<T> = { readonly kind: 'idle' } | { readonly kind: 'running' } | { readonly kind: 'done'; readonly answer: T }

/**
 * The status of the built-in browser, and under it the action that fixes what it needs.
 * @param props - the state and the page's actions.
 * @returns the status block.
 */
function Status({ t, state, remote, download, onDownload, onRetry }: {
  readonly t: T
  readonly state: BrowserPageState
  readonly remote: boolean
  readonly download: Run<BrowserInstallAnswer>
  readonly onDownload: () => void
  readonly onRetry: () => void
}): ReactNode {
  const asking = (
    <div className={css.actions}>
      <Button variant="outline" size="sm" className={css.button} onClick={onRetry}>{t('page.retry')}</Button>
    </div>
  )
  switch (state.kind) {
    case 'off': return <Line tone="info">{t('page.status.off')}</Line>
    case 'checking': return <Line tone="loading">{t('page.status.checking')}</Line>
    case 'installing': return <Line tone="loading">{state.slow ? t('page.status.slow') : t('page.status.installing')}</Line>
    case 'restart': return <Line tone="info">{t('page.status.restart')}</Line>
    case 'ready': return <Line tone="success">{t('page.status.ready')}</Line>
    case 'failed': return <><Line tone="error">{failureText(t, state.failure)}</Line>{asking}</>
    case 'needs-setup': {
      const failed = download.kind === 'done' && !download.answer.ok ? download.answer.message : undefined
      return (
        <>
          <Line tone="warning">{t('page.status.needs', { reason: state.reason })}</Line>
          {download.kind === 'running' && <Line tone="loading">{t('page.download.running')}</Line>}
          {failed !== undefined && <Line tone="error">{t('page.download.failed', { message: failed })}</Line>}
          {isDownload(state) && download.kind !== 'running' && !remote && (
            <>
              <p className={css.hint}>{t('page.download.text')}</p>
              <div className={css.actions}>
                <Button variant="primary" size="sm" className={css.button} onClick={onDownload}>{t('page.download')}</Button>
              </div>
            </>
          )}
          {state.fix.kind === 'command' && <BrowserCommand command={state.fix.command} t={t} />}
        </>
      )
    }
    /* v8 ignore next 2 -- closed-union default only defends a future widening of BrowserPageState */
    default: return assertNever(state)
  }
}

/**
 * The test button and what it found.
 * @param props - the test's state and action.
 * @returns the block.
 */
function Test({ t, ready, remote, run, onTest }: {
  readonly t: T
  readonly ready: boolean
  readonly remote: boolean
  readonly run: Run<BrowserTestAnswer>
  readonly onTest: () => void
}): ReactNode {
  return (
    <div className={css.block}>
      <p className={css.hint}>{remote ? t('page.test.atComputer') : t('page.test.text')}</p>
      <div className={css.actions}>
        <Button variant="outline" size="sm" className={css.button} disabled={!ready || remote || run.kind === 'running'} onClick={onTest}>{t('page.test')}</Button>
      </div>
      {run.kind === 'running' && <Line tone="loading">{t('page.test.running')}</Line>}
      {run.kind === 'done' && run.answer.ok && (
        <>
          <Line tone="success">{t('page.test.ok')}</Line>
          <img className={css.thumbnail} src={run.answer.image} alt={t('page.test.alt')} />
        </>
      )}
      {run.kind === 'done' && !run.answer.ok && <Line tone="error">{t('page.test.failed', { message: run.answer.message })}</Line>}
    </div>
  )
}

/**
 * The page.
 * @param props - this plugin's copy and the services.
 * @returns the page.
 */
export function BrowserSettings({ t, services, openPlugins }: BrowserSettingsProps): ReactNode {
  const { browser, bundles, remote } = services
  const b = useBrowser(services)
  const [test, setTest] = useState<Run<BrowserTestAnswer>>({ kind: 'idle' })
  const [download, setDownload] = useState<Run<BrowserInstallAnswer>>({ kind: 'idle' })
  const runTest = (): void => {
    setTest({ kind: 'running' })
    void browser.test().then((answer) => { setTest({ kind: 'done', answer }) })
  }
  const runDownload = (): void => {
    setDownload({ kind: 'running' })
    void browser.download().then((answer) => {
      setDownload({ kind: 'done', answer })
      // The check reads the computer afresh, so a finished download clears the need.
      if (answer.ok) b.recheck()
    })
  }
  const adding = b.view?.state === 'installing' || b.view?.state === 'slow'
  const ownAvailable = b.ownView?.state === 'available' && b.ownReadiness.kind === 'not-added'
  return (
    <div className={css.page}>
      <h2 className={css.title}>{t('page.title')}</h2>
      <SettingsCard title={t('page.card.built')} description={t('page.card.built.text')} group="browser">
        <SettingRow title={t('page.switch.title')} description={remote ? t('page.switch.remote') : t('page.switch.text')}
          failure={b.result.kind === 'failed' ? t('page.switch.failed') : undefined}>
          <Switch checked={b.choice === 'on'} label={t('page.switch.title')} disabled={b.working || adding || remote}
            onChange={(on) => { void (on ? b.turnOn() : b.turnOff()) }} />
        </SettingRow>
        <div className={css.block}>
          <Status t={t} state={b.state} remote={remote} download={download} onDownload={runDownload} onRetry={b.state.kind === 'failed' ? b.retry : b.recheck} />
        </div>
        {b.choice === 'on' && <Test t={t} ready={b.state.kind === 'ready'} remote={remote} run={test} onTest={runTest} />}
      </SettingsCard>
      <SettingsCard title={t('page.own.title')} description={t('page.own.text')} group="own-browser">
        <div className={css.block}>
          {b.ownReadiness.kind === 'ready' && <Line tone="success">{t('page.own.ready')}</Line>}
          {b.ownReadiness.kind === 'needs-setup' && <Line tone="warning">{t('page.own.needs', { reason: b.ownReadiness.reason })}</Line>}
          {b.ownReadiness.kind === 'problem' && <Line tone="error">{t('page.status.problem', { message: b.ownReadiness.message })}</Line>}
          {b.ownReadiness.kind === 'not-added' && <OwnPack t={t} view={b.ownView} />}
          <div className={css.actions}>
            {ownAvailable && !remote && <Button variant="primary" size="sm" className={css.button} onClick={() => { void bundles.install('@delorun/bundle-real-browser') }}>{t('page.own.add')}</Button>}
            {(b.ownReadiness.kind === 'needs-setup' || b.ownReadiness.kind === 'ready') && (
              <Button variant="outline" size="sm" className={css.button} onClick={openPlugins}>{t('page.own.plugins')}</Button>
            )}
          </div>
        </div>
      </SettingsCard>
    </div>
  )
}

/**
 * Where adding the own-Chrome pack stands while the Host does not list it, in the words the Browser step uses for packs.
 * @param props - the pack's view.
 * @returns the line, or nothing while there is nothing to say.
 */
function OwnPack({ t, view }: { readonly t: T; readonly view: ReturnType<typeof useBrowser>['ownView'] }): ReactNode {
  switch (view?.state ?? 'checking') {
    case 'checking': return <Line tone="loading">{t('bundle.checking')}</Line>
    case 'installing': return <Line tone="loading">{t('bundle.adding')}</Line>
    case 'slow': return <Line tone="loading">{t('bundle.slow')}</Line>
    case 'offline': return <Line tone="info">{t('bundle.offline')}</Line>
    case 'unavailable': return <Line tone="warning">{view?.packsReason === undefined ? t('bundle.unavailable') : t('bundle.unavailableWhy', { reason: view.packsReason })}</Line>
    case 'failed': return <Line tone="error">{view?.reason === undefined ? t('bundle.failed') : t('bundle.failedWhy', { reason: view.reason })}</Line>
    case 'restart': return <Line tone="info">{t('bundle.restart')}</Line>
    case 'available':
    case 'installed': return null
    /* v8 ignore next 2 -- closed-union default only defends a future widening of BundleState */
    default: return null
  }
}
