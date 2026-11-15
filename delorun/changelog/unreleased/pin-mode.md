---
area: Reach
section: Added
---

- PIN mode lets a phone or another computer you have already approved unlock its Delorun page with a PIN or passcode, so you do not need to walk to the home computer for a code. It works on the private Tailscale address, and you turn it on at the home computer only: `delorun devices pin set` asks for a PIN of at least 6 digits, or a passcode of at least 10 characters, and says what the mode allows.
- An unlocked page can change the settings that otherwise wait for the computer, and each one goes back to its earlier value when the mode is turned off. Only that one page is unlocked, so a reload starts locked again.
- An unlock ends after 15 idle minutes by default (change it with `delorun devices pin options --idle-minutes`, from 1 to 60), after 12 hours at most, when you lock the page, and when the PIN changes. `--lock-when-hidden` locks a page as soon as it is hidden.
- Five wrong tries on one device remove that device, and it needs your approval at the computer again. Ten wrong tries across the home pause PIN unlocks until you resume them with `delorun devices pin resume`. `delorun devices pin status` shows the state, and Settings has a PIN mode section at the computer that lists any setting waiting to be put back.
