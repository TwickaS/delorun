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

Run `delorun reach on tailscale` in a terminal on your computer, or answer yes to "Remote access" in `delorun setup`'s Full mode. The command checks Tailscale, writes the setting into your profile and prints your address, `https://<your computer's name>.<your tailnet>.ts.net`. Delorun opens the remote listener when it starts, so restart Delorun if it is running: `delorun stop`, then `delorun start`. `delorun reach status` shows whether remote access is on and, while Delorun runs, whether the address is ready.

## Approve a device

A device is approved only at your computer.

1. On your computer, run `delorun devices approve`, or choose **Add a device** in the studio's Settings, under Devices. This opens an approval window for 5 minutes.
2. On your phone, open your address and choose **Ask for approval**. The phone shows an 8-digit code.
3. On your computer, check the device's name and platform, and type the code the phone shows. Three wrong codes cancel the request.

The phone then signs in by itself with a key that never leaves it. Outside an approval window, the home refuses every request to be approved. `delorun devices list` and the Devices section list every approved device.

## What an approved phone can and cannot do

An approved phone can watch your chats, reply, start chats, approve ordinary prompts and stop a run.

It cannot grant full access, whether a command asks to run outside the sandbox or a workspace asks to be put on full access; it cannot approve or remove devices, change remote access, or reset the home. Each of those needs you at your computer, and the phone shows "This needs you at your computer" with what it tried. Installing a plugin from the phone is therefore not possible.

The limit is partial. A workspace that you already put on full access at your computer can still be driven from the phone, and a command there can do anything your user can do. What protects you is the phone's own lock, removing the device when you lose it, and the sign-out after 12 hours without use; a session also ends 14 days after sign-in.

## Remove a device

Run `delorun devices remove <device id>` with an id from `delorun devices list`, or choose **Remove** beside the device in the studio's Devices section on your computer. The device is signed out at once, and its open connections close. To use it again, approve it again.

## Turn remote access off

Run `delorun reach off`. Tailscale stops serving your studio at once, and Delorun opens no remote listener at its next start; restart Delorun to close the listener now. Approved devices stay approved, so turning remote access on again does not ask for them again; remove them if you no longer want them.

## What Tailscale sees

Tailscale's coordination service sees your computer's name, the IP addresses of your computer and of each device, connection times and traffic volume. Tailscale can add a device to your tailnet unless Tailnet Lock is on, and it obtains the certificate for your address. Every device still needs your approval at your computer. See [What you trust when you use Delo](trust.md).
