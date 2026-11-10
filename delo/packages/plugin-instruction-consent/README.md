# @delo/plugin-instruction-consent

The instruction-layer consent: the service behind the seam that keeps a person's instruction-layer files — skills, presets, and a workspace's `AGENTS.md` — from being rewritten by a model's file tools without an approval that names the effect and shows the diff. Only upstream's file tools (`write`, `edit`, `apply_patch` and `str_replace_editor`) consult it, through the filesystem write, edit and delete intents: a shell command or a PTC script that the sandbox lets write the workspace changes an `AGENTS.md` or a project skill without asking. `@delo/bundle-local` mounts it on in the CLI profile that `delorun` starts; `delorun headless` and the desktop app run upstream's profiles, which do not mount it.


English | [中文](README.zh.md)
## What it provides

- `writeConsent` — consulted by the write tools before a model-authored file commits. A write whose target classifies as an instruction-layer file requires an approval whose text says these instructions load in every future chat of that scope and carries the diff; a refusal leaves the file unchanged.

The `sandboxModeGuard` of the session-mode seam is not this plugin's to provide: that seam keeps one provider, the full-access consent of [`@delo/plugin-permission-defaults`](../plugin-permission-defaults/README.md). A guard that refuses no switch would prove nothing the seam's own spec does not prove.

The service ignores the permission preset: the consent applies on every preset, full access included. A write the person makes in the studio's own editor asks nothing new — the seam sees writes through the model's file tools only.

## Configuration

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `false` | Delo's C16 switch `instruction_layer_consent`, off in the parity composition; on, the consent gates instruction-layer writes. |

## Tests

`tests/consent.spec.ts` covers the classification (a skill, a preset, a workspace's `AGENTS.md`, an unrelated path) and the asked/declined flow with the diff in the note.
