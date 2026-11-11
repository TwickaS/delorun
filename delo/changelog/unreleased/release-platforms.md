---
area: Install and update
section: Added
---

- A release publishes runtimes for Linux x64, Linux arm64 and Windows x64. Running `npx delorun` or `delorun update` on a computer whose platform the release does not include, such as a Mac, stops before downloading anything and names the platform and the platforms the release does include; a macOS runtime joins a release once its native code is built from the tagged source too.
