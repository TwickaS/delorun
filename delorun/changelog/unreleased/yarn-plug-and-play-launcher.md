---
area: Install and update
section: Fixed
---

- `yarn add delorun` and `yarn dlx delorun` now install and start Delorun with Yarn 4's default Plug'n'Play, as `npx` does. They stopped with `TRUST_STATE_INVALID: the trust file cannot be written`. The launcher starts one plain Node process for itself under Plug'n'Play, and its package asks Yarn to unpack it. If Yarn keeps the package in a zip, the launcher says so in one line and names `nodeLinker: node-modules` and `npx delorun`.
