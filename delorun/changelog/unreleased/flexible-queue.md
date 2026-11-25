---
area: Commands
section: Changed
---

- The machine queue reserves what a check declares, not the share of the budget its slots would buy. A check that declares 4 GiB is reserved 4 GiB, where it was reserved 4.6 times that on a 9-slot budget, so the runs waiting behind a build start beside it instead of waiting for memory the build never used. A check that declares its memory per worker keeps scaling with its workers.
- The queue measures the machine rather than assuming one. The memory kept outside the runs is an eighth of the machine rather than a 2 GiB floor, `DELORUN_CHECKS_MEMORY_GIB` overrides the figure, and `run-checks --queue` prints the derivation. The disk-heavy places follow the disk: four on a disk that reports no seek cost, three on a spinning one, and `DELORUN_CHECKS_DISK_RUNS` overrides both.
