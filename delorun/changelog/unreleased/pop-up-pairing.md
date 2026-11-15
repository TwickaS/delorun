---
area: Reach
section: Added
---

- A phone signed in to Tailscale as the same user as your computer can ask to pair without an approval window. The studio at your computer shows the request with **Enter code** and **Decline**; you type the 8-digit code the phone shows, and the code is required. `delorun setup reach` lets any device on your tailnet ask instead, and `delorun reach status` says who may ask. The `pairing` settings in the `@delorun/home-auth` row also set how the request is shown, the approval window and request lifetimes, and how many requests one Tailscale user may have waiting. Settings → Devices shows and changes these choices at your computer.
