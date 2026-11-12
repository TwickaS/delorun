---
area: Reach
section: Added
---

- Remote access: `delorun reach on tailscale` lets you open the studio from your phone or another device over your own Tailscale tailnet, at `https://<computer>.<tailnet>.ts.net`. It is off until you turn it on, also from the remote access section of `delorun setup`'s Full mode, and `delorun reach off` turns it off. `delorun reach status` shows whether it is on and ready.
- A device can open your chats only after you approve it at your computer: run `delorun devices approve` or choose Add a device in Settings → Devices, then type the 8-digit code the device shows. `delorun devices list` lists approved devices, and `delorun devices remove` or Remove in Settings → Devices signs a device out at once.
- An approved phone can do what you do at your computer with your chats: read and reply to them, start one in your workspaces, choose which of your presets it runs with, read the files of its own workspace in the studio's preview, see which plugins are installed, rename and pin chats, answer ordinary prompts and stop a run. Everything else needs you at your computer: granting full access, installing or enabling plugins, settings, commands, terminals, the folder picker and the Changes surface, workspaces, and devices and remote access. A preset you choose on the phone decides the tools a chat runs with but grants no access by itself: a workspace's full access and every approval prompt are still answered at the computer. A remote session ends after 12 hours in which the phone sent nothing and 14 days after sign-in, and its open connections close then.
- `delorun reach on tailscale` refuses while Tailscale Funnel is on for the address, and Delorun stops serving if Funnel is turned on later.
