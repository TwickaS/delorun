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
   * Write one field of the `pairing` section by its path, keeping the others; the Host creates the section when the row
   * has none. The write never restates the section, so a stale or unread snapshot cannot replace the other fields. A write
   * while another crosses the wire is dropped.
   * @param field - the field.
   * @param value - the value the person chose.
   * @returns whether the Host accepted the write.
   */
  async set<K extends keyof PairingConfig>(field: K, value: NonNullable<PairingConfig[K]>): Promise<boolean> {
    if (this.state.getSnapshot().busy) return false
    this.state.update((state) => { state.busy = true; state.failed = false })
    let accepted = false
    try {
      accepted = await this.form.mutate([{ op: 'set', path: ['pairing', field], value }])
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
