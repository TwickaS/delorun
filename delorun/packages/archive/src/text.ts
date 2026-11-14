/**
 * The characters an archive's text may not carry: the C0 and C1 controls,
 * DEL, and the bidirectional controls. A terminal acts on the controls and
 * the bidirectional controls reorder what a person reads, so a string from an
 * archive that held one could rewrite or hide the lines an import prints
 * around it, such as who signed the archive.
 *
 * @module @delorun/archive/text
 */

/** Every character {@link hasControlCharacter} refuses. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u

/**
 * Whether one string holds a character a terminal or a bidirectional layout acts on.
 * @param text - the string.
 * @returns true when it holds a C0 or C1 control, DEL or a bidirectional control.
 */
export function hasControlCharacter(text: string): boolean {
  return CONTROL_CHARACTERS.test(text)
}
