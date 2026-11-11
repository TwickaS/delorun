---
description: "Prompt injection and data exfiltration in Delo: the three things an attack needs, what a workspace's network setting (open, allowlist, off) closes for sandboxed commands and web_fetch, what stays open whatever the setting, and practical advice."
---

# Prompt injection and data exfiltration

English | [中文](prompt-injection.zh.md)

## Summary

Any text the model reads can carry instructions: a web page, a file in a repository, an issue, a package's README, a tool's output or another chat. The model cannot reliably tell those instructions from your own, and neither can Delo. An attacker who gets text in front of the model can ask it to find private data and send it somewhere the attacker reads. Delo does not stop the model from reading such text. It lets you take away the route out: each workspace has a network setting, `open`, `allowlist` or `off`, that limits what its sandboxed commands and `web_fetch` reach. This page says what each setting closes, what stays open whatever you choose, and how to choose.

## Contents

- [The three ingredients](#the-three-ingredients)
- [The network setting](#the-network-setting)
- [What each setting closes](#what-each-setting-closes)
- [What no setting closes](#what-no-setting-closes)
- [Practical advice](#practical-advice)
- [Changing the setting](#changing-the-setting)

## The three ingredients

An exfiltration needs all three of these at once. Take any one away and it fails.

1. **Private data the model can reach.** Files in the workspace, a `.env` file, keys under your home directory that commands can read, the chat's own history. Delo's sandbox keeps commands out of Delo's home (`~/.delo`) on Linux and macOS, but commands can read the rest of your disk that your user can read, and on Windows they can also read Delo's home.
2. **Untrusted content that reaches the model.** Pages `web_fetch` returns, files you did not write, a dependency's source, an issue or pull request, the output of a command, a reply from an MCP server.
3. **A route out.** A way to put data where the attacker reads it: a command that sends a request to the attacker's server, a `web_fetch` of a URL that carries the data, a plugin or MCP server that sends it, or data placed in something you later share.

The first two are usually present in real work. The network setting works on the third.

## The network setting

Each workspace has one of three settings. A workspace you have not chosen for uses the default, which is `open` unless your configuration says otherwise.

| Setting | Sandboxed commands | `web_fetch` |
| --- | --- | --- |
| `open` | Reach any host, as in stock DeepSeek Harness | Fetches any public address; the fetch guard refuses private, loopback and link-local addresses |
| `allowlist` | Reach only the hosts you list, through Delo's egress proxy | Fetches only URLs whose host is on the list |
| `off` | No network | Refused |

The setting applies to every command the model runs in the sandbox, `read-only` or `workspace-write`, including terminals, background jobs and `run_code` programs. A command under full access runs outside the sandbox and reaches the network whatever the setting says.

Under `allowlist`, a command reaches the network only through an HTTP proxy that Delo runs. The command's `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` variables name it, and most tools use them: `curl`, `git` over HTTPS, `npm`, `pip`, `cargo` and Node's own HTTP clients. A tool that ignores these variables has no network at all. The proxy:

- checks the host name against the list before anything else, so a name that is not listed is never looked up, and a command cannot send data out in DNS questions;
- refuses a listed name that resolves to a private, loopback, link-local or other address the fetch guard refuses, so a listed name cannot be pointed at your router or a service on your computer;
- connects only to the addresses it checked;
- answers each refusal with a sentence naming the host, which the model reads, and writes the refusal to the harness's log.

An entry is a host name such as `registry.npmjs.org`, a wildcard such as `*.npmjs.org` that matches every name below `npmjs.org` but not `npmjs.org` itself, or a public IP address. An entry has no scheme, port or path; any port on a listed host is allowed.

The setting is enforced only where the sandbox can enforce it: with bubblewrap on Linux, and so under WSL2. On a Linux system that confines commands with Landlock alone, on Windows and on macOS, a workspace whose setting is `allowlist` or `off` refuses to run commands at all, with a message saying why, rather than run them with your network. Setting it back to `open` runs them again.

## What each setting closes

- **`open`** closes nothing. Commands can send anything anywhere. This is stock DeepSeek Harness's behaviour and Delo's default.
- **`allowlist`** closes every route from commands and `web_fetch` except the hosts you list. What stays open is what those hosts accept. A command that can reach `github.com` can push to any repository your Git credentials allow, or open an issue there; a command that can reach a package registry can publish to it with credentials it finds. A wildcard lets a command ask the proxy to look up any name below that domain, which reaches that domain's DNS servers. List the fewest hosts that the work needs.
- **`off`** closes every network route from commands and `web_fetch`. Commands that need to download dependencies fail; install them before you switch, or use `allowlist` with your registries.

## What no setting closes

The setting governs sandboxed commands and `web_fetch`. These routes stay open under every setting:

- **Full access.** A command approved under `danger-full-access`, or a workspace whose preset is full access, runs outside the sandbox with your network.
- **Plugins and MCP servers.** They run outside the sandbox, in the harness or as their own processes, with your network. An MCP server that fetches URLs or posts messages is a route out if the model can call it with your data.
- **Agents and language servers the harness starts.** The Claude Code and ACP subagent tools start their agent processes, and the language-server tool starts language servers, outside the sandbox.
- **`web_search`.** The query goes to the search provider your profile configures, under every setting. It reaches that provider and nobody else.
- **The model's reply.** The model can put data into its answer. In the studio on your computer, an image that a reply links to is loaded from its host, so the image's URL, and anything written into it, reaches that host; on a phone over remote access it shows as a placeholder instead. A link you click sends its URL the same way.
- **Files you share later.** The model can write data into files in the workspace, a commit message or a pull request description. It leaves when you push, publish or send them.
- **The model provider.** Everything in the chat goes to the provider that runs the model; that is how the model works, and no setting changes it.
- **Commands already running.** A terminal or background job keeps the network it started with until it ends. After you tighten a setting, restart the workspace's terminals and jobs; a command whose list was removed loses its proxy and keeps no network.

## Practical advice

- Keep secrets out of workspaces. Use environment files outside the workspace, and keys the harness never needs.
- For a workspace that holds secrets, or that works on code, issues or pages you did not write, choose `allowlist` with only the hosts the work needs, or `off`.
- Review what a chat changed before you push, publish or share it. Read links and images in replies before you open them.
- Do not grant full access in a workspace that reads untrusted content.
- Choose MCP servers and plugins as you would choose any program you run with your own access.

A starter list for common package registries and Git hosts follows. Nothing on it is allowed until you add it to a workspace's list, and each host you add is a host a command can send data to.

| Purpose | Hosts |
| --- | --- |
| npm | `registry.npmjs.org` |
| PyPI | `pypi.org`, `files.pythonhosted.org` |
| crates.io | `crates.io`, `index.crates.io`, `static.crates.io` |
| Go modules | `proxy.golang.org`, `sum.golang.org` |
| GitHub | `github.com`, `codeload.github.com`, `objects.githubusercontent.com` |

## Changing the setting

Open Settings, Network, in the studio on the computer that runs Delo, and choose the setting for each workspace. Tightening applies at once. A change that lets commands reach more, such as `off` to `open` or a new host on a list, asks you to confirm it first. The setting is read and changed only at that computer: a phone over remote access cannot open it, the model has no tool that changes it, and confined commands cannot read or write the file under `~/.delo` that holds it. If that file is damaged or other users can read it, every workspace counts as `off` until you fix it. The default for workspaces you have not chosen for is the `network` and `allowedHosts` setting of the `delo-permission-defaults` row in your profile's `cordis.yml`, which plugin management in a chat cannot change.

The [threat model](../security/threat-model.md) gives the defences and limits in full.
