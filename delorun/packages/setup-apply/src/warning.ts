/**
 * The warning a person reads before turning dangerous mode on, which the `delorun` command and the studio's confirmation
 * share. This module has no Node imports, so a browser spec can read it.
 *
 * @module @delorun/setup-apply/warning
 */

/** The warning a person reads before turning dangerous mode on, one paragraph per entry. */
export const DANGEROUS_WARNING_LINES: readonly string[] = [
  'Dangerous mode lets any chat switch to full access without asking: a chat at this computer, a phone signed in over remote access, a scheduled task, a bot, or delorun headless.',
  'A phone or browser signed in over remote access can then also do everything this computer can, except turn this mode on and approve new devices.',
  'Commands then run outside the sandbox with everything your user can do, including reading and changing Delorun\'s home, its keys and the token that controls it.',
  'The questions before writing AGENTS.md or skills, adding MCP servers and creating scheduled tasks are off, as in DeepSeek Harness.',
  'Text the model reads (web pages, files, repositories) can tell it to do harmful things.',
  'New chats still start on Workspace Write unless you choose otherwise.',
  'Turn it off with `delorun setup prompts`.',
]
