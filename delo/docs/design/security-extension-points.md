---
description: "Design of Delo's security extension points: where a plugin may add a check, a warning, a required confirmation or a refusal, and the rule, enforced by the registry, that an addition can make Delo stricter and never weaker."
---

# Security extension points

English

## Summary

Security in Delo can grow without editing its core: a plugin may add a check where a change is reviewed, a device is approved, Delo starts or Delo updates. An addition can make Delo stricter and can never make it weaker. The registry at each point runs Delo's built-in checks first and combines every result so that any refusal refuses and any required confirmation is required, and no registration can remove, replace, reorder ahead of or override a built-in check. This keeps the [security fundamentals](../security/fundamentals.md) true whatever a plugin adds.

## Contents

- [What exists today](#what-exists-today)
- [The rules](#the-rules)
- [What this does not protect against](#what-this-does-not-protect-against)
- [Denial tests](#denial-tests)
- [What is built so far](#what-is-built-so-far)

## What exists today

No extension point lets a plugin add a check to reviewing a change, approving a device, starting or updating. The verification checks that `delorun verify` reports are a fixed list in `@delo/contract-verification-checks`, which plugins do not extend.

## The rules

### The points

1. There are four extension points: **reviewing a change** in [Changes](changes.md), **approving a device** ([reach](reach.md)), **starting** a profile, and **updating** to a release ([update and rollback](update-and-rollback.md)).
2. Each point gives a registered check a read-only description of its subject: the change with its files, diff and risk summary; the device request with its label, platform and time; the profile about to start; or the update report.

### What a registrant may add

3. A registered check answers with one result: **pass**; a **warning**, a sentence the person sees beside the subject; a **required confirmation**, a named statement the person must confirm before the action goes on; or a **refusal**, with the reason the person sees.
4. A check cannot change its subject, approve anything, answer for the person or skip a later check.

### The monotonic rule

5. A registration can make Delo stricter and can never remove, replace, reorder ahead of or override a built-in check.
6. The registry runs the built-in checks first, then the registered ones in registration order, and combines every result: any refusal refuses, any required confirmation is required, and every warning is shown. The combined result is never less strict than the built-in result alone.
7. A registered check that throws or does not answer within the point's deadline counts as a refusal that names its plugin. Safe mode starts without third-party plugins and therefore without their checks, so a broken check cannot keep the person out.

### Who may register

8. Only a plugin whose content is approved through [Changes](changes.md) may register. A pending change cannot add, alter or remove a check, and removing a plugin, which removes its checks, is itself a change the person approves.
9. A registration is an effect of its plugin: it ends when the plugin is unloaded, and the registry lists every registration with its plugin, so `delorun doctor` and the studio can show what each plugin adds.

### How the rule is enforced and tested

10. The registry is the only way to add a check at these points, and the combination is one pure function that receives the built-in results and the registered results separately. Each point's denial tests run every combination of a built-in refusal, confirmation and pass against registered results of every kind, and fail if any combination is less strict than the built-in result alone.

### What the points make possible

These are examples of what the points make possible. Delorun includes none of them ([roadmap](../guide/roadmap.md)).

- A PIN, set at the computer, that the home asks for as a required confirmation before an action. Letting a remote session grant full access with a PIN would also change a fundamental, which needs the decision that [the fundamentals page](../security/fundamentals.md#changing-a-fundamental) describes.
- Plugin signing: a refusal for a change whose plugin is not signed by a key the person trusts.
- An organisation's policy: refusals and required confirmations for the changes, devices and updates its policy names.
- An isolated plugin process: a refusal at start for a plugin that is not configured to run in its own process.

## What this does not protect against

- **The plugin that registers.** A registering plugin runs with the harness's authority like any plugin. The registry keeps its check from weakening another check; it does not keep the plugin's own code from doing harm.
- **Code outside the points.** A plugin can act at points that are not extension points, through upstream's other seams; the points govern only the four decisions above.
- **Safe mode.** A start in safe mode runs without third-party checks, by design.

## Denial tests

- `a registered pass does not turn a built-in refusal into an approval`
- `a registered check runs after every built-in check`
- `any registered refusal refuses the action`
- `any registered confirmation is required before the action goes on`
- `a registered check that throws or times out refuses and names its plugin`
- `a plugin with a pending change cannot register a check`
- `a registered check receives no way to change its subject`

## What is built so far

Nothing of this design is built.
