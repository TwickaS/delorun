---
description: "Operate Chromium through Playwright MCP with separate browser state for each live Session."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-browser-use-playwright-mcp

English | [中文](README.zh.md)

## Summary

Use Playwright MCP to inspect pages and operate Chromium through its upstream tools. The provider initializes a Session's MCP connection before creation or resume completes and retains it across turns. Launch a separate browser or attach one Session to an existing browser with its current tabs and login state. This published experimental package activates only when explicitly mounted.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount both entries before creating or resuming a Session, in a profile composition that supplies Agents, tools, system prompts, and the working-directory service. Loading or reloading this provider does not adopt Sessions that are already active. `browser` chooses what launches: `auto`, the default, launches Google Chrome when it is installed where Playwright's `chrome` channel looks, and Playwright's own Chromium build otherwise; `chrome` and `chromium` always launch that one. Chrome runs with a profile Playwright creates for the launch (`--isolated`), never the person's own Chrome profile. Only the Chromium build is tied to the pinned Playwright version, so an update of this package can need a new Chromium download only when Chromium is what launches: under `chromium`, or under `auto` on a computer without Chrome. Select another Chromium installation with `executablePath`; under `auto` it keeps Chromium's launch settings. The provider decides which browser launches when it loads, so installing or removing Chrome takes effect after the Harness restarts. With `browserAdditions` on, when the Chromium build the pinned Playwright expects is not installed, or `chrome` is set and Chrome is not installed, a browser tool call fails with one short message that tells the model to stop and send the person to finish Browser setup; off, the call fails with Playwright's own report.

```yaml
- name: '@deepseek-ai/dsh-browser-use'
- name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
  config:
    mode: launch
    headless: true
```

Use `mode: attach` and set `endpoint` to an HTTP(S) debugging URL or WS(S) browser endpoint to operate an existing browser. The new live Session claims the attachment during initialization and retains it until unloading. If the attachment is busy, that activation continues without this browser and does not retry on later turns. After release, a newly created or resumed activation can acquire it. Direct calls from another Session fail. Cleanup disconnects and leaves the external browser and its pages running.

| Field | Default | Meaning |
|---|---|---|
| `mode` | required | `launch` or `attach`, fixed for this provider activation |
| `headless` | `true` | Launch without a visible window |
| `browser` | `auto` | `auto` launches the installed Chrome, else Playwright's Chromium build; `chrome` or `chromium` forces one. Launch mode only |
| `executablePath` | upstream discovery | Chromium executable for launch |
| `endpoint` | required for attach | Existing browser debugging endpoint |
| `toolCallTimeoutMs` | MCP client default | Per-call timeout in milliseconds |
| `deniedTools` | `[]` | More of the server's own tool names to turn off, beside `browser_run_code_unsafe`, which is always off: never offered to the model and refused when called |
| `browserAdditions` | `false` | Delorun's additions, which Delorun's Browser bundle turns on: the short Browser setup message for a browser that is not installed, and the `.gitignore` of `.playwright-mcp`. The turned-off tools, the folder guard and the MCP root hold whatever its value |
| `serverDirectory` | `session` | Where the MCP server runs: `session` in each Session's working directory, `home` in one folder of the Harness home (`browser-use/<server name>`) for every Session, so its command and folder stay the same |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-browser-use-playwright-mcp) lists accepted fields. The profile or preset selects the browser mode. The child process clears inherited `PLAYWRIGHT_MCP_*` options so they cannot replace that configuration.

When configuring the system prompt's `toolOrder` for the whole process, leave browser tools under `<unlisted-tools>`. Explicitly listing browser tool names can make prompt assembly fail for Sessions without a browser connection.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The provider resolves its pinned npm entry and starts it under the current Node executable. A temporary protocol probe may precede the serving process. The [shared runtime](../browser-use-runtime/README.md) owns awaited Agent initialization, per-Session serialization, and cleanup; the [MCP client](../../mcp/mcp-client/README.md) owns transport, discovery, and result projection.

Browser state survives turns while its live Session remains attached. The MCP server starts in the Session's validated current working directory and retains that launch directory after later Session directory changes. Disposal waits for server shutdown before releasing resources. Resume after reload starts fresh browser runtime state; stored conversation history does not restore cookies or pages.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Browser use](../../../docs/subsystems/browser-use.md) — provider selection and Session ownership.
- [Browser-use service](../../browser-use/browser-use/README.md) — exclusive provider registration.
- [Playwright MCP](https://github.com/microsoft/playwright-mcp) — upstream installation and browser behavior.

-----

<a id="model-experience"></a>
## Model Experience

### Browser tools and screenshots

#### What the model sees

Tools retain upstream descriptions and JSON schemas under `mcp__playwright-mcp__<tool>` names. `browser_run_code_unsafe`, which runs model-written code in the server process, outside the page and outside the agent's sandbox, is always turned off: the MCP client never registers it, so the model is not offered it, and a call to it is refused. No configuration turns it back on. It is the only tool of the pinned server that runs such code there; `deniedTools` turns off more tools. Text and screenshots use the normal tool-result pipeline and Session log. Files the server saves, such as screenshots and PDFs, go to `.playwright-mcp` in the Session's working directory, its MCP root, and the tool result links each one relative to that directory. Those files can show private pages and Git does not skip hidden folders, so with `browserAdditions` on, when a Session's server starts, the provider creates that folder if it is missing and gives it a `.gitignore` of `*` if it has none; it never writes through a link at `.playwright-mcp` or at that `.gitignore`, and never changes an existing `.gitignore` there or the project's own. Playwright's server compares a tool's `filename` and `paths` with that directory as text, so the provider refuses a call whose `filename` or `paths` really lies outside it, through a link or otherwise, before the call reaches the server; the model reads one sentence asking for a path inside the chat's folder. While `.playwright-mcp` itself is a link that leads outside the directory, every browser tool call is refused, because the server saves default-named files and downloads there without a file argument. The test resolves each name against the directory and against `.playwright-mcp`, and does not cover a path that changes between the test and the server's use. After each call, the provider checks again: it resolves the call's `filename` and every folder that a link inside `.playwright-mcp` leads to outside the directory, removes a plain file the call just created there without following any link, and replaces the call's result with a refusal and one log line. That check runs after the server has written, so it is a refusal, not a barrier: a chat with Full access runs outside the sandbox and can replace `.playwright-mcp` between a test and the server's write, as it can do every other Full access action; the file is then caught and removed, not prevented. Screenshots require an attachment store and an image-capable model route; other routes receive the MCP image diagnostic. The MCP client also exposes resource helpers and attributed server instructions. Browser instructions are shown only after this Session owns a connection; targeted resource requests enforce the same ownership.

#### Token effect

The catalog, resource helpers, and server instructions add tool definitions and prompt text. Calls add arguments, text, and admitted images to Session history. Inline image bytes stay outside model-visible history.

#### KV Cache effect

An unchanged catalog preserves its tool-definition prefix. Results append to history; provider or catalog changes can reduce prefix reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The integration retains the pinned server's browser and tool restrictions.

- Chrome and Chromium only; Firefox and WebKit are not selectable.
- Startup failure or cancellation rejects Session creation or resume and triggers client cleanup. A disconnected client is not retried; after fixing the cause, create a new Session or unload and resume the existing one.
- Attachment exclusivity is local to this provider instance. Other processes and browser users can still modify the same pages.
- The shared resource-server inventory can show inherited server names; it does not grant access to another Session's browser.
- Cancellation does not undo navigation, clicks, or other actions already delivered to the browser.
- Tool schemas follow the pinned experimental dependency and carry no DSH stability promise.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
