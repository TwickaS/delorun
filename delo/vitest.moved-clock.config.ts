import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { forkClientProject, forkUnitProject } from './vitest.config.ts'

/**
 * Vitest for the moved-clock check (`tests:moved-clock`): the fork's unit and client component projects with
 * `vitest.moved-clock-setup.ts` added, which fakes `Date` forward by `DELO_MOVED_CLOCK_DAYS` days. Only in-process
 * code sees the moved date, so the integration project, whose git, Node and `tsx` children read the system clock,
 * is left out as a whole. The check runner runs it from the repository root with
 * `node_modules/.bin/tsx delo/apps/tools/src/checks/moved-clock.ts`.
 */
const SETUP = fileURLToPath(new URL('./vitest.moved-clock-setup.ts', import.meta.url))

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    projects: [forkUnitProject, forkClientProject].map(project => ({
      ...project,
      test: { ...project.test, setupFiles: [...('setupFiles' in project.test ? project.test.setupFiles : []), SETUP] },
    })),
  },
})
