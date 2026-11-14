---
area: Safety and privacy
section: Security
---

- `web_fetch` refuses to reach loopback, link-local, private-network, carrier-grade NAT (the range a tailnet and its API use), multicast and reserved addresses, and the address that names no destination at all, before it opens a connection. An IPv6 address that reaches an IPv4 address (mapped, compatible or translated for a network without IPv4) is judged as the IPv4 address it stands for.
- Delo's profiles turn that protection on; a stock configuration keeps its old behaviour.
- `web_fetch` connects only to the addresses it checked. A name that answers differently when the connection opens than when it was checked can no longer send the fetch to another address.
