---
area: Commands
section: Added
---

- The machine-wide queue now holds new grants only while the machine has been saturated for a minute, read from the kernel's pressure stall information: cpu, memory or disk over 90% of the last 60 s. The machine is meant to be used, so a busy merge tier never trips it; a spike of a few seconds never trips it either, and holders are never interrupted. A machine whose kernel reports no pressure is never held. `run-checks --queue` shows the alarm and its figures.
- The queue also reports a slot count set far above the machine's CPUs, such as a figure left over from a larger machine, rather than silently overfilling the machine with it.
