---
area: Reach
section: Added
---

- Remote access: `delorun reach on tailscale` lets you open the studio from your phone or another device over your own Tailscale tailnet, at `https://<computer>.<tailnet>.ts.net`. It is off until you turn it on, also from the remote access section of `delorun setup`'s Full mode, and `delorun reach off` turns it off. `delorun reach status` shows whether it is on and ready.
- A device can open your chats only after you approve it at your computer: run `delorun devices approve` or choose Add a device in Settings → Devices, then type the 8-digit code the device shows. The device's sign-in page walks you through these steps in English or Chinese, light or dark, shows the code large with the time left, and says what to do next when approval is closed, the code expired or was cancelled, too many devices are waiting, the computer can't be reached, or the browser can't keep a sign-in key. `delorun devices list` lists approved devices, and `delorun devices remove` or Remove in Settings → Devices signs a device out at once.
- An approved phone can read and reply to chats, start chats in your workspaces, rename and pin chats, answer ordinary prompts and stop a run. Everything else needs you at your computer: granting full access, plugins, settings, commands and files on the computer, and devices and remote access. A remote session ends after 12 hours in which the phone sent nothing and 14 days after sign-in, and its open connections close then.
- `delorun reach on tailscale` refuses while Tailscale Funnel is on for the address, and Delorun stops serving if Funnel is turned on later.
