/**
 * Which steps the dialog shows, and in which order: the built-in steps that apply, with the steps other plugins added
 * between Phone access and Workspace. Browser follows Recommended plugins while its pack is offered or added.
 */
import type { ReactNode } from 'react'
import type { DeferrableStep, SetupRecord } from '../wire.ts'
import { BROWSER_BUNDLE } from '@delorun/browser-setup'
import type { Guide, PhoneOutcome } from './guide.ts'
import { AgentsStep } from './steps/Agents.tsx'
import { BrowserStep } from './steps/Browser.tsx'
import { LookStep } from './steps/Look.tsx'
import { ComputerOnlyStep } from './steps/ComputerOnly.tsx'
import { PinStep } from './steps/Pin.tsx'
import { ModelsStep } from './steps/Models.tsx'
import { PluginsStep } from './steps/Plugins.tsx'
import { ReachStep } from './steps/Reach.tsx'
import { ReadyStep } from './steps/Ready.tsx'
import { WelcomeStep } from './steps/Welcome.tsx'
import { WorkspaceStep } from './steps/Workspace.tsx'
import type { NoticeFace, OnboardingStep, ReachState, StartTarget, StepServices } from './types.ts'

/** One step of the flow, built-in or added by a plugin. */
export interface FlowStep {
  /** Unique among the steps. */
  readonly id: string
  /** Its place, ascending. */
  readonly order: number
  /** Its name in the list of steps and its heading. */
  readonly title: () => string
  /**
   * Draw its body.
   * @param next - go on to the next step, or finish after the last.
   * @param back - go back to the previous step.
   * @returns the body.
   */
  readonly render: (next: () => void, back: () => void) => ReactNode
  /** Skip's label where "Skip step" does not say what happens; absent means "Skip step". */
  readonly skipLabel?: () => string
  /** Continue's label where "Continue" does not say what happens; absent means "Continue". */
  readonly continueLabel?: () => string
  /** Runs when the person presses Continue, before the flow moves on. */
  readonly onContinue?: () => void
  /** Runs when the person presses Skip, before the flow moves on. */
  readonly onSkip?: () => void
}

/** The built-in steps' ids and places. */
export const STEPS = {
  welcome: { id: 'welcome', order: 100 },
  providers: { id: 'providers', order: 150 },
  look: { id: 'look', order: 200 },
  agents: { id: 'agents', order: 300 },
  plugins: { id: 'plugins', order: 400 },
  browser: { id: 'browser', order: 450 },
  reach: { id: 'reach', order: 500 },
  pin: { id: 'pin', order: 550 },
  workspace: { id: 'workspace', order: 1000 },
  ready: { id: 'ready', order: 1100 },
} as const

/** What decides the list. */
export interface FlowInput {
  /** The services the built-in steps draw with. */
  readonly services: StepServices
  /** The guide's shared state. */
  readonly guide: Guide
  /** What the terminal setup recorded. */
  readonly record: SetupRecord
  /** The steps other plugins added. */
  readonly extra: readonly OnboardingStep[]
  /** Whether the home has reach and it is set up; the Phone access step shows only while it is `off`. */
  readonly reach: ReachState
  /** What the person did on Phone access; `on` adds the PIN step when the Phone access step turned reach on. */
  readonly phone: PhoneOutcome
  /** The studio's address over Tailscale, which Welcome shows at the computer while device access is on; absent when it is not known. */
  readonly deviceAddress?: string | undefined
  /** Where the chat opens without a choice. */
  readonly target: StartTarget
  /** The preview notice when it is owed: it exists, this browser has not acknowledged it and onboarding was not reopened. Continuing from Welcome acknowledges it. */
  readonly notice: NoticeFace | undefined
  /** Whether the guide was opened again: the workspace the chat is in stays unless the person chooses another. */
  readonly keepCurrent: boolean
  /** Whether PIN mode is known to be on; a phone's PIN step is left out then. */
  readonly pinOn?: boolean
  /** Whether the Browser plugin pack is in the profile and loaded; the Browser step then shows even where the guide does not offer the pack. */
  readonly browserAdded?: boolean
  /**
   * Whether this is the first open of the studio, where the guide is short: Welcome, Models, Workspace only without a default workspace,
   * the PIN step where phone access is set up, and Ready. False for the guide opened from Settings, which builds every step.
   */
  readonly first: boolean
  /** The deferred steps to show alone, from the Finish setup entry at the computer; absent shows the whole guide. */
  readonly only?: readonly DeferrableStep[]
}

/**
 * Build the ordered steps.
 * @param input - the services and what decides which steps apply.
 * @returns the steps, ascending by order.
 */
export function buildSteps({ services, guide, record, extra, reach, phone, deviceAddress, target, notice, keepCurrent, first, pinOn = false, browserAdded = false, only }: FlowInput): FlowStep[] {
  const { t, plugins, optionalRows } = services
  if (only !== undefined) return deferredSteps({ services, guide, only })
  const covered = (id: string): boolean => record.sections?.includes(id) === true
  const props = { services, guide }
  const built: FlowStep[] = [{ ...STEPS.welcome, title: () => t('step.welcome'), render: () => <WelcomeStep {...props} notice={notice} deviceAddress={reach === 'set-up' ? deviceAddress : undefined} />, ...notice === undefined ? {} : { onContinue: notice.acknowledge } }]
  built.push({ ...STEPS.providers, title: () => t('step.providers'), render: (next, back) => <ModelsStep {...props} next={next} back={back} remote={reach === 'remote'} pinOn={pinOn} /> })
  // The first open leaves out Look, Agents, Recommended plugins, Browser and Phone access: Settings holds them and the full guide shows them.
  if (!first) {
    if (!covered(STEPS.look.id)) built.push({ ...STEPS.look, title: () => t('step.look'), render: next => <LookStep {...props} next={next} /> })
    if (!covered(STEPS.agents.id)) built.push({ ...STEPS.agents, title: () => t('step.agents'), render: () => <AgentsStep {...props} /> })
    // The Browser pack has its own step, so it alone does not make Recommended plugins worth showing.
    if ((plugins.some(name => name !== BROWSER_BUNDLE) || optionalRows.length > 0) && !covered(STEPS.plugins.id)) built.push({ ...STEPS.plugins, title: () => t('step.plugins'), render: () => <PluginsStep {...props} /> })
    // Browser has its own step where the plugins step offers its pack, or the pack is already in the profile.
    const browserOffered = plugins.includes(BROWSER_BUNDLE) && !covered(STEPS.plugins.id)
    if (browserOffered || browserAdded) built.push({ ...STEPS.browser, title: () => t('step.browser'), render: () => <BrowserStep {...props} /> })
    // A studio opened from a phone is already on one, so it has no Phone access step.
    if (reach === 'off' && !record.reachSetUp) built.push({ ...STEPS.reach, title: () => t('step.reach'), continueLabel: () => { const read = guide.readiness.getSnapshot(); return read.status === 'ready' && read.value.tailscale.state === 'ready' ? t('continue') : t('reach.done') }, onSkip: () => { guide.setPhone('skipped') }, onContinue: () => { void services.host.reach().then((now) => { guide.setPhone(now === 'set-up' ? 'on' : 'done') }) }, render: () => <ReachStep {...props} /> })
  }
  // The PIN step is for the home's own computer with phone access on: reach was already set up, or the Phone access step just found it on.
  if ((reach === 'set-up' && !(first && pinOn)) || (reach === 'off' && phone === 'on')) built.push({ ...STEPS.pin, title: () => t('step.pin'), render: () => <PinStep {...props} /> })
  // A phone cannot set the PIN, so it says so and offers to leave it for the computer; a step already deferred or already done is left out.
  if (reach === 'remote' && !pinOn && record.deferred?.includes('pin') !== true) {
    built.push({
      ...STEPS.pin, title: () => t('computer.title.pin'), continueLabel: () => t('computer.defer'),
      onContinue: () => { void services.host.defer('pin', true) },
      render: () => <ComputerOnlyStep services={services} id="pin" />,
    })
  }
  // A first open needs the Workspace step only where there is no default workspace for the first chat to open in.
  if (!first || target.kind === 'none') built.push({ ...STEPS.workspace, title: () => t('step.workspace'), render: () => <WorkspaceStep {...props} target={target} keepCurrent={keepCurrent} /> })
  built.push(
    { ...STEPS.ready, title: () => t('step.ready'), render: () => <ReadyStep {...props} reach={record.reachSetUp || reach === 'remote' ? 'set-up' : reach} target={target} keepCurrent={keepCurrent} first={first} /> },
  )
  const added = extra.map((step): FlowStep => ({ id: step.id, order: step.order, title: step.title, render: next => { const Body = step.component; return <Body next={next} /> } }))
  return [...built, ...added].sort((a, b) => a.order - b.order)
}

/**
 * The steps the Finish setup entry at the computer shows: only the deferred ones. The entry drops a step whose work is
 * done when the dialog closes.
 * @param input - the services, the guide and the deferred steps to show.
 * @returns the steps, ascending by order.
 */
function deferredSteps({ services, guide, only }: Pick<FlowInput, 'services' | 'guide'> & { readonly only: readonly DeferrableStep[] }): FlowStep[] {
  const { t } = services
  const props = { services, guide }
  const built: FlowStep[] = []
  if (only.includes('reach')) {
    built.push({
      ...STEPS.reach, title: () => t('step.reach'), skipLabel: () => t('reach.notNow'), continueLabel: () => t('reach.done'),
      render: () => <ReachStep {...props} />,
    })
  }
  if (only.includes('pin')) built.push({ ...STEPS.pin, title: () => t('step.pin'), render: () => <PinStep {...props} /> })
  return built
}

/**
 * The deferred steps that have a screen: a deferred step the guide never draws has nothing to open.
 * @param deferred - the deferred step ids.
 * @returns those with a step, in the guide's order.
 */
export function withSteps(deferred: readonly DeferrableStep[]): DeferrableStep[] {
  return (['reach', 'pin'] as const).filter(id => deferred.includes(id))
}
