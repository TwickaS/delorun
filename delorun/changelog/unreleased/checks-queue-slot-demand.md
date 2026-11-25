---
area: Commands
section: Fixed
---

- A check run now asks the machine-wide queue for the slots its own memory ceiling can keep busy, rather than the sum of every check's CPUs. A merge-tier push of 96 checks used to reserve all 64 slots while using about 21 CPUs of them, so every other lane waited behind a reservation the run could not spend; it now asks for 21 and the lanes start beside it.
