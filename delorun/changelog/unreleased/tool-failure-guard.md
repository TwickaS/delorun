---
area: Safety and privacy
section: Added
---

- A chat whose tool calls keep failing stops on its own instead of using up tokens on workaround after workaround: after 6 failed calls in a row, or 8 of the last 12, the chat shows one notice saying it stopped, and your next message carries on. A call you refused does not count. In `delorun headless` a stopped task also prints one line saying why.
