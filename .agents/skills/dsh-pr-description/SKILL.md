---
name: dsh-pr-description
description: Use when creating a deepseek-harness pull request, or when updating its description after later changes or a handled review round. Defines each description section, Issue references, test design, change-specific disclosures, and the AI usage section with its three labelled lines and update timing.
user-invocable: false
---

# Writing PR descriptions

This skill defines what a deepseek-harness PR description contains, how to write it, and when to update it. The [PR template](../../../.github/pull_request_template.md) supplies only the section headings and placeholders; this skill owns the requirements for each section. Every PR description follows this skill, including PRs created with `gh pr create --body-file`, which skips the template.

## Scope

- Write the complete description when you create the PR.
- After the PR exists, update the affected sections when the description no longer matches the PR, at times you judge suitable.
- Each PR in a stack has its own description, which covers only that layer's changes against its base branch.

## Description structure

The description uses four second-level headings, in this order: `## Motivation`, `## Changes`, `## Testing`, and `## AI usage`.

Write fixed section headings and labels, such as **Interface changes**, **Behavior changes**, **Test design**, and **Test entries**, in English. Write table headers and the rest of the description in the PR description's language, Chinese unless a human asked for another language.

### Motivation

- State the problem in one sentence.
- Reference at least one same-repository Issue: use `Fixes #N`, `Closes #N`, or `Resolves #N` when the PR resolves it, and `Refs #N` when it only gives context. PR numbers do not count as Issue references, and neither do references inside HTML comments, code fences, or inline code. [Issue management](../../../.github/issue-management/README.md) owns the exact rules and the Priority matching.

### Changes

- Interface changes: summarize changes to commands (including repository scripts), flags, configuration keys, environment variables, public exports, plugin registration values, protocols, or persisted formats; write None when there are none.
- Behavior changes: summarize results that users, models, developers, or the system can observe, including defaults, performance, timing, and output; write None when there are none. Changes to documentation and agent instructions, such as READMEs, AGENTS.md, and skills, are behavior changes for the readers they guide.
- State only behavior that the diff guarantees and the tests cover.

### Testing

Testing starts with the test design, followed by the test entries.

**Test design**: summarize how the tests cover each item in Changes and why that coverage is complete. Choose the form by change type:

| Change type | What the test design shows |
|---|---|
| Behavior change | A behavior matrix of scenario × behavior before × behavior after × covering test, showing which scenarios failed or differed before the change |
| Performance change | Before and after values per stage or scenario, with the measurement conditions: machine, run count, and how the value is taken |
| Refactoring or migration without behavior change | How the unchanged behavior is shown: byte-for-byte comparison, unchanged snapshots, or old-versus-new comparison tests |
| Documentation only | How the content is checked: links, bilingual pairing, example compilation, or similar |

When the PR mixes change types, give one form for each type present. Items that Changes lists as None need no test design.

**Test entries**:

- Add one entry per test method; state the command or steps visibly, and the behavior it covers.
- List only tests that have run, with their results; add later runs when the description is updated. State whether the evidence comes from a local run or from CI.
- Put reviewable evidence, such as test output, screenshots, recordings, or logs, in that entry's `<details><summary>Proof</summary>` block; when the full output is long, the block may hold the command, the counts, and a result summary.

### Change-specific disclosures

Write each disclosure in the section it concerns, usually Changes, after a bold English label that names it, such as **Existing test behavior**; do not add headings.

| Change | What the description states | Rule owner |
|---|---|---|
| Changing the behavior an existing test describes | Why the behavior changed | The Tests describe behavior rule in [root AGENTS.md](../../../AGENTS.md) |
| Raising a ceiling in `scripts/doc-budgets.manifest.json` | Each raised ceiling with its old and new value, and why the words are necessary | [Wordcount budgets](../../../docs/AGENTS.md#wordcount-budgets) |
| Changing product-user-visible GUI behavior | An embedded demonstration GIF, with the disclosures that record-browser-gif requires beside the embed; for each GUI change without a GIF, a statement that none is embedded and why | [record-browser-gif](../record-browser-gif/SKILL.md#every-gui-pull-request-includes-a-gif) |
| Using a translation term the terminology list lacks | The source of the rendering, or a proposed rendering under pending terms | [Translation rules](../../../docs/i18n/translation-rules.md) |

## AI usage

This section says in plain words which agent helped and who answers for the change. It has no levels, stages or percentages.

```markdown
## AI usage

- **Model and tool:** <e.g. Claude Sonnet 5.5 in Claude Code, or "none">
- **What the agent did:** <one or two lines>
- **What a person decided or checked:** <one or two lines>

The person who opens the pull request is responsible for it, whether or not an AI agent wrote it. A pull request written with an agent gets the same checks and review as any other.
```

- Keep the three labelled lines in this order and keep the closing paragraph as it is.
- Write "none" for the model and tool when no agent helped, and say so in the next two lines.
- State what the agent did and what a person decided or checked as settled fact, in one or two lines each.
- Refer to people as the author or a reviewer, never by username. Leave out session ids, direct quotes, and the running or handling of checks and CI.
- When the description is updated after the PR exists, rewrite the lines so that they cover all the work so far; do not append a history of changes.

## Creating and updating the description

1. Write the description to a file that git ignores, such as `.artifacts/pr/body.md`. Create the PR with `gh pr create --body-file <file>`, or update it with `gh pr edit <number> --body-file <file>`; when the description embeds a GIF, follow [record-browser-gif](../record-browser-gif/SKILL.md) and use `--attach`.
2. Before an update, save the current description with `gh pr view <number> --json body --jq .body`, and change only the sections that need it: keep content and media the author wrote, and remove statements that no longer match the code. When the description still has an old `## AI Usage` declaration block with a badge and a stage table, or the old `## Agent` and `## Human and Agent Roles` headings, replace it with the one `## AI usage` section; keep only one such section.
3. After writing, read the description back and confirm that all four sections are present, that AI usage matches the current code, and that no old declaration block, badge, stage table or `## Human and Agent Roles` section remains.
