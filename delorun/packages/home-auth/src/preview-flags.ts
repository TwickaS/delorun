/**
 * The preview flag home-auth declares. The Host half declares it to `@delorun/preview-flags` and reads it by id; this
 * package's `package.json` lists the id under `delorun.previewFlags`, and the `gates:preview-flags` gate holds the two equal.
 * @module @delorun/home-auth/preview-flags
 */
import { previewFlagId, type PreviewFlagDeclaration } from '@delorun/preview-flags/flags'

/**
 * Turns on Face ID enrolment and assertion: the passkey routes answer, a paired device may set up a passkey, and a
 * confirmed action or a correct PIN mints a one-action grant. While it is off the routes answer `PASSKEY_UNAVAILABLE`
 * and no passkey can be enrolled.
 */
export const PASSKEY_UNLOCK: PreviewFlagDeclaration = {
  id: previewFlagId('unlock.passkeys'),
  kind: 'boolean',
  owner: '@delorun/home-auth',
  title: { en: 'Face ID unlock', zh: '面容 ID 解锁' },
  description: {
    en: 'Lets a phone confirm sensitive actions with Face ID or its device lock. Turning it on adds the set-up step and the passkey routes; the PIN keeps working.',
    zh: '允许手机用面容 ID 或设备锁屏确认敏感操作。开启后会增加设置步骤和通行密钥相关路由；PIN 仍然可用。',
  },
}

/** Every flag this plugin declares, under the name the `gates:preview-flags` gate reads. */
export const PREVIEW_FLAGS: readonly PreviewFlagDeclaration[] = [PASSKEY_UNLOCK]
