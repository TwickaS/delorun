---
area: Commands
section: Fixed
---

- The check that builds the product website reports a checkout without the site's source pictures as a limit of that machine rather than a failure of the change. The pictures are real screenshots of the studio and are not in the repository, so the check now declines with a message naming `SITE_PICTURES_DIR` and the folder to point it at, instead of failing the build with the same message as an error.
