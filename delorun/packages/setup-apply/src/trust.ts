/**
 * What remote access over the person's tailnet lets a device do and what protects the home, as `delorun reach on`
 * prints it, setup shows it and the user guide states it (contract C14, "Tailnet membership").
 *
 * @module @delorun/setup-apply/trust
 */

/** The trust statement, one sentence per line. */
export const TRUST_STATEMENT: readonly string[] = [
  'Any device on your tailnet can open the sign-in page at this address.',
  'Only a device you approve at this computer, by typing the code it shows, can open your chats.',
  'An approved phone can read chats, reply, start chats in your workspaces, rename and pin chats, answer ordinary prompts and stop a run.',
  'Each sensitive action it takes asks for Face ID or that phone\'s PIN, once per action, and nothing stays unlocked: changing settings, installing plugins, opening a terminal, granting full access or starting an external agent. Removing another device takes Face ID itself, never the PIN.',
  'A terminal runs commands with your authority. Approving devices, changing remote access and setting the PIN stay at this computer, whatever the phone confirms.',
  'A workspace you already put on full access at this computer can still be driven from it, and a command there can do anything your user can.',
  'What protects you: the phone\'s own lock, removing the device with delorun devices remove, and the sign-out after 12 hours unused or 14 days after sign-in.',
  'No outside security review of remote access has happened.',
]
