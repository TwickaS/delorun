---
area: Safety and privacy
section: Security
---

- With the fetch protection on, `web_fetch` judges an address written into the URL as an IPv6 literal, such as `http://[2001:db8::1]/`, like any other address: a public one is fetched, and a loopback or link-local one, such as `http://[::1]/` or `http://[fe80::1]/`, is refused. Every IPv6 literal had been refused, public ones included.
