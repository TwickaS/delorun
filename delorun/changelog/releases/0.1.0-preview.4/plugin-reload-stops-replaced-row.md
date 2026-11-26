---
area: Plugins
section: Fixed
---

- Turning on a plugin that replaces one of Delorun's own services, such as dsh-layerfs replacing chat storage, no longer empties the sidebar and stops messages from sending. A live reload now stops the row the change turns off before it starts the replacement, and a change that would swap the provider of a service running chats depend on applies nothing live and asks for a restart instead.
