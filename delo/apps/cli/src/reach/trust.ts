/**
 * What remote access over the person's tailnet lets a device do and what protects the home, as `delorun reach on`
 * prints it, setup shows it and the user guide states it (contract C14, "Tailnet membership").
 *
 * @module @delo/cli/reach/trust
 */

/** The trust statement, one sentence per line. */
export const TRUST_STATEMENT: readonly string[] = [
  'Any device on your tailnet can open the sign-in page at this address.',
  'Only a device you approve at this computer, by typing the code it shows, can open your chats.',
  'An approved phone can watch chats, reply, start chats, approve ordinary prompts and stop a run.',
  'It cannot grant full access, approve or remove devices, or change remote access; those need you at this computer.',
  'A workspace you already put on full access at this computer can still be driven from it, and a command there can do anything your user can.',
  'What protects you: the phone\'s own lock, removing the device with delorun devices remove, and the sign-out after 12 hours unused.',
]
