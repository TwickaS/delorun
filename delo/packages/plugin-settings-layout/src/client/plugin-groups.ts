/**
 * The registry of third-party plugin groups in Delo's Settings, provided as
 * `ctx.settingsPluginGroups` while the layout is registered.
 * @module @delo/plugin-settings-layout/client/plugin-groups
 */
import type { SettingsPluginGroup } from './layout.ts'

/** Third-party plugin groups, in registration order; one group per plugin id. */
export class SettingsPluginGroups {
  private groups: readonly SettingsPluginGroup[] = []
  private readonly listeners = new Set<() => void>()

  /**
   * Give a plugin's sections a group of their own, titled with its display title.
   * @param group - the plugin's id, display title and section ids.
   * @returns the disposer, which removes the group.
   * @throws Error when a group with the same plugin id is registered already.
   */
  register(group: SettingsPluginGroup): () => void {
    if (this.groups.some(registered => registered.id === group.id)) {
      throw new Error(`Settings plugin group "${group.id}" is registered already`)
    }
    this.groups = [...this.groups, group]
    this.emit()
    return () => {
      if (!this.groups.includes(group)) return
      this.groups = this.groups.filter(registered => registered !== group)
      this.emit()
    }
  }

  /**
   * Read the registered groups.
   * @returns the groups in registration order; a new array after each change.
   */
  getSnapshot(): readonly SettingsPluginGroup[] {
    return this.groups
  }

  /**
   * Follow registrations.
   * @param listener - called after each change.
   * @returns the unsubscriber.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
