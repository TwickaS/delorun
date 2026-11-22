---
description: "Prompt injection and data exfiltration in Delorun: the three things an attack needs, what a workspace's network setting (open, allowlist, off) closes for sandboxed commands and web_fetch, what stays open whatever the setting, and practical advice."
---

# Prompt injection and data exfiltration

English | [中文](prompt-injection.zh.md)

## Summary

This page helps you decide how much network each workspace should have, so that text the model reads cannot make it send your private data away. You need Delorun running ([Install and first run](../get-started/install.md)) and at least one [workspace](../../reference/glossary.md#workspace).

Any text the model reads can carry instructions: a web page, a file in a repository, an issue, a package's README, a tool's output or another chat. This is called [prompt injection](../../reference/glossary.md#prompt-injection). The model cannot reliably tell those instructions from yours, and neither can Delorun. An attacker who gets text in front of the model can ask it to find private data and send it somewhere the attacker reads. Delorun does not stop the model from reading such text. It lets you take away the way out: each workspace has a [network setting](../../reference/glossary.md#network-setting), **Open**, **Allowlist** or **Off**, that limits what its commands and `web_fetch` can reach. This page says what each setting closes, what stays open whatever you choose, and how to choose.

## Contents

- [The three ingredients](#the-three-ingredients)
- [The network setting](#the-network-setting)
- [What each setting closes](#what-each-setting-closes)
- [What no setting closes](#what-no-setting-closes)
- [Practical advice](#practical-advice)
- [Changing the setting](#changing-the-setting)
- [For the technically curious](#for-the-technically-curious)

## The three ingredients

Stealing data this way needs all three of these at once. Take any one away and it fails.

1. **Private data the model can reach.** Files in the workspace, a `.env` file, keys under your home folder that commands can read, the chat's own history. On Linux, WSL2 included, the [sandbox](../../reference/glossary.md#sandbox) keeps commands out of Delorun's [home](../../reference/glossary.md#home) (`~/.delorun`), but commands can read the rest of your disk that you can read. Where the sandbox cannot enforce reads, as on native Windows, which Delorun 0.1.0 does not support, they can read Delorun's home too.
2. **Untrusted text that reaches the model.** Pages `web_fetch` returns, files you did not write, a dependency's source, an issue or pull request, the output of a command, a reply from an [MCP server](../../reference/glossary.md#mcp-server).
3. **A way out.** Anything that puts data where the attacker reads it: a command that sends a request to the attacker's server, a `web_fetch` of a web address that carries the data, a [plugin](../../reference/glossary.md#plugin) or MCP server that sends it, or data placed in something you later share.

The first two are usually present in real work. The network setting works on the third.

## The network setting

Each workspace has one of three settings. A workspace you have not chosen for uses the default, which is **Open** unless your configuration says otherwise.

| Setting | Commands in the sandbox | `web_fetch` |
| --- | --- | --- |
| Open | Reach any host, as in stock DeepSeek Harness | Fetches any public address; the [fetch guard](../../reference/glossary.md#fetch-guard) refuses private, loopback and link-local addresses |
| Allowlist | Reach only the hosts you list | Fetches only addresses whose host is on the list |
| Off | No network | Refused |

The setting applies to every command the model runs in the sandbox, including terminals, background jobs and `run_code` programs, whichever [permission preset](../../reference/glossary.md#permission-preset) the chat is on. A command under [full access](../../reference/glossary.md#full-access) runs outside the sandbox and reaches the network whatever the setting says.

Under Allowlist, a command reaches the network only through a small proxy that Delorun runs, which checks each host against your list. Most tools use it without help: `curl`, `git` over HTTPS, `npm`, `pip`, `cargo` and Node's own HTTP clients. A tool that ignores the proxy settings the command gets has no network at all.

An entry is one of these:

- a host name such as `registry.npmjs.org`;
- a wildcard such as `*.npmjs.org`, which matches every name below `npmjs.org` but not `npmjs.org` itself;
- a public IP address.

An entry allows ports 80 and 443. To allow another port, write it after a colon, such as `github.com:22` for Git over SSH; that entry then allows only that port. An entry has no `https://` and no path. Avoid a wildcard on a domain where anyone can publish a site, such as `*.github.io`, `*.workers.dev`, `*.vercel.app` or `*.herokuapp.com`: it admits hosts that other people control, so a command can send your data to a site an attacker set up there. List the exact host instead.

The proxy refuses a listed name that points to a private, loopback or link-local address, so a listed name cannot be aimed at your router or at a service on your computer. Each refusal comes back to the model as a sentence naming the host, and Delorun logs it.

Delorun enforces Allowlist and Off only where the sandbox can: bubblewrap on Linux, which includes WSL2. Where it cannot, a workspace set to Allowlist or Off refuses to run commands at all and says why, instead of running them with your network. Setting it back to Open runs them again.

<details>
<summary>Edge cases</summary>

- If your sandbox is Landlock alone (a Linux system without bubblewrap) or any platform other than Linux, then a workspace set to Allowlist or Off refuses to run commands — set it to Open to run them.
- If a command needs the system D-Bus, such as `systemctl`, `timedatectl` or `nmcli`, or prints, then it fails in a workspace set to Allowlist or Off — use Open for that workspace, or run the command in your own terminal.
- If a tool ignores the proxy settings, then it has no network under Allowlist — use a tool that honours `HTTPS_PROXY`, or list the hosts under Open.
- If a command needs to download dependencies and the workspace is Off, then it fails — install them first, or use Allowlist with your registries.
- If a terminal or background job started before you tightened the setting, then it keeps the network it started with — restart the workspace's terminals and jobs.

</details>

## What each setting closes

- **Open** closes nothing. Commands can send anything anywhere. This is stock DeepSeek Harness's behaviour and Delorun's default.
- **Allowlist** closes every connection that commands and `web_fetch` open themselves, except to the hosts you list. What stays open is what those hosts accept. A command that can reach `github.com` can push to any repository your Git credentials allow, or open an issue there. A command that can reach a package registry can publish to it with credentials it finds. List the fewest hosts that the work needs.
- **Off** closes every network connection that commands and `web_fetch` open themselves. Commands that need to download dependencies fail.

Both restrictive settings hold against a command that opens the network itself. Against a command that asks another program outside the sandbox to open it, they hold only as far as the sandbox hides that program. The sandbox hides your login session's services under every setting, and the name-lookup, printing and system services under Allowlist and Off. Some programs listen in your home folder and connect for whoever asks: an ssh connection you opened with `ControlMaster`, through which a command can reach that server, or gpg's `dirmngr` on a system without a runtime directory, which fetches keys from key servers. Treat Allowlist and Off as closing the routes a command opens itself, not every route.

## What no setting closes

The setting governs commands in the sandbox and `web_fetch`. These routes stay open under every setting:

- **Full access.** A command approved to run outside the sandbox, or a workspace on full access, runs with your network.
- **Plugins and MCP servers.** They run outside the sandbox, with your network. An MCP server that fetches web addresses or posts messages is a way out if the model can call it with your data.
- **Plugins the model writes.** Under the Web `cordis` preset, the model writes plugins and installs them through plugin management. They run in the harness's own process, outside the sandbox, with your network.
- **Agents and language servers Delorun starts.** The Claude Code and ACP subagent tools start their agent programs, and the language-server tool starts language servers, outside the sandbox. Delorun asks before an [external agent](../../reference/glossary.md#external-agent) runs.
- **`web_search`.** The query goes to the search provider your profile configures, under every setting. It reaches that provider and nobody else.
- **The model's reply.** The model can put data into its answer. In the studio on your computer, an image that a reply links to is loaded from its host, so the image's address, and anything written into it, reaches that host. On a phone over remote access it shows as a placeholder instead. A link you click sends its address the same way.
- **Files you share later.** The model can write data into files in the workspace, a commit message or a pull request description. It leaves when you push, publish or send them.
- **The model provider.** Everything in the chat goes to the [provider](../../reference/glossary.md#provider) that runs the model. That is how the model works, and no setting changes it.

## Practical advice

- Keep secrets out of workspaces. Use environment files outside the workspace, and keys the model never needs.
- For a workspace that holds secrets, or that works on code, issues or pages you did not write, choose Allowlist with only the hosts the work needs, or Off.
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

Open Settings, Safety, Network, in the studio on the computer that runs Delorun, and choose the setting for each workspace. When it worked, the workspace shows the setting you chose. Tightening applies at once. A change that lets commands reach more, such as Off to Open or a new host or port on a list, asks you to confirm it first.

Only that computer can read and change the setting. A phone over remote access cannot open it, and the model has no tool that changes it. The one exception is a plugin the model writes under the `cordis` preset, which runs with the harness's own access.

<details>
<summary>Edge cases</summary>

- If the file that holds the setting is damaged or other users can read it, then every workspace counts as Off — repair or remove the file that Settings, Safety, Network names.
- If you chose [**Ask less (like DeepSeek Harness)**](../../reference/glossary.md#ask-less) in setup, then the page says the setting is not available — run `delorun setup prompts` and choose [Ask me first](../../reference/glossary.md#ask-me-first).
- If you are on a phone, then you cannot open the page — use the computer that runs Delorun.
- If you tighten a setting while commands run, then they keep the network they started with — restart the workspace's terminals and jobs. A command whose list was removed loses its proxy and keeps no network.

</details>

<details>
<summary>Go further</summary>

- **Add common hosts** in the Allowlist editor adds the starter hosts above for npm, PyPI, GitHub, crates.io or Go. Review the list, then save.
- Set the default for workspaces you have not chosen for in the `delorun-permission-defaults` row of your profile's `cordis.yml` ([For the technically curious](#for-the-technically-curious)).
- Read [What Delorun protects](safety.md) for the other protections that work beside this one.

</details>

**Next.** To see every protection together, read [What Delorun protects](safety.md). If a command is refused, find its message in [Troubleshooting](../help/troubleshooting.md#protections-and-plugins).

## For the technically curious

The default for workspaces you have not chosen for is the `network` and `allowedHosts` setting of the `delorun-permission-defaults` row in your profile's `cordis.yml`, which plugin management in a chat cannot change. The proxy limits the connections it holds for each list and closes idle ones; both limits are set in that row.

Under Allowlist the proxy checks the host name and port before anything else, so a name that is not listed is never looked up, and a command cannot send data out in DNS questions. It connects only to the addresses it checked, and sends a plain-HTTP request with the host name it checked. The proxy does not read inside an HTTPS connection: it checks the name the command asks to connect to, not the name inside the encrypted connection, so a host that serves many sites from one address, such as a content delivery network, can be asked for a site that is not on your list. A wildcard lets a command ask the proxy to look up any name below that domain, which reaches that domain's DNS servers.

The command's `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` variables name the proxy. Under Allowlist and Off the sandbox hides the sockets of the services that look names up or send traffic for a program: systemd-resolved, nscd, avahi, snapd, the printing service CUPS, the system D-Bus and Tailscale's daemon. If the file that holds the setting is damaged or readable by other users, every workspace counts as Off, and confined commands cannot read or write it.

The [threat model](../../security/threat-model.md) gives the defences and limits in full, and [execution vectors](../../security/execution-vectors.md) lists the routes that run outside the sandbox.
