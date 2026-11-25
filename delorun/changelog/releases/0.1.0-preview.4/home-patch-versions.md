---
area: Safety and privacy
section: Fixed
---

- A value set in the home patch (`~/.delorun/cordis.patch.yml`) is now in the setup versions a person saves and switches back to. Before, a version held only the profile's own files, so a value set in the home layer had no restore point through the studio's versions and a switch back left it as it was. A version now holds both patch layers, a switch writes both, and the preview says when the home layer would change. A value for a secret field in the home patch is refused by the same check that refuses one in the profile patch, so it never enters a version.
