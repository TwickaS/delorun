---
description: "Bring the chats you had on chat.deepseek.com into Delorun: exporting them from the website, turning on the chat import plugin, uploading the file, what becomes a chat and what does not."
---

# Import your DeepSeek website chats

English | [中文](import-deepseek-chats.zh.md)

## Summary

This page shows how to bring chats from the DeepSeek website (chat.deepseek.com) into Delorun, where you can read them and carry on. It helps when you used the website before you started with Delorun. You need Delorun running and a [workspace](../../reference/glossary.md#workspace) to hold the chats. The import is an optional plugin, off until you turn it on. The import itself reads the file you upload and nothing else, and sends nothing anywhere. Continuing an imported chat is different: it sends the whole imported history to your model provider as part of the next request, and costs tokens like any long chat.

## Contents

- [Export your chats from the website](#export-your-chats-from-the-website)
- [Turn the import on](#turn-the-import-on)
- [Upload the file](#upload-the-file)
- [What is imported](#what-is-imported)
- [What is not imported](#what-is-not-imported)
- [Next](#next)

## Export your chats from the website

On chat.deepseek.com, open your account settings and export all your data. The website prepares a file named like `deepseek_data-2026-01-01.zip` and offers it for download. Keep the file as it is; do not unpack it. The website's menu names can change, so look for the data export in your account settings.

## Turn the import on

Open Plugins in the sidebar, choose More, and turn on **DeepSeek chat import** under Experimental plugins. The first-run guide's Recommended plugins step offers the same switch. Once it is on, a button with an upload arrow appears to the right of **New session**. Turning it off removes the button; chats you imported stay.

## Upload the file

1. Click the upload-arrow button beside **New session**.
2. Under **Export file**, choose the `deepseek_data-*.zip` file.
3. Under **Workspace**, keep the one shown, pick another, or choose **Add workspace…** to add a folder.
4. Click **Import**. A progress bar shows the upload and then the chats being written. Closing the dialog cancels the import.

The dialog ends by saying how many chats it imported and into which workspace, how many older ones it left out, and how many it could not import. Only you, at the computer that runs Delorun, can import; a phone you approved cannot.

You should see the imported chats in the workspace's chat list.

## What is imported

- **Chats.** Each website conversation becomes one chat with its original title and times. Imported chats show your questions, the model's reasoning, search and page-read cards, and the answers.
- **The latest conversations.** The newest 1000 conversations by last update. Importing the same file again adds a second copy of them.
- **The branch you were on.** When you edited a question or regenerated an answer on the website, only the branch you ended on comes across.
- **Images** from your questions, when the export holds the file.

<details>
<summary>Edge cases</summary>

- If a conversation fails, then it is skipped and the next older one takes its place.
- If a question's reply was withdrawn by the website's content filter, then neither the question nor the reply appears.
- If a reply was not finished, then its chat ends with an error row that says why, and the question stays.
- If the file is larger than 512 MiB, then the import refuses it before writing anything.
- If another import is running, then the dialog says so and writes nothing.
- If every chat fails to import, then the dialog says why when the file as a whole is the problem: it is not a readable ZIP file (download it again and do not unpack it), it lacks the website's export index or is in a format version this plugin does not read, or it holds no conversations. When the file reads but each conversation fails, the count of chats it could not import is all the dialog gives; `delorun logs home` names the defect of each, and [Report a problem that is not listed](../help/troubleshooting.md#report-a-problem-that-is-not-listed) says how to report it.

</details>

## What is not imported

- **Other files you attached.** A file other than an image shows as a card with its name and size. The card cannot be opened and the model does not see its contents.
- **Other branches** of a conversation.
- **Settings, memory and account details** from the export.
- **Conversations older than the newest 1000.** The dialog tells you how many it left out.

## Next

- Move chats from DeepSeek Harness: [Switching from DeepSeek Harness](switching.md).
- Start chatting: [Daily use](../everyday-use/daily-use.md).
