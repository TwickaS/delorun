---
area: Install and update
section: Fixed
---

- An update now lists every row the new release switches off through its own settings, and asks you before it applies them. Before, such a row was left out of the list, so the health check refused the switched-off row after the update started and rolled the update back. A row switched off without being listed still fails the check.
