/** The writes of Settings → Devices to the `pairing` section of the home-auth row, through the row's Host form. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PairingConfig } from '@delorun/home-auth/wire'
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
   * Write one field of the `pairing` section, keeping the others. A write while another crosses the wire is dropped, and
   * so is one before the row was first read, which could not tell a missing section from one not yet read.
   * @param field - the field.
   * @param value - the value the person chose.
   * @returns whether the Host accepted the write.
   */
  async set<K extends keyof PairingConfig>(field: K, value: NonNullable<PairingConfig[K]>): Promise<boolean> {
    if (this.state.getSnapshot().busy) return false
    const read = this.form.getSnapshot().value
    if (read === undefined) {
      this.state.update((state) => { state.failed = true })
      return false
    }
    this.state.update((state) => { state.busy = true; state.failed = false })
    let accepted = false
    try {
      const section = read.pairing
      accepted = await this.form.mutate(section === undefined
        ? [{ op: 'set', path: ['pairing'], value: { [field]: value } }]
        : [{ op: 'set', path: ['pairing', field], value }])
    } catch (_error) {
      // A transport failure is reported as failed; the form keeps the accepted value.
    }
    this.state.update((state) => { state.busy = false; state.failed = !accepted })
    return accepted
  }

  /**
   * "Don't show this pop-up again": show requests as the quiet notice from now on. It writes only `showRequest: notice`,
   * never `none`, so a waiting request still shows in the notice and in Settings → Devices.
   * @returns whether the Host accepted the write.
   */
  showAsNotice(): Promise<boolean> {
    return this.set('showRequest', 'notice')
  }
}
