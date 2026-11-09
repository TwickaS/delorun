# @delo/plugin-instruction-consent

The instruction-layer consent (WP2.15, A101): the service behind the seam that keeps a person's instruction-layer files — skills, presets, and a workspace's `AGENTS.md` — from being rewritten by a model without an approval that names the effect and shows the diff.


English | [中文](README.zh.md)
## What it provides

- `writeConsent` — consulted by the write tools before a model-authored file commits. A write whose target classifies as an instruction-layer file requires an approval whose text says these instructions load in every future chat of that scope and carries the diff; a refusal leaves the file unchanged.

The `sandboxModeGuard` of the session-mode seam is not this plugin's to provide: that seam keeps one provider, the full-access consent of [`@delo/plugin-permission-defaults`](../plugin-permission-defaults/README.md) (A135). A guard that refuses no switch would prove nothing the seam's own spec does not prove.

The service ignores the permission preset: the consent applies on every preset, full access included. A write the person makes in the studio's own editor asks nothing new — the seam sees model-authored writes only.

## Configuration

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `false` | Delo's C16 switch `instruction_layer_consent`, off in the parity composition; on, the consent gates instruction-layer writes. |

## Tests

`tests/consent.spec.ts` covers the classification (a skill, a preset, a workspace's `AGENTS.md`, an unrelated path) and the asked/declined flow with the diff in the note.
