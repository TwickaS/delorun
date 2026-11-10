---
description: "Reach the Delorun studio from your phone over your own tailnet: what remote access is, turning it on, approving a device at your computer, what an approved phone can and cannot do, removing a device and turning remote access off."
---

# Reach the studio from your phone

## Summary

Remote access lets you open the studio of the Delorun running on your computer from your phone or another device, over your own Tailscale tailnet. It uses no Delorun service: Tailscale carries the traffic, and your computer decides who may sign in. Any device on your tailnet can open the sign-in page, but only a device you approve at your computer, by typing the code it shows, can open your chats. Remote access is off until you turn it on.

## Contents

- [What you need](#what-you-need)
- [Turn remote access on](#turn-remote-access-on)
- [Approve a device](#approve-a-device)
- [What an approved phone can and cannot do](#what-an-approved-phone-can-and-cannot-do)
- [Remove a device](#remove-a-device)
- [Turn remote access off](#turn-remote-access-off)
- [What Tailscale sees](#what-tailscale-sees)

## What you need

- Tailscale installed on your computer and on your phone, both signed in to the same tailnet.
- HTTPS certificates turned on for your tailnet, in the DNS page of the Tailscale admin console.
- On Linux, permission for your user to configure `tailscale serve`. If your user does not have it, `delorun reach on tailscale` prints the one command to run yourself: `sudo tailscale set --operator=$USER`. Delorun never runs `sudo`.

## Turn remote access on

Run `delorun reach on tailscale` in a terminal on your computer, or answer yes to "Remote access" in `delorun setup`'s Full mode. The command checks Tailscale, picks a fixed local port for the remote listener, writes both into your profile and prints your address, `https://<your computer's name>.<your tailnet>.ts.net`. It refuses when Tailscale Funnel is on for that address, because Funnel would put your sign-in page on the public internet; turn Funnel off with the command it prints. It also removes any other `tailscale serve` rule on the same port. Delorun opens the remote listener when it starts, so restart Delorun if it is running: `delorun stop`, then `delorun start`. `delorun reach status` shows whether remote access is on and whether Delorun runs; Settings → Devices in the studio on your computer shows whether the address is ready.

## Approve a device

A device is approved only at your computer.

1. On your computer, run `delorun devices approve`, or choose **Add a device** in the studio's Settings, under Devices. This opens an approval window for 5 minutes.
2. On your phone, open your address and choose **Ask for approval**. The phone shows an 8-digit code.
3. On your computer, the command lists every waiting device with a number, its name, platform and time. Type the number of the device whose screen you can see, then the code it shows. Type `c` and a number to cancel a request you do not recognise. In the Devices section, each waiting device has its own code field. Three wrong codes cancel only that request.

At most 5 requests wait at a time. When a phone is told that 5 requests are waiting, cancel the ones you do not know at your computer, then ask again from the phone; a waiting request is never replaced on its own. A device name or platform that contains control or text-direction characters is refused.

The phone then signs in by itself with a key that never leaves it. Outside an approval window, the home refuses every request to be approved. `delorun devices list` and the Devices section list every approved device.

Only you at your computer can open the window, see the waiting device and approve it. The studio's Devices section answers only the studio you opened from the address `delorun start` printed, and the `delorun devices` commands talk to Delorun through a channel that only your own commands can open. Another program on your computer, a command a chat runs, or another user of the computer can reach the studio's port, but not these.

The code proves that the device you approve is the device whose screen you read: the code is computed from that device's key and from the request it sent, the computer never shows or returns it, and a code read from another device does not match. The code does not prove who holds the device; anyone holding your unlocked phone when you approve it gets the approval.

## What an approved phone can and cannot do

An approved phone speaks for a device, not for you at your computer. Delorun allows it a fixed list of actions and refuses everything else.

It can:

- read your chats and workspaces, and follow a chat while it runs;
- reply, attach images, start a chat in a workspace you already have, with your configured preset, and fork a chat;
- rename and pin chats;
- answer ordinary prompts and questions the agent asks, and stop a run or a background job.

It cannot:

- grant full access, whether a command asks to run outside the sandbox or a workspace asks to be put on full access; the phone shows "This needs you at your computer: granting full access", and the prompt keeps waiting for your computer;
- install, enable or remove plugins, undo profile changes, or change any setting, the model a chat saves as default, or a chat's preset;
- run slash commands, open a terminal, browse folders, read files on your computer by path, or see the Changes panel;
- start a chat in a folder of its choosing, create, rename or delete workspaces, archive or reorder chats, or create or edit scheduled follow-ups;
- approve or remove devices, change remote access, or reset the home.

Other refused actions show the studio's error message. Images that a reply shows as files on your computer, and file previews, do not show on the phone yet; images attached to messages do.

The limit is partial. A workspace that you already put on full access at your computer can still be driven from the phone, and a command there can do anything your user can do. What protects you is the phone's own lock and removing the device when you lose it. A phone's session ends after 12 hours in which the phone sent nothing, and 14 days after sign-in; its open connections close at that moment. Approving or removing a device closes every phone's open connections; each phone then signs in again from the sign-in page, with its own key.

No outside security review of remote access has happened yet.

## Remove a device

Run `delorun devices remove <device id>` with an id from `delorun devices list`, or choose **Remove** beside the device in the studio's Devices section on your computer. The device is signed out at once, and its open connections close. To use it again, approve it again.

## Turn remote access off

Run `delorun reach off`. It removes Tailscale's rule for your studio, checks that it is gone, and says so if it is not; Delorun opens no remote listener at its next start; restart Delorun to close the listener now. While Delorun runs, it rechecks Tailscale every minute and stops serving if Funnel is turned on for your address.

If Delorun stops without cleaning up, for example when the computer loses power, Tailscale keeps forwarding your address to the fixed local port until Delorun starts again or you run `delorun reach off`. In that time another user of the same computer could serve a page on that port to your phone. Run `delorun reach off` if Delorun stopped that way and you share the computer. Approved devices stay approved, so turning remote access on again does not ask for them again; remove them if you no longer want them.

## What Tailscale sees

Tailscale's coordination service sees your computer's name, the IP addresses of your computer and of each device, connection times and traffic volume. Tailscale can add a device to your tailnet unless Tailnet Lock is on, and it obtains the certificate for your address. Every device still needs your approval at your computer. See [What you trust when you use Delo](trust.md).
