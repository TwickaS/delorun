---
name: delorun-studio-ux
description: Use when designing, building or reviewing anything a person sees in Delorun's studio or desktop app, including loading states, notices, the composer and themes, to meet Delorun's quality bar while keeping the stock harness intact.
---

# Delorun studio UX

Delorun's studio is upstream's studio, improved where the improvement wins and always reversible. Upstream's [`dsh-client-ui-ux`](../dsh-client-ui-ux/SKILL.md) and [`dsh-responsive-ui`](../dsh-responsive-ui/SKILL.md) apply in full; this skill adds what is particular to Delorun.

## The quality bar

- Every visible surface, loading states included, looks designed by a professional studio. A skeleton mirrors the real screen's layout and branding; a rectangle per region is not a skeleton.
- A surface is done after it is compared side by side with the screen it stands for, at desktop and phone width, in light and dark, and the comparison would satisfy a design lead.

## Stock first

- Delorun changes the studio through plugins on upstream's slots, theme layers and registries, never by patching upstream's components for appearance. Every upstream slot stays available.
- The "Stock DSH look" option restores upstream's studio in one step; a Delorun surface that cannot be turned off that way is a defect.
- Every new chat offers upstream's four modes: Standard, PTC, Minimal and Creator. A change to profile rows, presets or the plugin manager checks the composer's mode menu still lists all four and that each mode's turn shows its tools.
- When reporting a Creator-mode test, name the plugin it built plainly, so the test plugin is not mistaken for the mode.

## Theme as data

- Colours are OKLCH seed values that generate light and dark; the accent is a separate layer of a few tokens over them.
- Radius, spacing, density, elevation, type and the state roles are tokens. Delorun CSS uses tokens only: no literal colours, radii or static values, which a check rejects.
- Reuse upstream's role names (`--dsw-alias-*`) and add a role only when none fits. Text contrast is at least 4.5:1, which the theme's gate test checks.

## Act only for the person

- Never send a message on the person's behalf. A plugin that prepares a prompt writes it into the composer, and the person sends it; a start message is written once, into a chat that has never sent.
- Notices do not interrupt. An update or a status change is a small row with a popover, never a modal; a modal is for a decision the person must make before continuing.
- Choices from a small fixed set are a menu or chips, not a free text box.

## Work with the owner

Product experience changes in owner-approved steps: propose a small step with a sample or screenshot, get it approved, then build the next. Do not build a whole redesign ahead of approval.
