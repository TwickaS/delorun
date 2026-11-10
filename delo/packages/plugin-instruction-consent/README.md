# @delo/plugin-instruction-consent

The instruction-layer consent: the service behind the seam that keeps a person's instruction-layer files — skills, presets, and a workspace's `AGENTS.md` — from being rewritten by a model's file tools without an approval that names the effect and shows the diff. Only upstream's file tools (`write`, `edit`, `apply_patch` and `str_replace_editor`) consult it, through the filesystem write, edit and delete intents: a shell command or a PTC script that the sandbox lets write the workspace changes an `AGENTS.md` or a project skill without asking. `@delo/bundle-local` mounts it on in the CLI profile that `delorun` starts; `delorun headless` and the desktop app run upstream's profiles, which do not mount it.


English | [中文](README.zh.md)
## What it provides

- `writeConsent` — consulted by the write tools before a model-authored file commits. A write whose target classifies as an instruction-layer file requires an approval whose text says these instructions load in every future chat of that scope and carries the diff; a refusal leaves the file unchanged.

The `sandboxModeGuard` of the session-mode seam is not this plugin's to provide: that seam keeps one provider, the full-access consent of [`@delo/plugin-permission-defaults`](../plugin-permission-defaults/README.md). A guard that refuses no switch would prove nothing the seam's own spec does not prove.

The service ignores the permission preset: the consent applies on every preset, full access included. A write the person makes in the studio's own editor asks nothing new — the seam sees writes through the model's file tools only.

## Classification

The review compares each target under two spellings: the path the write tool resolved, and its physical path, the real path of the nearest existing ancestor joined with the missing tail, which is the path `@deepseek-ai/dsh-fs-local` writes. Every root and file named below is resolved the same way, so a symbolic link on either side (a linked directory in the target path, a linked home or skill root, an instruction file that links elsewhere) does not move a write out of the comparison. A path that is not absolute, as a remote backend may report, is compared as spelled.

A comparison folds letter case when the existing directory that holds the target, or the one that holds the root, sits on a case-insensitive volume. The probe takes the first entry of that directory whose name holds an ASCII letter, or the nearest such name on the directory's own path, and checks whether its case-flipped spelling names the same inode; a volume without such a name counts as case-insensitive. Each consent instance remembers the answer per directory; the platform decides nothing.

The roots come from the code that reads them, on every review. A target classifies by the first rule it meets:

1. A skill: a path below `skills` in the harness home or the shared agent root (`HOME_SKILL_DIR` of `@deepseek-ai/dsh-skill-filesystem`), below any `.dsh/skills` or `.agents/skills` directory (`PROJECT_SKILL_DIRS`), or below a root the mounted skill providers report through `ctx.skills.configuredRoots()`, which holds the custom and bundled roots.
2. A preset: a composition file the profile launcher reads for `ctx.profileContext`, the order `readProfilePatches` applies: each selected bundle's declared patch files (from `loadProfileDirectory`), the profile's `cordis.patch.yml`, and the home's `cordis.patch.yml`. Without `ctx.profileContext`, no file classifies as a preset.
3. The home instructions: a file named in `DEFAULT_INSTRUCTION_FILE_NAMES` of `@deepseek-ai/dsh-agent-instructions` directly in the harness home or the shared agent root, or the file such a path resolves to.
4. A folder's instructions: any other file with one of those names.

The homes resolve from `DSH_HOME` and `DSH_AGENTS_HOME`. A target or root that fails to resolve for a reason other than absence, such as a link loop or a denied search permission, makes the review throw, and the seam refuses the write.

The review reads the filesystem when it runs, so a link created or swapped between the review and the write is not seen. The seam carries no workspace, so a write addressed directly to the directory a project's linked `.agents/skills` points at, or to the file a folder's linked `AGENTS.md` points at, and a hard link to an instruction file, do not classify. Instruction file names a deployment adds through `instructionFileCandidates`, and `--patch` overlay files, do not classify either. Shell commands that write files are outside this review.

## Configuration

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `false` | Delo's C16 switch `instruction_layer_consent`, off in the parity composition; on, the consent gates instruction-layer writes. |

## Tests

`tests/consent.spec.ts` covers the classification rules, the review notes with the diff, the asked flow, resolution failures, and the switch. `tests/denial.spec.ts` covers writes through symbolic links and in another letter case, each of which asks, and the case-sensitivity probe against the temporary directory's volume. `tests/loader-roots.spec.ts` runs the instruction loader's discovery, the filesystem skill provider and the profile launcher over a fixture and requires the consent to ask about every file they read.
