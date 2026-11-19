---
area: Install and update
section: Fixed
---

- An update whose new release fails its health check leaves the previous release running again, with its plugin copies pointed at it, instead of stopping Delorun until you start it by hand.
