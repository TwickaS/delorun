---
area: Reach
section: Added
---

- Remote access: `delorun reach on tailscale` lets you open the studio from your phone or another device over your own Tailscale tailnet, at `https://<computer>.<tailnet>.ts.net`. It is off until you turn it on, also from the remote access section of `delorun setup`'s Full mode, and `delorun reach off` turns it off. `delorun reach status` shows whether it is on and ready.
- A device can open your chats only after you approve it at your computer: run `delorun devices approve` or choose Add a device in Settings → Devices, then type the 8-digit code the device shows. `delorun devices list` lists approved devices, and `delorun devices remove` or Remove in Settings → Devices signs a device out at once.
- An approved phone can do what you do at your computer with your chats and workspaces: read and reply to chats, start one in a workspace you have with any of your presets, read the files of its own workspace and its changes, see which plugins are installed, rename, pin, archive and reorder chats and workspaces, move a workspace to the trash, set goals, schedule follow-ups, choose the model, answer ordinary prompts and stop a run. A preset you choose on the phone decides the tools a chat runs with but grants no access by itself: a workspace's full access and every approval prompt are still answered at the computer. Credentials, your account, granting full access, and devices and remote access always stay at your computer. A remote session ends after 12 hours in which the phone sent nothing and 14 days after sign-in, and its open connections close then.
- `delorun reach on tailscale` refuses while Tailscale Funnel is on for the address, and Delorun stops serving if Funnel is turned on later.
