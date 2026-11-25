---
area: Studio
section: Fixed
---

- Attaching a file or image, and previewing a spreadsheet, a PDF or an Office document, work over a reach listener again. Each of them runs its work in a Worker built from a Blob, and the reach listener's Trusted Types policy admitted only plugin bundle paths, so the Worker constructor threw. The page now creates a `delorun-blob-worker` policy that admits a `blob:` URL whose origin is the page's own, and the four features mint their Worker URL through it. The policy still refuses another origin's blob URL, a `data:` URL and a plain string.
