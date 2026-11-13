---
description: "Reach the Delorun studio from your phone over your own tailnet: what remote access is, turning it on, approving a device at your computer, what an approved phone can and cannot do, removing a device and turning remote access off."
---

# Reach the studio from your phone

## Summary

Remote access lets you open the studio of the Delorun running on your computer from your phone or another device, over your own Tailscale tailnet. It uses no Delorun service: Tailscale carries the traffic, and your computer decides who may sign in. Any device on your tailnet can open the sign-in page, but only a device you approve at your computer, by typing the code it shows, can open your chats. Opening the address, or any page of it, on a device that is not signed in takes you to the sign-in page, and back to the page you opened once you are signed in. Remote access is off until you turn it on.

## Contents

- [What you need](#what-you-need)
- [Turn remote access on](#turn-remote-access-on)
- [Approve a device](#approve-a-device)
- [What an approved phone can and cannot do](#what-an-approved-phone-can-and-cannot-do)
- [Unlock sensitive actions for a while](#unlock-sensitive-actions-for-a-while)
- [Remove a device](#remove-a-device)
- [Turn remote access off](#turn-remote-access-off)
- [What Tailscale sees](#what-tailscale-sees)
- [For the technically curious](#for-the-technically-curious)

## What you need

- Tailscale installed on your computer and on your phone, both signed in to the same tailnet.
- HTTPS certificates turned on for your tailnet, in the DNS page of the Tailscale admin console.
- On Linux, permission for your user to configure `tailscale serve`. If your user does not have it, `delorun reach on tailscale` prints the one command to run yourself: `sudo tailscale set --operator=$USER`. Delorun never runs `sudo`.

## Turn remote access on

Run `delorun reach on tailscale` in a terminal on your computer, or answer yes to "Remote access" in `delorun setup`'s Full mode. The command checks Tailscale, picks a fixed local port that Tailscale forwards your phone's requests to (the remote listener), writes both into your profile and prints your address, `https://<your computer's name>.<your tailnet>.ts.net`. It refuses when Tailscale Funnel is on for that address, because Funnel would put your sign-in page on the public internet; turn Funnel off with the command it prints. It also removes another `tailscale serve` rule on the same port that is not this studio's own, and every rule on that port while Delorun is not serving it. Before it writes anything it checks that your user may configure `tailscale serve`, and prints the one command to run if not. If Delorun is running, the command applies the change to it at once and prints whether the address is ready; otherwise the remote listener opens when Delorun starts. `delorun reach status` shows whether remote access is on and, while Delorun runs, whether the address is ready.

## Approve a device

A device is approved only at your computer.

1. On your computer, run `delorun devices approve`, or choose **Add a device** in the studio's Settings, under Devices. This opens an approval window for 5 minutes, which closes at the first approval. `delorun devices approve` needs Delorun running.
2. On your phone, open your address and choose **Ask for approval**. The phone shows an 8-digit code.
3. On your computer, the command lists every waiting device with a number, a short request id, its name, platform and time. Type the number of the device whose screen you can see, then the code it shows. Type `c` and a number to cancel a request you do not recognise. In the Devices section, each waiting device has its own code field and a **Cancel request** button. Three wrong codes cancel only that request.

At most 5 requests wait at a time. When a phone is told that 5 requests are waiting, cancel the ones you do not know at your computer, then ask again from the phone; a waiting request is never replaced on its own. A device name or platform that contains control or text-direction characters is refused.

The phone then signs in by itself with a key that never leaves it. Outside an approval window, the home refuses every request to be approved. `delorun devices list` and the Devices section list every approved device.

Approval is meant for you at your computer. The studio's Devices section answers only a browser that holds the studio's own sign-in, and the `delorun devices` commands talk to Delorun through a channel that needs a token from a file in your Delorun home. Another program or another user of the computer can reach the studio's port, but needs that sign-in to use the section. A command a chat runs in the sandbox cannot read the secret behind the sign-in or the token file, and cannot reach the channel. A program running as your own user outside the sandbox can read both, so it can open the window and approve a device that asks, with you not there; a command you let run with full access is such a program.

Delorun cannot verify where a request comes from: any device on your tailnet can ask while the window is open. The code is what ties an approval to the device you are looking at. The code proves that the device you approve is the device whose screen you read: the code is computed from that device's key and from the request it sent, the computer never shows or returns it, and a code read from another device does not match. The code does not prove who holds the device; anyone holding your unlocked phone when you approve it gets the approval.

## What an approved phone can and cannot do

An approved phone is you: it can already ask the agent to do things, so it can do everything that is no riskier than a message. A few sensitive actions need a short unlock that you approve at your computer, and a few things never work from a phone.

Without an unlock, the phone can:

- read your chats and workspaces, and follow a chat while it runs;
- reply, attach files, edit or withdraw a queued message, fork a chat, and start a chat in a workspace you already have, with any of your presets. A preset decides the plugins and tools a chat runs with, and choosing one grants nothing by itself: the workspace's full access and every approval prompt still decide what that chat may do;
- read the files of a chat's own workspace and see its changes. A file outside the workspace is refused, including one reached through a link, and so is anything in Delo's own folder;
- rename, pin, archive, restore and reorder chats, rename and reorder workspaces, and move a workspace to the trash;
- set, edit, pause and clear a chat's goal, and create, edit, run and delete scheduled follow-ups;
- choose a chat's model, which also saves it as the default for new chats;
- read the installed plugins and the profile changes you can undo;
- give feedback on a chat or a message;
- answer ordinary prompts and questions the agent asks, and stop a run or a background job.

In a workspace you put on full access, the phone opens a terminal without an unlock, because the agent can already run any command there. A terminal opened that way keeps running when you take full access away; the next one needs an unlock. To skip the unlock for terminals everywhere, turn on **Terminal from phone without unlock** in Settings, Devices on your computer. Only your computer turns it on; the phone can turn it off.

With an unlock, the phone can also:

- change settings;
- run slash commands;
- install, enable, update or remove plugins, and undo or restore a profile change. Delo's own guard plugins and remote access cannot be turned off or changed this way;
- open a terminal in a folder outside the workspaces you put on full access;
- browse folders with the folder picker, add a workspace, and start a chat in a folder that is not one of your workspaces;
- run plugin code the agent wrote.

Never, even unlocked:

- grant full access, whether a command asks to run outside the sandbox or a workspace asks to be put on full access; the approval card on the phone says "Approve this at your computer", an answer from the phone shows "This needs you at your computer: granting full access. Answer this prompt in the studio on the home's own computer", and the prompt keeps waiting for your computer;
- accept, decline or revoke an MCP server; the phone names the servers waiting for your OK and says to approve them at your computer, and Settings, Permissions on the phone says the same;
- read or change your keys and other credentials, or your account;
- turn off **Ask before external agents run**; the phone can still turn it on and change its run time limit;
- answer a prompt that would let the agent manage workspaces and their instructions;
- open a file or folder in an application on your computer, or open the settings file in an editor there;
- approve or remove devices, change remote access, unlock itself or make an unlock longer, or reset the home.

Another refused action shows the studio's error message. Images that a reply shows as files on your computer, and file previews, do not show on the phone yet; images attached to messages do.

The limit is partial. A workspace that you already put on full access at your computer can still be driven from the phone, and a command there can do anything your user can do. What protects you is the phone's own lock and removing the device when you lose it. A phone's session ends after 12 hours in which the phone sent nothing, and 14 days after sign-in; its open connections close at that moment. Approving or removing a device closes every phone's open connections; each phone then signs in again from the sign-in page, with its own key.

No outside security review of remote access has happened. Its tests fake `tailscale`, and no real tailnet or phone has exercised it; the [reach design](../design/reach.md#never-run-on-a-real-tailnet-or-phone) lists what stays untried.

## Unlock sensitive actions for a while

When you try a sensitive action on the phone, it says "This needs a quick unlock from your computer" and offers **Unlock**. You can also unlock ahead of time from Settings, Devices on the phone.

1. On the phone, choose **Unlock**. The phone shows an 8-digit code and waits for your computer for up to 5 minutes; **Cancel** withdraws the request.
2. On your computer, open Settings, Devices in the studio, where the request waits with a code field, or run `delorun devices elevate`, which lists the phones that ask. Type the code the phone shows and approve. Three wrong codes cancel the request; **Decline** turns it down.
3. The phone shows "Sensitive actions unlocked until" and the time the unlock ends, with **Lock now**.

An unlock lasts 15 minutes; `elevationMinutes` in the profile's reach row sets 1 to 60. Nothing extends it: when it ends, unlock again. It ends early when you choose **Lock now** on the phone, **End** in Settings, Devices on your computer or end it with `delorun devices elevate`, when the phone's session ends, when you remove the phone, and when Delorun stops or turns remote access off. When an unlock ends, the phone reconnects, so a terminal opened under it closes. An unlock works only for the phone that asked, on the address it asked on, and only in the Delorun profile that approved it. Delorun logs each start and end, and each action taken under an unlock.

## Remove a device

Run `delorun devices remove <device id>` with an id from `delorun devices list`, or choose **Remove** beside the device in the studio's Devices section on your computer. The device is signed out at once, and its open connections close. To use it again, approve it again.

## Turn remote access off

Run `delorun reach off`. It removes Tailscale's rule for your studio, checks that it is gone, and says so if it is not; a running Delorun closes the remote listener at once, and none opens at its next start. While Delorun runs, it rechecks Tailscale every minute and stops serving if Funnel is turned on for your address.

If Delorun stops without cleaning up, for example when the computer loses power, Tailscale keeps forwarding your address to the fixed local port until Delorun starts again or you run `delorun reach off`. In that time another user of the same computer could serve a page on that port to your phone. Run `delorun reach off` if Delorun stopped that way and you share the computer. Approved devices stay approved, so turning remote access on again does not ask for them again; remove them if you no longer want them.

## What Tailscale sees

Tailscale's coordination service sees your computer's name, the IP addresses of your computer and of each device, connection times and traffic volume. Tailscale can add a device to your tailnet unless Tailnet Lock is on, and it obtains the certificate for your address. Every device still needs your approval at your computer. See [What you trust when you use Delorun](trust.md).

## For the technically curious

The [device approval contract](../contracts/c05-device-approval.md) defines the approval code and what an approved device may do, the [reach providers contract](../contracts/c07-reach-providers.md) defines how Delorun drives Tailscale, and the [reach design](../design/reach.md) explains the choices and lists what is untested.
