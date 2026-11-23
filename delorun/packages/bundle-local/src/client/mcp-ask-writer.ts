/** The write of Settings → Permissions to the `ask` field of the MCP consent row, through the row's Host form. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { McpAskMode, McpConsentSettings } from './consents-api.ts'
import type { OptInMutation } from './opt-in.ts'

/** Writes the ask choice and reports the write's state; the shown value is the one the Host accepted. */
export class McpAskWriter {
  /** Observable write state. */
  readonly state = createSnapshotStore<OptInMutation>({ busy: false, failed: false })

  /** The Host form of the MCP consent row. */
  readonly form: ConfigForm<McpConsentSettings>

  /** @param form - the Host form of the MCP consent row. */
  constructor(form: ConfigForm<McpConsentSettings>) {
    this.form = form
  }

  /**
   * Write the choice: only `ask` of the row changes. A write while another crosses the wire is dropped.
   * @param mode - the mode the person chose.
   * @returns after the write settles.
   */
  async set(mode: McpAskMode): Promise<void> {
    if (this.state.getSnapshot().busy) return
    this.state.update((state) => { state.busy = true; state.failed = false })
    let accepted = false
    try {
      accepted = await this.form.mutate([{ op: 'set', path: ['ask'], value: mode }])
    } catch (_error) {
      // A transport failure is reported as failed; the form keeps the accepted value.
    }
    this.state.update((state) => { state.busy = false; state.failed = !accepted })
  }
}
