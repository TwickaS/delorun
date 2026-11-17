---
area: Plugins
section: Fixed
---

- New chats start again after you add the Browser pack and before you allow its playwright-mcp server; in 0.1.0-preview.1.6 every new chat failed with "McpConsentRefusedError" until the server was allowed. The chat now starts without the browser tools, home.log notes why, and the notice reads "MCP tools are off until you allow playwright-mcp" with the action that reviews and allows it. Once allowed, the server starts in your next new chat.
