/**
 * Which steps the dialog shows, and in which order: the built-in steps that apply, with the steps other plugins added
 * between Phone access and Workspace.
 */
import type { ReactNode } from 'react'
import type { SetupRecord } from '../wire.ts'
import type { Guide } from './guide.ts'
import { AgentsStep, LookStep, PluginsStep, ReachStep, RemoteReachStep, ReadyStep, WelcomeStep } from './steps.tsx'
import type { NoticeFace, OnboardingStep, ReachState, StartTarget, StepServices } from './types.ts'
import { WorkspaceStep } from './WorkspaceStep.tsx'

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
   * @returns the body.
   */
  readonly render: (next: () => void) => ReactNode
  /** Runs when the person presses Continue, before the flow moves on. */
  readonly onContinue?: () => void
}

/** The built-in steps' ids and places. */
export const STEPS = {
  welcome: { id: 'welcome', order: 100 },
  look: { id: 'look', order: 200 },
  agents: { id: 'agents', order: 300 },
  plugins: { id: 'plugins', order: 400 },
  reach: { id: 'reach', order: 500 },
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
  /** Where the chat opens without a choice. */
  readonly target: StartTarget
  /** The preview notice when it is owed: it exists, this browser has not acknowledged it and onboarding was not reopened. Continuing from Welcome acknowledges it. */
  readonly notice: NoticeFace | undefined
}

/**
 * Build the ordered steps.
 * @param input - the services and what decides which steps apply.
 * @returns the steps, ascending by order.
 */
export function buildSteps({ services, guide, record, extra, reach, target, notice }: FlowInput): FlowStep[] {
  const { t, plugins } = services
  const covered = (id: string): boolean => record.sections?.includes(id) === true
  const props = { services, guide }
  const built: FlowStep[] = [{ ...STEPS.welcome, title: () => t('step.welcome'), render: () => <WelcomeStep {...props} notice={notice} />, ...notice === undefined ? {} : { onContinue: notice.acknowledge } }]
  if (!covered(STEPS.look.id)) built.push({ ...STEPS.look, title: () => t('step.look'), render: () => <LookStep {...props} /> })
  if (!covered(STEPS.agents.id)) built.push({ ...STEPS.agents, title: () => t('step.agents'), render: () => <AgentsStep {...props} /> })
  if (plugins.length > 0 && !covered(STEPS.plugins.id)) built.push({ ...STEPS.plugins, title: () => t('step.plugins'), render: () => <PluginsStep {...props} /> })
  if (reach === 'remote') built.push({ ...STEPS.reach, title: () => t('step.reach'), render: () => <RemoteReachStep {...props} /> })
  else if (reach === 'off' && !record.reachSetUp) built.push({ ...STEPS.reach, title: () => t('step.reach'), render: () => <ReachStep {...props} /> })
  built.push(
    { ...STEPS.workspace, title: () => t('step.workspace'), render: () => <WorkspaceStep {...props} target={target} /> },
    { ...STEPS.ready, title: () => t('step.ready'), render: () => <ReadyStep {...props} reach={record.reachSetUp || reach === 'remote' ? 'set-up' : reach} target={target} /> },
  )
  const added = extra.map((step): FlowStep => ({ id: step.id, order: step.order, title: step.title, render: next => { const Body = step.component; return <Body next={next} /> } }))
  return [...built, ...added].sort((a, b) => a.order - b.order)
}
