/**
 * Setup's `autostart` section, asked in the main flow after `background` and as `delorun setup autostart`: whether
 * Delorun starts itself when the person logs in.
 *
 * The answer defaults to no. A service that installs itself without being asked is the kind of thing that surprises a
 * person, so `--yes` and a `--config` document install no unit, and only an answer of yes writes one.
 *
 * The section sits beside `background` because it only makes sense once Delorun keeps running after the terminal
 * closes: a unit that starts a home process the person then stops at every login helps nobody.
 *
 * @module @delorun/cli/setup/autostart-section
 */
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { autostartOn, autostartSupport, installUnit, launcherCommand, lingerEnabled, removeUnit, type runCommand } from '../autostart.ts'
import { choiceNote, RECOMMENDED, type ChoiceText } from './choices.ts'
import type { SetupSection } from './sections.ts'
import { BACK } from './steps.ts'

/** The section's place in the flow: right after the background question, which it depends on. */
export const AUTOSTART_SECTION_ORDER = 45

/** The question. */
export const AUTOSTART_QUESTION = 'Start Delorun by itself when you log in?'

/**
 * What the two choices mean.
 *
 * The lines name the difference between starting at login and starting at boot, because that is the part a person
 * cannot see: a unit without linger waits for a login, and a machine that reboots unattended then runs no Delorun. The
 * boot line is a request rather than a promise, because the machine may refuse linger; `apply` reports which of the
 * two the person got.
 * @returns the two choices.
 */
export function autostartText(): readonly ChoiceText[] {
  return [
    {
      label: `Yes${RECOMMENDED}`,
      lines: [
        'Delorun starts by itself when you log in, so the studio is there without a terminal.',
        'Starting at boot with nobody logged in needs linger, which Delorun asks for and this computer may refuse.',
        'Change later: delorun setup autostart.',
      ],
    },
    { label: 'No', lines: ['You start Delorun yourself with delorun start.', 'Change later: delorun setup autostart.'] },
  ]
}

/**
 * The section.
 * @param run - runs `systemctl` and `loginctl`; the real commands by default, and a script in a spec.
 * @returns the section.
 */
export function autostartSection(run?: typeof runCommand): SetupSection {
  return {
    id: 'autostart',
    title: 'Start at login',
    // The main flow asks few questions (A519), and `background` is not one of them: this section sits beside it, asked
    // by `delorun setup autostart`, so a first run gains no question and the answer still defaults to no.
    inMainFlow: 'never',
    asks: () => true,
    appliesTo: () => true,
    async ask(io, draft) {
      // The support check reads the filesystem, so the question costs no command; linger is asked about only when the
      // person is about to install a unit, in `apply`.
      const support = autostartSupport()
      if (support.kind === 'unsupported') {
        // A computer that cannot run a unit is told so once, and the question is not asked.
        io.note(`Delorun cannot start itself on this computer: ${support.why}. Start it with delorun start.`, 'Start at login')
        return { answers: { autostart: false }, status: 'seen' }
      }
      io.note(choiceNote(autostartText()), 'Starting by itself')
      const start = await io.confirm(AUTOSTART_QUESTION, draft.answers.autostart)
      return start === BACK ? BACK : { answers: { autostart: start }, status: 'answered' }
    },
    unchanged: (before, after) => before.autostart === after.autostart,
    async apply(context, answers) {
      if (!answers.autostart) {
        const removed = await removeUnit(context.env, run)
        return removed.ok ? undefined : removed.detail
      }
      const support = autostartSupport()
      if (support.kind === 'unsupported') return `Delorun does not start by itself: ${support.why}.`
      const launcher = launcherCommand(context.env, fileURLToPath(import.meta.url))
      if (launcher === undefined) return 'Delorun does not start by itself: the delorun command that installed it was not found, so there is nothing for the unit to run. Install it with npm install -g delorun, then run delorun setup autostart.'
      // The profile's directory is `<home>/profiles/<profile>`, which is the name the unit starts.
      const outcome = await installUnit({ home: context.home, profile: basename(context.directory), entry: launcher.entry, node: launcher.node, env: context.env }, run)
      return outcome.detail
    },
  }
}

/**
 * The line `delorun status` shows about the hook, so a person can see whether it is on without opening the unit.
 * @param env - the environment, read for `XDG_CONFIG_HOME`.
 * @param run - runs `systemctl`; the real command by default.
 * @returns the line with its line ending, or an empty string when no unit is installed.
 */
export async function autostartStatusLine(env: Readonly<Record<string, string | undefined>>, run?: typeof runCommand): Promise<string> {
  const on = await autostartOn(env, run)
  if (!on) return ''
  const linger = await lingerEnabled(run)
  return `Starts at login: yes${linger ? ', and at boot' : '; at boot only after a login'}. Turn it off with delorun setup autostart.\n`
}
