---
area: Commands
section: Added
---

- The machine-wide queue now holds new grants while the machine has been overloaded for five minutes, read from the kernel's pressure stall information: cpu or disk over 50% of the window, or memory over 10%. A spike of a few seconds never trips it, holders are never interrupted, and a machine whose kernel reports no pressure is never held. `run-checks --queue` shows the alarm and its figures.
- The queue also reports a slot count set far above the machine's CPUs, such as a figure left over from a larger machine, rather than silently overfilling the machine with it.
