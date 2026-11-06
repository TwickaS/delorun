# Agent Note: Anything leaving the machine is opt-in, and Delo has no telemetry of its own

Status: implemented

English | [中文](2026-11-06-delo-opt-in-data-sharing.zh.md)

## Problem

Stock DSH sends data to DeepSeek by default in two ways: its session-log upload is on by default, and its desktop application has product analytics. A person who installs Delo must not find that data has left the machine because of a default they did not choose. Delo does not add a collection of its own.

## Decision

Delo has no telemetry of its own. Upstream's desktop analytics and DeepSeek session-log upload remain available, and they are off unless the person turns them on. Any telemetry that Delo adds is opt-in, with its exact payload shown.

Anything that leaves the machine is opt-in, and Delo explains what an option sends before the option takes effect. A request from Delo to a Delo host that is on by default needs a lead's approval and an entry in the network test's allowlist, as the root guide's rule for new default-on requests requires.

In the parity composition, the session-log upload keeps the stock value. The recorded scenarios exercise the shipped default, so the stock value keeps them matching the expected output. The default that a fresh install gives the person is off.

## Verification

Each upload and analytics setting has the default off for a fresh install, and a test asserts that default in Delo's composition. The parity replay checks the stock value in the parity composition. The [parity checklist](../../../../delo/docs/reference/glossary.md) lists each setting and its default.

## Related

The [session-log upload default decision](../architecture/2026-09-14-session-log-upload-default.md) makes the upload on by default in every process. This decision departs from it for Delo, whose fresh-install default is off. The upstream decision stays in force for stock DSH, and this note does not change it.

The [bounded upload decision](../architecture/2026-09-24-bounded-session-log-upload.md) limits the size of each upload once the upload is enabled. Delo keeps those bounds.

The [explicit-feedback decision](../architecture/2026-09-05-nonofficial-feedback-otel.md) sends feedback only after the person creates a feedback event. This decision does not change that rule.

## Alternatives considered

**Upstream's defaults.** Keeping the upload and analytics on would send data from every fresh Delo install without a choice, which the stock-first rule of the project forbids.

**Removing the features.** Removing the upload and analytics would make every upstream merge conflict with deleted code, and it would remove an option that a person may choose.

## Consequences

A fresh Delo install sends nothing about the person to DeepSeek or to any other service unless the person turns an option on.

The parity composition keeps the stock upload value, so the recorded scenarios still match, while the fresh-install default differs. The parity checklist records this difference.

A fresh install has no telemetry of Delo's own to turn off.
