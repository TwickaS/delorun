---
area: Safety and privacy
section: Fixed
---

- Browser now saves screenshots, downloads and PDFs in a folder Delorun creates for each chat in your cache folder, outside the chat's folder, so a command running in the chat's sandbox can read a saved file but cannot replace the folder or point it somewhere else. Browser also checks each file after it lands; one that ends up outside the chat's folder or the output folder is removed when Delorun can do so safely, and the result is refused with a message. A chat with Full access runs outside the sandbox, so for it this is a refusal, not a barrier.
