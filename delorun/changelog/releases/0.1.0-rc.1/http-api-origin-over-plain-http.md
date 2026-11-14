---
area: Compatibility
section: Changed
---

- A script that changes something through a Host's HTTP API over plain HTTP at an address other than this computer's, such as a name in `trustedHosts` or the address the Host listens on, must send an `Origin` header naming that address, such as `Origin: http://192.0.2.5:3080`; without one the Host answers "forbidden", because a web page could send the same request. Requests on this computer, over HTTPS and from the studio itself are unaffected.
- The Host answers "bad request" to a request with more than one `Host` header, on every address it serves, and holds a request for a path such as `/x/../api/...` to the same rules as one for `/api/...`.
