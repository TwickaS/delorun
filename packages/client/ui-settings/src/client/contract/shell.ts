/**
 * Settings navigation for code outside the Settings shell: a feature's
 * overlay or a distribution's sidebar control opens Settings, one of its
 * sections, or one onboarding step. The shell plugin (ui-settings-general)
 * provides it as `ctx.settingsShell`.
 */

/** Open Settings from outside its shell; each call does nothing while no Settings shell is mounted. */
export interface SettingsShell {
  /** Open Settings on the section it last showed. */
  open(): void
  /**
   * Open Settings on one section.
   * @param id - a registered `settings.section` id.
   */
  openSection(id: string): void
  /**
   * Close Settings and open one onboarding step explicitly, as a launcher's `openOnboarding` does.
   * @param id - a registered `settings.onboarding` step id.
   */
  openOnboarding(id: string): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Settings navigation for code outside the Settings shell. */
    settingsShell: SettingsShell
  }
}
