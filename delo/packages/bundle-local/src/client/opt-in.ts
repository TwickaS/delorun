/** One switch on the Privacy section: its Host configuration form and its write state. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'

/** The `config` field a switch writes: `enabled` of an opt-in's row, or `npmMirror` of the install check's row. */
export type OptInField = 'enabled' | 'npmMirror'

/** The fields a switch's row exposes; each switch reads and writes its own {@link OptInField}. */
export type OptInSettings = Partial<Record<OptInField, boolean>>

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

  /** The field the switch writes. */
  readonly field: OptInField

  /**
   * @param form - the Host form of the switch's profile row.
   * @param field - the field the switch writes; `enabled` by default.
   */
  constructor(form: ConfigForm<T>, field: OptInField = 'enabled') {
    this.form = form
    this.field = field
  }

  /**
   * Write the switch's field; this changes no other row or field.
   * @param enabled - the value the person chose; `true` only after they confirmed the consent dialog.
   * @returns after the write settles.
   */
  setEnabled(enabled: boolean): Promise<void> {
    return this.write(this.field, enabled)
  }

  /**
   * Write one field of the row; this changes no other row or field. A write while another crosses the wire is dropped.
   * @param field - the row's field.
   * @param value - the value the person chose.
   * @returns after the write settles.
   */
  set<K extends keyof T & string>(field: K, value: T[K]): Promise<void> {
    return this.write(field, value)
  }

  /**
   * Write one field unless another write is crossing the wire.
   * @param field - the row's field.
   * @param value - the value to write.
   * @returns after the write settles.
   */
  private async write(field: string, value: unknown): Promise<void> {
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
