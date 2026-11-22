/**
 * Shared helpers of the setup specs: a prompter that plays a script and records everything the person would see, and
 * what was typed.
 */
import type { TailscaleRunner } from '@delorun/reach'
import { reachSection } from '../../src/reach/setup-section.ts'
import type { PromptOption, Prompter } from '../../src/setup/prompts.ts'
import { defaultRegistry, SectionRegistry } from '../../src/setup/sections.ts'

/** One scripted answer. A select answers with an option value, a confirm with a boolean, a text or key with a string. */
export type Answer = string | boolean

/** What the person sees, in order, and what was typed. */
export interface Recording {
  /** The screen text, one entry per prompt, note or output write. */
  readonly screen: string[]
  /** The prompts asked, in order, as `kind: message`. */
  readonly asked: string[]
}

/**
 * Render the options of a select the way a terminal lists them: the selected one is marked.
 * @param options - the options.
 * @param selected - the preselected value.
 * @returns the lines.
 */
function renderOptions(options: readonly PromptOption<string>[], selected: string): string[] {
  return options.map(option => `${option.value === selected ? '>' : ' '} ${option.label}${option.hint === undefined ? '' : ` (${option.hint})`}`)
}

/**
 * A prompter that answers from a script, strictly in order, and records the screen. A typed key is shown masked.
 * @param script - the answers in order.
 * @param recording - where the screen is recorded.
 * @returns the prompter; it fails the test when asked more than the script holds.
 */
export function scriptedPrompter(script: readonly Answer[], recording: Recording): Prompter {
  let position = 0
  const next = (kind: string, message: string): Answer => {
    recording.asked.push(`${kind}: ${message}`)
    const answer = script[position]
    position += 1
    if (answer === undefined) throw new Error(`the script ended before: ${kind}: ${message}`)
    return answer
  }
  return {
    select<T extends string>(message: string, options: readonly PromptOption<T>[], initial: T): Promise<T> {
      const answer = next('select', message)
      const chosen = options.find(option => option.value === answer)
      if (chosen === undefined) throw new Error(`answer ${String(answer)} is not an option of: ${message}`)
      recording.screen.push(`? ${message}`, ...renderOptions(options, initial), `= ${chosen.label}`)
      return Promise.resolve(chosen.value)
    },
    confirm(message, initial) {
      const answer = next('confirm', message)
      recording.screen.push(`? ${message} (${initial ? 'Yes' : 'No'})`, `= ${answer === true ? 'Yes' : 'No'}`)
      return Promise.resolve(answer === true)
    },
    secret(message, allowEmpty) {
      const answer = String(next('secret', message))
      if (answer === '' && allowEmpty !== true) throw new Error(`an empty key is not accepted for: ${message}`)
      recording.screen.push(`? ${message}`, `= ${'*'.repeat(answer.length)}`)
      return Promise.resolve(answer)
    },
    text(message, initial, validate, allowEmpty) {
      recording.screen.push(`? ${message} [${initial}]`)
      for (;;) {
        const answer = String(next('text', message))
        const problem = answer === '' && allowEmpty === true ? undefined : validate(answer)
        recording.screen.push(`= ${answer}`)
        if (problem === undefined) return Promise.resolve(answer)
        recording.screen.push(`! ${problem}`)
      }
    },
    note(body, title) {
      recording.screen.push(`# ${title}`, ...body.split('\n').map(line => `  ${line}`))
    },
  }
}

/**
 * This build's sections with the reach section running a given `tailscale`, so a phone Yes does not look at the computer's own Tailscale.
 * @param tailscale - the runner the reach section checks.
 * @returns the registry.
 */
export function registryWithTailscale(tailscale: TailscaleRunner): SectionRegistry {
  const registry = new SectionRegistry()
  for (const [order, section] of defaultRegistry().all().entries()) {
    registry.register(section.id === 'reach' ? reachSection(tailscale, () => false) : section, { order })
  }
  return registry
}
