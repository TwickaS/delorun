/** The writes of Settings → Devices to the `pairing` section of the home-auth row, through the row's Host form. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PairingConfig } from '@delo/home-auth/wire'
import type { OptInMutation } from './opt-in.ts'

/** The part of the home-auth row Settings reads: its `pairing` section. */
export interface PairingRowSettings {
  readonly pairing?: PairingConfig
}

/** Writes one pairing field at a time and reports the write's state; the shown value is the one the Host accepted. */
export class PairingWriter {
  /** Observable write state. */
  readonly state = createSnapshotStore<OptInMutation>({ busy: false, failed: false })

  /** The Host form of the home-auth row. */
  readonly form: ConfigForm<PairingRowSettings>

  /** @param form - the Host form of the home-auth row. */
  constructor(form: ConfigForm<PairingRowSettings>) {
    this.form = form
  }

  /**
   * Write one field of the `pairing` section, keeping the others; a write while another crosses the wire is dropped.
   * @param field - the field.
   * @param value - the value the person chose.
   * @returns after the write settles.
   */
  async set<K extends keyof PairingConfig>(field: K, value: NonNullable<PairingConfig[K]>): Promise<void> {
    if (this.state.getSnapshot().busy) return
    this.state.update((state) => { state.busy = true; state.failed = false })
    let accepted = false
    try {
      const section = this.form.getSnapshot().value?.pairing
      accepted = await this.form.mutate(section === undefined
        ? [{ op: 'set', path: ['pairing'], value: { [field]: value } }]
        : [{ op: 'set', path: ['pairing', field], value }])
    } catch (_error) {
      // A transport failure is reported as failed; the form keeps the accepted value.
    }
    this.state.update((state) => { state.busy = false; state.failed = !accepted })
  }
}
