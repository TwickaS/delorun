---
name: delorun-report-problem
description: Help the person report a problem with Delorun by drafting a GitHub issue for them to review. Load when the person says "Help me report this", asks how to report a bug, or wants an issue written up.
---

# Helping the person report a problem

You draft the issue. You never post it: the person reviews it and sends it themselves. Do not run `gh issue create`, open a browser to submit, call a GitHub API or send the text anywhere.

## Ask first

1. Ask what went wrong, in one question: what they did, what they expected and what happened. If they have already said, do not ask again.
2. Ask whether the problem happens on stock DeepSeek Harness too, only if they can say. "Not tried" is a fine answer.

## Gather what you can read

- Delorun's version: run `delorun --version`.
- The system: the operating system and architecture, from the environment you run in.
- Recent errors: run `delorun logs -n 40 --since 1d` and keep only the lines that relate to the problem. Delorun redacts its logs; read what you keep and remove anything private (names, paths, addresses) that the report does not need.
- Do not read the person's chats, files or settings to find more. Ask them instead.

## Draft the issue

Use the sections of the project's bug form, `.github/ISSUE_TEMPLATE/bug_report.yml`, in this order, each under its own heading:

1. **Version**: the output of `delorun --version`, with the system on the same line.
2. **Does stock DeepSeek Harness reproduce it?** Yes, No or Not tried.
3. **Steps to reproduce**: the smallest numbered steps.
4. **What happened**: the result seen and the result expected.
5. **Logs**: the trimmed, reviewed lines, in a text block.

Write plainly and briefly. Do not guess at a cause. Leave a section as "Not known" rather than invent it.

## Hand it over

Show the finished draft in one block. Tell the person to copy it, or to use Settings → About → Report a problem to open the pre-filled form and paste the draft into it. Say that nothing has been sent. If a vulnerability is involved, tell them to report it privately as SECURITY.md describes instead of in a public issue.
