---
area: Reach
section: Fixed
---

- Reach over Tailscale now says what went wrong when Tailscale does not answer. A Tailscale that hangs, prints more than Delorun reads or cannot be started is reported as not answering, no longer as not installed, and Delorun no longer treats its serve rule as removed in that case. A large tailnet's status is read in full instead of being cut off and reported as not signed in. A reach option whose unlock time is above the cap Delorun allows now stops with that reason instead of staying on "starting", a failure of the reach status page no longer leaves the request hanging, and a check interval outside the range a timer takes is refused when Delorun loads it.
