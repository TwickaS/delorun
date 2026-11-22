<!-- Fill in this description following .agents/skills/dsh-pr-description/SKILL.md. -->

## Problem

<!-- One problem only. Reference an issue or discussion in this repository: Fixes #N or Refs #N. -->

## Change

<!-- What the pull request changes. -->

## Scope

<!-- What it leaves alone. If a file outside delorun/ changes, name the Delorun feature the change serves. -->

## Verification

<!-- How you found the problem, how you checked the fix and what you saw. A change to what people see needs before and after screenshots. -->

- <!-- Test item. -->

  <details>
  <summary>Proof</summary>

  </details>

## Checklist

- [ ] Each commit carries a `Signed-off-by` line from `git commit -s`. A pseudonym is accepted.
- [ ] If the pull request changes a file outside `delorun/`, the Scope names the Delorun feature the change serves. Maintainers' tooling writes the ledger entry at merge; do not edit `delorun/upstream-patches.json`.
- [ ] A generic fix to an upstream file is in its own commit.
- [ ] A visible change has a recording, or the Verification section says it is a small fix and a maintainer records it at merge.
- Changelog: a fragment path under `delorun/changelog/unreleased/`, or `Changelog: none (reason)`.

## AI usage

- **Model and tool:** <!-- e.g. Claude Sonnet 5.5 in Claude Code, or "none". -->
- **What the agent did:** <!-- One or two lines. -->
- **What a person decided or checked:** <!-- One or two lines. -->

The person who opens the pull request is responsible for it, whether or not an AI agent wrote it. A pull request written with an agent gets the same checks and review as any other.
