---
area: Safety and privacy
section: Added
---

- Delorun asks Tailscale's local API who a connection to the Tailscale private address comes from, per connection, instead of inferring it from the arriving address. The daemon names the device and its user from its own netmap. When Tailscale cannot answer — the socket is absent, the daemon is down, the daemon does not know the address, or the device has left the tailnet — the connection is refused rather than treated as a tailnet peer.
