---
area: Safety and privacy
section: Security
---

- Programs the agent starts no longer inherit a web address that carries a token, such as `https://<token>@host` or an error-reporting address with its key, or the variables that point at Kubernetes or Kerberos credentials, a MySQL password or a passphrase. An agent socket listed in `PATH` or a similar search list now drops only that entry, so the rest of `PATH` still reaches the program. An address that names only a user, such as `postgres://user@db/app`, is not passed on either, because a token in that place looks the same; pass such a value to the program explicitly.
