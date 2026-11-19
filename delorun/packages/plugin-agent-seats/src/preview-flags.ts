/**
 * The preview flag live agents sit behind. The Host half declares it to `@delorun/preview-flags`; this package's
 * `package.json` lists the id under `delorun.previewFlags`, and the `gates:preview-flags` gate and a spec hold the two equal.
 * @module @delorun/plugin-agent-seats/preview-flags
 */
import { previewFlagId, type PreviewFlagDeclaration } from '@delorun/preview-flags/flags'

/**
 * Turns on live agents: Claude Code and Codex as child chats that a person can watch, message and stop, with one
 * hand-off tool each. Off, a chat's tools and screens are as without this package.
 */
export const LIVE_AGENTS: PreviewFlagDeclaration = {
  id: previewFlagId('externalAgents.liveAgents'),
  kind: 'boolean',
  owner: '@delorun/plugin-agent-seats',
  title: { en: 'Live agents', zh: '实时智能体' },
  description: {
    en: 'Hands work to Claude Code or Codex as a chat of its own that you can watch, message and stop. Off, they run as one-shot helpers.',
    zh: '把任务交给 Claude Code 或 Codex，作为一个可以观看、发消息和停止的独立聊天。关闭时，它们作为一次性助手运行。',
  },
}

/** Every flag this plugin declares, under the name the `gates:preview-flags` gate reads. */
export const PREVIEW_FLAGS: readonly PreviewFlagDeclaration[] = [LIVE_AGENTS]
