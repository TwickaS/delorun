---
section: Added
---

- Remote access: `delorun reach on tailscale` lets you open the studio from your phone or another device over your own Tailscale tailnet, at `https://<computer>.<tailnet>.ts.net`. It is off until you turn it on, also from the remote access section of `delorun setup`'s Full mode, and `delorun reach off` turns it off. `delorun reach status` shows whether it is on and ready.
- A device can open your chats only after you approve it at your computer: run `delorun devices approve` or choose Add a device in Settings → Devices, then type the 8-digit code the device shows. `delorun devices list` lists approved devices, and `delorun devices remove` or Remove in Settings → Devices signs a device out at once.
- An approved phone can watch and reply to chats, start chats, approve ordinary prompts and stop a run. Granting full access, approving or removing devices and changing remote access need you at your computer, and the phone says so. A remote session ends after 12 hours without use and 14 days after sign-in.
