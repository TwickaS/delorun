---
area: Install and update
section: Fixed
---

- An update to a release that changes a protected setting no longer fails its health check and goes back. A release can turn a setting on in a row Delorun protects, such as External agents for live agents. An older release's update report could not name that change, so the health check refused it. The new release now reads its own signed files and the previous release's, accepts exactly the changes they bring, and shows them with the update's outcome in Settings → Updates. A setting you changed yourself, a weaker sandbox and a row that disappears still fail the check. The update report of this release and later ones names these changes before you update: `Delorun <version> changes the settings of the External agents row (delorun-agent-seats): turns on live agents.`
