/** Directory names of the default skill stores, shared with consumers that classify skill paths. */

/**
 * The project-scope skill directories this provider reads, below a project root. A consumer that must recognize a
 * skill file without a lookup — a consent over the writes that change one, say — reads this list instead of
 * restating the directory names.
 */
export const PROJECT_SKILL_DIRS = ['.dsh/skills', '.agents/skills'] as const

/** The home-relative directory of each default skill store: the harness home's and the shared agent root's. */
export const HOME_SKILL_DIR = 'skills'
