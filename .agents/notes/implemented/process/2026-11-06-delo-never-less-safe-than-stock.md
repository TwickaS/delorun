# Agent Note: Delo never moves an approval, refusal or escalation toward less safety

Status: implemented

English | [中文](2026-11-06-delo-never-less-safe-than-stock.zh.md)

## Problem

Delo changes defaults and adds tools, and any such change can move an approval, a refusal or an escalation: a permission decision, a sandbox escalation or a refusal of a request. A move toward less safety can look like an ordinary configuration change in review. Review by convention relies on each reviewer knowing every gate and every safe exemption, and a trade-off that lowers one protection while raising another is hard to judge without a fixed rule.

## Decision

Every change that moves an approval, a refusal or an escalation carries three things. It has the `security` class in the [divergence ledger](../../../../delo/upstream-patches.json). A lead verdict is recorded with it. It includes a denial test that fails before the change and passes after it, or a denial test that shows the refusal holds.

A Delo exemption from a stock check is narrow, names the check and the case it covers, and sits behind a switch that is off in the parity composition. A change does not lower the safety of any stock path, even when it adds capability elsewhere.

## Verification

The ledger schema defines the `security` class as the class of a file that moves an approval, a refusal or an escalation and carries a lead verdict. Denial tests run against local stand-ins, as the root guide requires for security work. The stock approval gate's fail-closed behaviour is the baseline that every exemption must keep.

## Related

The [approval seam decision](../feature/2026-07-06-approval-seam.md) defines the stock approval decision. A request is denied when no answerer is composed, and Delo's exemptions do not change that rule.

## Alternatives considered

**Review by convention only.** Reviewers would need to know every check and exemption from memory, and a move toward less safety in a default would pass review without a test that shows it.

**Allowing equal-risk trade-offs.** A change that lowers one protection and raises another gives the person a protection they did not choose. The two protections are not comparable in the person's terms, so the trade-off cannot be checked against the stock path.

## Consequences

Changes that move an approval, a refusal or an escalation take longer, because each needs a lead verdict and a denial test.

The ledger lists every security-relevant change, so a reviewer can find them without reading each diff.

A Delo exemption needs a switch that the parity composition turns off, so the stock behaviour stays reachable in a replay.
