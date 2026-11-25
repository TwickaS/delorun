---
area: Safety and privacy
section: Fixed
---

- A folder inside a workspace inherits that workspace's network setting. A chat whose working folder is a subfolder of a workspace set to Off no longer falls through to the deployment default, so a command run there cannot reach the network the workspace was closed to. A nested workspace keeps its own setting.
