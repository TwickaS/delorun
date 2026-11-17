/**
 * Which steps the dialog shows, and in which order: the built-in steps that apply, with the steps other plugins added
 * between Phone access and Workspace.
 */
import type { ReactNode } from 'react'
import type { SetupRecord } from '../wire.ts'
import type { Guide, PhoneOutcome } from './guide.ts'
import { AgentsStep } from './steps/Agents.tsx'
import { LookStep } from './steps/Look.tsx'
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
  /** Skip's label where "Skip" does not say what happens; absent means "Skip". */
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
  /** Where the chat opens without a choice. */
  readonly target: StartTarget
  /** The preview notice when it is owed: it exists, this browser has not acknowledged it and onboarding was not reopened. Continuing from Welcome acknowledges it. */
  readonly notice: NoticeFace | undefined
  /** Whether the guide was opened again: the workspace the chat is in stays unless the person chooses another. */
  readonly keepCurrent: boolean
}

/**
 * Build the ordered steps.
 * @param input - the services and what decides which steps apply.
 * @returns the steps, ascending by order.
 */
export function buildSteps({ services, guide, record, extra, reach, phone, target, notice, keepCurrent }: FlowInput): FlowStep[] {
  const { t, plugins, optionalRows } = services
  const covered = (id: string): boolean => record.sections?.includes(id) === true
  const props = { services, guide }
  const built: FlowStep[] = [{ ...STEPS.welcome, title: () => t('step.welcome'), render: () => <WelcomeStep {...props} notice={notice} />, ...notice === undefined ? {} : { onContinue: notice.acknowledge } }]
  built.push({ ...STEPS.providers, title: () => t('step.providers'), render: (next, back) => <ModelsStep {...props} next={next} back={back} /> })
  if (!covered(STEPS.look.id)) built.push({ ...STEPS.look, title: () => t('step.look'), render: next => <LookStep {...props} next={next} /> })
  if (!covered(STEPS.agents.id)) built.push({ ...STEPS.agents, title: () => t('step.agents'), render: () => <AgentsStep {...props} /> })
  if ((plugins.length > 0 || optionalRows.length > 0) && !covered(STEPS.plugins.id)) built.push({ ...STEPS.plugins, title: () => t('step.plugins'), render: () => <PluginsStep {...props} /> })
  // A studio opened from a phone is already on one, so it has no Phone access step.
  if (reach === 'off' && !record.reachSetUp) built.push({ ...STEPS.reach, title: () => t('step.reach'), skipLabel: () => t('reach.notNow'), continueLabel: () => t('reach.done'), onSkip: () => { guide.setPhone('skipped') }, onContinue: () => { void services.host.reach().then((now) => { guide.setPhone(now === 'set-up' ? 'on' : 'done') }) }, render: () => <ReachStep {...props} /> })
  // The PIN step is for the home's own computer with phone access on: reach was already set up, or the Phone access step just found it on.
  if (reach === 'set-up' || (reach === 'off' && phone === 'on')) built.push({ ...STEPS.pin, title: () => t('step.pin'), render: () => <PinStep {...props} /> })
  built.push(
    { ...STEPS.workspace, title: () => t('step.workspace'), render: () => <WorkspaceStep {...props} target={target} keepCurrent={keepCurrent} /> },
    { ...STEPS.ready, title: () => t('step.ready'), render: () => <ReadyStep {...props} reach={record.reachSetUp || reach === 'remote' ? 'set-up' : reach} target={target} keepCurrent={keepCurrent} /> },
  )
  const added = extra.map((step): FlowStep => ({ id: step.id, order: step.order, title: step.title, render: next => { const Body = step.component; return <Body next={next} /> } }))
  return [...built, ...added].sort((a, b) => a.order - b.order)
}
