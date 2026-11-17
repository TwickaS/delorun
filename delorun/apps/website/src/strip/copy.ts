/**
 * The setup strip's words. The names of the controls and their choices are the studio's own (the Theme plugin's
 * Appearance dictionary) and the version list's are the studio's Setup versions dictionary; this module holds only the
 * sentences the strip adds around them.
 *
 * @module website/strip/copy
 */

/** The strip's own sentences. */
export const STRIP_COPY = {
  /** The accessible name of the controls. */
  controls: 'Change this page',
  /** The heading over the entry. */
  entry: 'What Delorun writes',
  /** The entry's place, shown in the monospace face. */
  entryFile: 'cordis.patch.yml',
  /** The entry's copy button. */
  copyEntry: 'Copy the entry',
  /** The copy button's answer. */
  copied: 'Copied',
  /** The answer when copying fails. */
  copyFailed: 'Copy failed. Select the entry and copy it.',
  /** Shown in place of the entry before the first change. */
  entryEmpty: 'Nothing yet. Change the page and the entry Delorun would write appears here.',
  /** Shown in place of the versions before the first change. */
  versionsEmpty: 'Each change is listed here as a version.',
  /**
   * The way back, named for the earlier look.
   * @param name - the earlier look's name.
   * @returns the control's text.
   */
  back: (name: string): string => `Back to ${name}`,
  /** How the studio offers the same. */
  backStudio: 'In the studio, choose the earlier look again, or open Settings, Setup versions and choose Switch to this version. Going back is one more change, so the list keeps every version.',
  /** What going back covers. */
  backCovers: 'Going back covers Delorun\'s setup and your chats. It does not cover the files an agent changes in a workspace, a patch edited by hand is not saved as a version, and saving or switching a version is done at the computer and takes effect after a restart.',
  /**
   * What the live region says after a change.
   * @param name - the look now shown; its first letter is capitalised to start the sentence.
   * @returns the sentence.
   */
  announce: (name: string): string => `${name.charAt(0).toUpperCase()}${name.slice(1)}. The entry and a new version are listed beside the controls.`,
  /**
   * A custom look's name.
   * @param custom - the studio's name for the custom theme.
   * @param accent - the accent's name.
   * @returns the name, such as "Custom moss".
   */
  customName: (custom: string, accent: string): string => `${custom} ${accent.toLowerCase()}`,
  /**
   * A contrast stop's name in a sentence.
   * @param percent - the stop as a percentage.
   * @returns the name, such as "contrast 125%".
   */
  contrastName: (percent: number): string => `contrast ${String(percent)}%`,
  /**
   * A density's name in a sentence.
   * @param density - the studio's name for the density.
   * @returns the name, such as "comfortable density".
   */
  densityName: (density: string): string => `${density.toLowerCase()} density`,
  /** The caption of the still shown with scripts off. */
  still: 'With scripts on, these controls change this page. This is the strip after choosing Ocean.',
} as const

/** The strip's words. */
export type StripCopy = typeof STRIP_COPY
