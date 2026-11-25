---
area: Plugins
section: Fixed
---

- A start no longer logs that it could not check the profile for plugin keys while another change was writing the profile: a change that runs inside a writer's own hold takes the profile's write lock once, so the start keeps the profile history version that records the change, and two separate writers still take turns.
