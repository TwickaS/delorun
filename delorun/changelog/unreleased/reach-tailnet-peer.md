---
area: Safety and privacy
section: Changed
---

- Your phone stops asking for a PIN or Face ID for ordinary work. When a request comes from a device on your own Tailscale network, Delorun asks Tailscale who that device is and treats it as your own computer, so changing settings, managing plugins, opening a folder picker and the rest of the everyday actions happen without a prompt. A terminal still asks, because a shell is what could reach the things that decide who can get in, and so does allowing full access for a chat. Approving a device, adding a passkey, the PIN, turning remote access on or off and the other actions that decide who can reach your studio stay at your computer. If Tailscale cannot say who the device is — it is not running, it does not know the address, or the device has left your network — Delorun asks for the PIN or Face ID as it does today rather than assuming.
