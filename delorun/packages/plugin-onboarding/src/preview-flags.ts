/**
 * The preview flags onboarding declares. The Host half declares them to `@delorun/preview-flags` and the studio half
 * reads them by id; this package's `package.json` lists the ids under `delorun.previewFlags`, and the
 * `gates:preview-flags` gate and a spec hold the two equal.
 * @module @delorun/plugin-onboarding/preview-flags
 */
import { previewFlagId, type PreviewFlagDeclaration } from '@delorun/preview-flags/flags'

/**
 * Shows the setup steps and choices that are planned and not built yet, each marked Preview. Choosing one records
 * nothing and changes nothing.
 */
export const PREVIEW_STEPS: PreviewFlagDeclaration = {
  id: previewFlagId('onboarding.previewSteps'),
  kind: 'boolean',
  owner: '@delorun/plugin-onboarding',
  title: { en: 'Planned setup steps', zh: '计划中的设置步骤' },
  description: {
    en: 'Shows setup steps and choices that are planned and not built yet, each marked Preview. Choosing one records nothing and changes nothing.',
    zh: '显示已计划但尚未实现的设置步骤和选项，每一项都标有“预览”。选择它们不会记录任何内容，也不会改变任何设置。',
  },
}

/** Every flag this plugin declares, under the name the `gates:preview-flags` gate reads. */
export const PREVIEW_FLAGS: readonly PreviewFlagDeclaration[] = [PREVIEW_STEPS]
