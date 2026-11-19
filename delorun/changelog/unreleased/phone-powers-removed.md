---
area: Safety and privacy
section: Removed
---

- Phone powers, with its Careful and Full levels, is gone. A phone no longer has a level to choose: each action that changes what Delorun runs, such as opening a terminal, applying a change, turning protection off, making your copy of Delorun, restarting it and updating it, asks for Face ID, or for your PIN on a phone with no Face ID, each time it is taken. A phone without Face ID can now do these strong actions (a terminal, Apply, Update, installs, full access) by typing its PIN once for each action, never as an unlock window; a phone with Face ID confirms each one with Face ID. An unlocked phone no longer opens any of them. `delorun devices powers` and `delorun setup --phone-powers` no longer exist, setup stops asking what an unlocked phone may do, the Settings, Devices choice is removed, and the `phonePowersOnUpgrade` setting of the device sign-in plugin and the `/auth/phone-powers` address are gone. An answers file that still holds `phonePowers` loads, and the answer is ignored with a line saying so.
