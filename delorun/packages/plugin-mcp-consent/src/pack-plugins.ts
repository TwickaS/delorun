/**
 * The plugins Delorun's own packs install, by module, with the pack each comes from: every row of each pack's
 * `cordis.patch.yml` (packages whose `package.json` sets `delorun.pack`). A server one of these plugins mounts is a pack
 * server (A631), which starts without asking under the default ask mode. The list is checked against the packs' patch
 * files by `tests/pack-plugins.spec.ts`; a pack that adds a row updates it.
 *
 * @module @delorun/plugin-mcp-consent/pack-plugins
 */

/** Each pack plugin's module specifier, mapped to its pack's package name. */
export const PACK_PLUGINS: ReadonlyMap<string, string> = new Map([
  ['@deepseek-ai/dsh-browser-use', '@delorun/bundle-browser'],
  ['@deepseek-ai/dsh-computer-use', '@delorun/bundle-computer-use-driver'],
  ['@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp', '@delorun/bundle-browser'],
  ['@deepseek-ai/dsh-experimental-browser-use-playwright-mcp', '@delorun/bundle-browser'],
  ['@deepseek-ai/dsh-experimental-browser-use-stagehand-native', '@delorun/bundle-browser'],
  ['@deepseek-ai/dsh-experimental-claude-code-mods', '@delorun/bundle-agent-hooks'],
  ['@deepseek-ai/dsh-experimental-client-ui-claude-code-mods', '@delorun/bundle-agent-hooks'],
  ['@deepseek-ai/dsh-experimental-computer-use-cua-driver-native', '@delorun/bundle-computer-use-driver'],
  ['@deepseek-ai/dsh-experimental-ptc-runtime-python', '@delorun/bundle-external-agents'],
  ['@deepseek-ai/dsh-experimental-subagent-oar', '@delorun/bundle-external-agents'],
  ['@deepseek-ai/dsh-experimental-tool-subagent-oar', '@delorun/bundle-external-agents'],
  ['@deepseek-ai/dsh-hooks-claude-code', '@delorun/bundle-agent-hooks'],
  ['@deepseek-ai/dsh-hooks-codex', '@delorun/bundle-agent-hooks'],
  ['@deepseek-ai/dsh-lsp', '@delorun/bundle-code-intelligence'],
  ['@deepseek-ai/dsh-lsp-stdio', '@delorun/bundle-code-intelligence'],
  ['@deepseek-ai/dsh-tool-lsp', '@delorun/bundle-code-intelligence'],
  ['@deepseek-ai/dsh-webhook', '@delorun/bundle-webhooks'],
  ['@deepseek-ai/dsh-webhook-github', '@delorun/bundle-webhooks'],
  ['@delorun/browser-use-browse', '@delorun/bundle-real-browser'],
  ['@delorun/bundle-webhooks/server', '@delorun/bundle-webhooks'],
  ['@delorun/skill-real-browser', '@delorun/bundle-real-browser'],
])
