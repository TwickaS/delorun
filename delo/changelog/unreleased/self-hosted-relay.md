---
section: Added
---

- A home that accepts no inbound connection can serve its studio through a relay you run on your own server and domain. The browser's encrypted connection travels through the relay to the home, which is the only party holding the studio's certificate key, so the relay cannot read or change what the browser and the studio exchange. The relay stops a browser address that no home registered, refuses a connection that presents no valid proof of the home's key or presents an expired or already-used authorisation, and closes a home's browser connections the moment that home disconnects. It keeps an idle home connected while the home answers its keepalive pings, and closes a tunnel it has received nothing on for 45 seconds.
