---
area: Plugins
section: Fixed
---

- Adding several plugin packs no longer stalls for two minutes at a time or fails with "timed out waiting for the writer lock". Packs still download two at a time, but install one after another, and Delorun reads a plugin's folder before it locks the profile, so other changes to the profile no longer wait for that read.
