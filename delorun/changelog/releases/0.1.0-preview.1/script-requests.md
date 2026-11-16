---
area: Compatibility
section: Fixed
---

- A script, or the desktop app's own requests, that talks to a Delorun Host on the same computer with the Host's cookie is accepted again; the Host had answered "forbidden" to any request that changes something and states no origin. A request from a web page on another site or another local port is still refused.
