---
area: Safety and privacy
section: Fixed
---

- Browser now checks each file it saves after the file lands. A download or screenshot that ends up outside the chat's folder, for example through a link someone placed inside `.playwright-mcp`, is removed when Delorun can do so safely, and the result is refused with a message. With Full access, which runs outside the sandbox, this is a refusal, not a barrier.
