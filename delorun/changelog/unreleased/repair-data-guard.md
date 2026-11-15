---
area: Install and update
section: Added
---

- `delorun repair` refuses to start an older program over chats when the home records which release wrote them and the release's data formats cannot be compared (`DATA_UNREADABLE`), and `--restore-copy` refuses a copy whose formats are newer than the release reads (`DATA_COPY_NEWER`). A restored copy's facts become the home's data-format record. A release signed by a local release build is refused from a `--from` folder as well when the launcher trusts the production keys, and `repair` reads the floor from the channel the home installed from.
