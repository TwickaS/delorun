---
description: "Let the agent work in your own Chrome, signed in as you, in a chat where you allow it: adding the pack, pairing Chrome once, allowing it in a chat, and what the agent can see there."
---

# Use your own browser

English | [中文](use-your-own-browser.zh.md)

## Summary

This page shows how to let the agent work in your own Chrome, where you are already signed in, for a task you are watching. It helps when a task needs your accounts, such as filling in a form on a site you use or reading your own dashboard. You need Delorun running and Chrome (or another Chromium-based browser such as Edge or Brave) on the same computer. The agent works in your browser through [browse](https://github.com/anomalyco/browse), an open-source extension and helper made by Anomaly. Delorun ships its own copy of browse, so you install nothing yourself apart from the extension.

Your own browser is never used on its own. The agent asks first, in the [chat](../../reference/glossary.md#chat), and only a chat you allow can use it. The isolated browser of the **Browser** pack stays as it is: it is on unless you turn it off in Settings, under **Browser**, and the first time it is used Delorun adds the pack and downloads its browser part, which can take a few minutes. If Chrome is installed, Delorun uses it first; otherwise it downloads its own Chromium. **Settings → Browser** shows the progress and, if the download cannot finish (no connection, a refused pack or no Chrome found), what to do, with **Try again**.

## Contents

- [Add it and pair Chrome](#add-it-and-pair-chrome)
- [Allow it in a chat](#allow-it-in-a-chat)
- [What the agent can do there](#what-the-agent-can-do-there)
- [Turn it off](#turn-it-off)
- [Next](#next)

## Add it and pair Chrome

1. Open Plugins in the sidebar, find **Your own browser** and select **Add**. Delorun downloads the pack and checks its signature.
2. Turn on its browser row. Delorun asks you to accept browse's program once, because it runs outside the chat's sandbox; one acceptance covers every chat.
3. The row reads "Needs setup · Connect Chrome" until Chrome is paired. Follow the steps under it:
   1. Select **Open the Chrome Web Store** and add the browse extension to Chrome.
   2. Select **Get a pairing code**. Delorun shows a code such as `AB12-CD34`.
   3. In Chrome, open **Extensions → browse → Options**, choose **Pair with a code**, enter the code and select **Connect**.

You should see the row change to ready. The code works once, within ten minutes. You pair only once; Chrome stays paired after you restart Chrome or Delorun.

Pairing is done at the computer itself. A paired phone can see the row, but cannot get a code.

## Allow it in a chat

When a task needs your browser, the agent asks to use it. An approval card shows in the chat, with the task the agent wants it for, and says that the agent will use your own browser with your sign-ins. Allow it, or refuse to keep it out.

You can allow it at the computer, or from an unlocked phone: a phone you paired, unlocked for this answer. A recent unlock for something else does not count, and a phone that is only signed in cannot allow it. The same goes for the permission for while you are away.

Once you allow it, it lasts until you turn it off or the chat ends, also after Delorun restarts. Runs of that chat that you did not start, such as scheduled ones, use it only if you also allowed it for while you are away; that permission lasts seven days unless the row's settings change it, and you can give it again. A run nobody can answer, such as `delorun headless`, cannot use it, and says so.

## What the agent can do there

The agent opens its own tabs in your browser and works in them with short scripts: it reads a page, clicks, types and collects what the task needs. It closes the tabs it opened when it is done. It does not touch tabs you opened.

For a sign-in, a code, a payment or anything only you should do, the agent hands the step back to you. A message appears on the page; do the step yourself and select **Continue** on the page. Only your own click lets the agent go on.

The agent uses your browser only for the task you allowed. For other reading on the web it keeps using the isolated browser, where nothing is signed in.

<details>
<summary>Edge cases</summary>

- If the row reads "Not available on Windows on Arm", then browse has no program for your computer. The isolated **Browser** pack still works.
- If the code ran out before you entered it, then select **Get a new code** and enter the new one.
- If Chrome is closed, or the extension is turned off, then the agent tells you it cannot reach your browser. Open Chrome and ask again.
- If you already use browse with other agents, then Delorun shares the same connection to Chrome. When the browse that is running is another version than Delorun's, the approval card says so.
- If Chrome updates the extension and it no longer works with Delorun's browse, then the agent says browse needs an update. A newer Delorun release brings one.
- If you use Delorun in WSL with Chrome on Windows, then Delorun runs its own Windows copy of browse, next to Chrome.
- If the agent asks for your browser in a chat where you do not want it, then refuse on the card. Nothing changes in that chat, and the agent carries on with the isolated browser.

</details>

<details>
<summary>Go further</summary>

The agent's scripts run inside the pages it opens, so they can read whatever those pages show and send requests as you from them, as any script on the page can. A page, email or document the agent reads can try to give it instructions. The agent is told to ignore them and to ask you before anything hard to undo, but you are the last check: allow your browser for tasks you watch, and refuse it for the rest.

browse adds its own limits: it does not let scripts clear your cookies, open the browser's internal pages, or read another site's stored data. These limits keep mistakes small; they are not a wall against a page that wants your data.

Delorun's copy of browse never updates itself, and Delorun starts it with browse's extra-access switches off. To remove the pairing, open the extension's options in Chrome and remove the connection there.

</details>

## Turn it off

To end it in one chat, turn it off in that chat; the agent stops using your browser at once. To stop it everywhere, turn off **Your own browser** in Plugins. Chrome stays paired until you remove the pairing in the extension.

## Next

- Let the agent browse without your sign-ins: the **Browser** pack in Plugins.
- Allow and refuse other things the agent asks for: [Daily use](daily-use.md).
