---
description: "Straight answers to the hard questions about Delorun: why it is built on DeepSeek Harness, why it is not plugins on stock, what it means that agents wrote most of it, how safe it is, and what the catch is."
---

# Questions and answers

English | [中文](questions.zh.md)

## Summary

This page answers the questions a careful person asks before running a tool that works on their computer. I write the answers myself, as the maintainer, and I say where Delorun falls short as plainly as where it is strong. You need nothing first. If you want the details behind an answer, each one links to the page that owns them.

## Contents

- [Why is Delorun built on DeepSeek Harness?](#why-is-delorun-built-on-deepseek-harness)
- [Why not just plugins on stock?](#why-not-just-plugins-on-stock)
- [Agents wrote most of it. Why should I trust that?](#agents-wrote-most-of-it-why-should-i-trust-that)
- [How safe is it?](#how-safe-is-it)
- [What does "undo everything" cover?](#what-does-undo-everything-cover)
- [What is the catch?](#what-is-the-catch)
- [Where do I go next?](#where-do-i-go-next)

## Why is Delorun built on DeepSeek Harness?

I wanted a harness I could shape to my own work and change without fear. DeepSeek Harness is the best base for that I have found: everything in it is a plugin, so almost anything can change. Its authors solve the technical problem: the agent loop, the model providers and the plugin system. I build the other half, the product around it: the studio, the defaults, the first run, the updates and the safety.

So Delorun is its own product, with DeepSeek Harness as the technology underneath it, as Unix is under macOS. Your DeepSeek Harness plugins run on Delorun and it imports your chats, so you can leave either way. Delorun is independent: it is not a DeepSeek product and DeepSeek does not endorse it.

Building on someone else's code has a cost. Upstream changes every week and takes no outside pull requests, so I carry my edits to its files for good and merge each of its releases myself. I keep that cost low by building on plugins and Delorun's own packages wherever I can, and I record each change to an upstream file with the feature it serves ([the divergence index](../../reference/parity-with-deepseek-harness/divergence/README.md)).

## Why not just plugins on stock?

A stock plugin can add remote access, a sidebar or a theme, and many good ones do. What a plugin cannot do is change how the whole harness is delivered and protected. Signed updates that show what they would change, a saved copy of your setup before each update, one command that takes you back, a safe mode, and protections that apply across the whole harness need a distribution, not one more plugin.

That is what Delorun is. The things you see are the smaller part. If you are happy on stock with your own plugins, you may not need Delorun. If you want updates you can trust and change you can undo, [Switching from DeepSeek Harness](../get-started/switching.md) says what is different.

## Agents wrote most of it. Why should I trust that?

Because of what happens to every change, and not because of who typed it. I direct the project and agents write most of the implementation. Every change passes review, denial tests that fail when a protection is removed, and recorded checks that replay real sessions. A protection is called enforced only where a test proves it. The [security fundamentals](../../security/fundamentals.md) list each rule with the code that enforces it and the test that proves it.

I have not read every line myself, and nobody outside the project has reviewed the code. Both are real limits, and Delorun is a preview because of them ([What you trust when you use Delorun](../safety-and-updates/trust.md)). Code written by people is not automatically safer, and I would rather you check my claims than take my word for them: `delorun verify` and the denial tests exist for that.

## How safe is it?

Safer than running an agent with nothing around it, and not safe enough for work you would not trust. By default a chat asks before it does anything risky. Commands run in a sandbox that confines file writes and, where your system supports it, keeps them from reading Delorun's secrets. Releases are signed and checked before they run.

The limits matter as much. Commands run with your own access, the sandbox does not confine the network unless you set it to, and the release keys are preview keys on the machine where agents run. [What Delorun protects](../safety-and-updates/safety.md) and [What you trust when you use Delorun](../safety-and-updates/trust.md) state each of these exactly. Review the [safety notice](../../../../SAFETY.md) before you run it.

## What does "undo everything" cover?

The harness and your chats: your setup, plugins and settings come back as they were, and a failed update goes back on its own. It does not cover what an agent did to the files in your workspace, because workspace checkpoints are not built. Keep those files in git.

## What is the catch?

There is no hidden one, and these are the real ones:

- **It is a preview.** It runs on Linux and on Windows through WSL2. There is no desktop app for macOS or native Windows. The [known issues](known-issues.md) list the rough edges.
- **One person maintains it.** I reply when I can and promise no response time. [Governance](../../../../GOVERNANCE.md) says what happens to releases if I cannot act.
- **It follows an upstream that moves fast.** Delorun can diverge from DeepSeek Harness. DeepSeek Harness plugins and chat data stay compatible, and everything you see in the studio is Delorun's own.
- **How it earns.** Delorun is MIT and free, and nothing in it is held back for payment. Anything sold is a service and never a locked feature ([Roadmap](../roadmap.md#how-delorun-earns)).

## Where do I go next?

To try Delorun, read [Install and first run](../get-started/install.md). For the trust details, read [What you trust when you use Delorun](../safety-and-updates/trust.md). To tell me what is wrong with this page, open a thread in the project's GitHub Discussions or write to support@delorun.com.
