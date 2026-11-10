/**
 * Which steps the dialog shows, and in which order: the built-in steps that apply, then the steps other plugins added.
 */
import type { ReactNode } from 'react'
import type { SetupRecord } from '../wire.ts'
import { AgentsStep, LookStep, NoticeStep, PluginsStep, ReachStep, StartStep } from './steps.tsx'
import type { NoticeFace, OnboardingStep, ReachState, StepServices } from './types.ts'

/** One step of the flow, built-in or added by a plugin. */
export interface FlowStep {
  /** Unique among the steps. */
  readonly id: string
  /** Its place, ascending. */
  readonly order: number
  /** Its name in the list of steps. */
  readonly title: () => string
  /** Its heading when that differs from the name. */
  readonly heading?: () => string
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
  notice: { id: 'notice', order: 100 },
  look: { id: 'look', order: 200 },
  agents: { id: 'agents', order: 300 },
  plugins: { id: 'plugins', order: 400 },
  reach: { id: 'reach', order: 500 },
  start: { id: 'start', order: 1000 },
} as const

/** What decides the list. */
export interface FlowInput {
  /** The services the built-in steps draw with. */
  readonly services: StepServices
  /** What the terminal setup recorded. */
  readonly record: SetupRecord
  /** The steps other plugins added. */
  readonly extra: readonly OnboardingStep[]
  /** Whether `ctx.deloReach` says reach can be turned on here; the reach step shows only when it is available and not set up. */
  readonly reach: ReachState
  /** The preview notice when its screen applies: it exists, this browser has not acknowledged it and onboarding was not reopened. */
  readonly notice: NoticeFace | undefined
}

/**
 * Build the ordered steps.
 * @param input - the services and what decides which steps apply.
 * @returns the steps, ascending by order.
 */
export function buildSteps({ services, record, extra, reach, notice }: FlowInput): FlowStep[] {
  const { t, plugins } = services
  const covered = (id: string): boolean => record.sections?.includes(id) === true
  const built: FlowStep[] = []
  if (notice !== undefined) {
    built.push({
      ...STEPS.notice,
      title: () => t('step.notice'),
      heading: notice.title,
      render: () => <NoticeStep services={services} />,
      onContinue: notice.acknowledge,
    })
  }
  if (!covered(STEPS.look.id)) built.push({ ...STEPS.look, title: () => t('step.look'), render: () => <LookStep services={services} /> })
  if (!covered(STEPS.agents.id)) built.push({ ...STEPS.agents, title: () => t('step.agents'), render: () => <AgentsStep services={services} /> })
  if (plugins.length > 0 && !covered(STEPS.plugins.id)) {
    built.push({ ...STEPS.plugins, title: () => t('step.plugins'), render: () => <PluginsStep services={services} /> })
  }
  if (reach === 'available' && !record.reachSetUp) built.push({ ...STEPS.reach, title: () => t('step.reach'), render: () => <ReachStep services={services} /> })
  built.push({ ...STEPS.start, title: () => t('step.start'), render: () => <StartStep services={services} /> })
  const added = extra.map((step): FlowStep => ({ id: step.id, order: step.order, title: step.title, render: next => { const Body = step.component; return <Body next={next} /> } }))
  return [...built, ...added].sort((a, b) => a.order - b.order)
}
