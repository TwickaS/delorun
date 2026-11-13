/** One switch on the Privacy section: its Host configuration form and its write state. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'

/** The field every switch's row exposes: `config.enabled` of its profile row. */
export interface OptInSettings {
  enabled: boolean
}

/** Write state shown beside the opt-in's switch. */
export interface OptInMutation {
  /** A write is crossing the wire; the switch refuses input meanwhile. */
  busy: boolean
  /** The last write was refused or failed, so the switch still shows the accepted value. */
  failed: boolean
}

/**
 * Writes the fields of one switch's row through its Host form. The switch shows only the value the Host accepted, so a
 * refused or failed write leaves the earlier value on screen and sets {@link OptInMutation.failed}.
 */
export class OptIn<T extends OptInSettings = OptInSettings> {
  /** Observable write state. */
  readonly state = createSnapshotStore<OptInMutation>({ busy: false, failed: false })

  /** The Host form of the opt-in's profile row. */
  readonly form: ConfigForm<T>

  /** @param form - the Host form of the opt-in's profile row. */
  constructor(form: ConfigForm<T>) {
    this.form = form
  }

  /**
   * Write the opt-in's `enabled` field; this changes no other row or field.
   * @param enabled - the value the person chose; `true` only after they confirmed the consent dialog.
   * @returns after the write settles.
   */
  setEnabled(enabled: boolean): Promise<void> {
    return this.set('enabled', enabled)
  }

  /**
   * Write one field of the row; this changes no other row or field. A write while another crosses the wire is dropped.
   * @param field - the row's field.
   * @param value - the value the person chose.
   * @returns after the write settles.
   */
  async set<K extends keyof T & string>(field: K, value: T[K]): Promise<void> {
    if (this.state.getSnapshot().busy) return
    this.state.update((state) => { state.busy = true; state.failed = false })
    let accepted = false
    try {
      accepted = await this.form.set(field, value)
    } catch (_error) {
      // A transport failure is reported as failed; the form keeps the accepted value.
    }
    this.state.update((state) => { state.busy = false; state.failed = !accepted })
  }
}
