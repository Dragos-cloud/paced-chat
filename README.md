# Paced Chat for Hermes Desktop

User guide · Version 0.1.1

Paced Chat is an alternate chat view for Hermes Desktop that lets you read replies at your own pace instead of racing the model’s token stream. Longer or information-dense answers can be difficult to follow when words arrive faster than you can read them; waiting for the whole answer before reading, on the other hand, means you cannot follow along as it is generated.

Choose a display speed from 90 to 600 words per minute, follow the reply as it appears, then adjust the pace or use **Show all** to catch up. Your speed setting is remembered, and the pane keeps the message box and reply together in the same conversation.

The accompanying research, *Streaming, Fast and Slow: Cognitive Load-Aware Streaming for Efficient LLM Serving*, explores adapting delivery speed to content complexity. Paced Chat applies the reader-controlled pacing idea in a simpler way: it does not estimate cognitive load or automatically adapt to each passage. It changes only how quickly received text is revealed—not how quickly Hermes generates it, which model or provider it uses, or the answer itself. The goal is to make streamed replies easier to follow, not to promise improved comprehension or reduced model-serving costs.

Paced Chat uses the conversation’s existing Hermes model. To use a local model, select a Hermes profile or conversation that already uses your LM Studio model.

## Install in Hermes Desktop from GitHub

1. In Hermes Desktop 0.23.0 or later, open **Capabilities → Plugins → Install from Git**.
2. Enter `https://github.com/Dragos-cloud/paced-chat`. Select the **Desktop** target and install.
3. Enable **Paced Chat** in the Desktop column if needed. Click **Paced Chat** in the status bar, or press **Ctrl+K** on Windows or **⌘K** on macOS and choose **Open Paced Chat**.

You can also assign a shortcut such as **Ctrl+Shift+P** to **Open Paced Chat** in Hermes Desktop's keybind settings. No shortcut is assigned by default, so existing shortcuts are not changed.

If Hermes reports an existing manual install with the same ID, remove the manually copied `plugin.js` from your Desktop plug-ins folder before switching to the GitHub install.

## Install on Windows from the ZIP

1. Extract the ZIP. Open `paced-chat\desktop` and locate `plugin.js`.
2. In File Explorer, open `%LOCALAPPDATA%\hermes\desktop-plugins`. Create `desktop-plugins` and its `paced-chat` subfolder if needed. If the Desktop app uses a custom `HERMES_HOME`, use its `desktop-plugins` folder.
3. Copy `plugin.js` into `desktop-plugins\paced-chat`. That folder is also where the previous ZIP installed `plugin.js`, so replace that file if prompted.
4. In Hermes Desktop, press **Ctrl+K** and run **Reload desktop plugins**. Under **Capabilities → Plugins**, check that **Paced Chat** is enabled in the Desktop column.
5. Click **Paced Chat** in the status bar, or press **Ctrl+K** and run **Open Paced Chat**.

Install the file on the computer running the Desktop app, including when Desktop connects to a Hermes backend in WSL. Use Nous Research Hermes Desktop 0.23.0 or later with a connected Hermes gateway. If you install a published package through **Capabilities → Plugins**, use the Desktop target. If Hermes reports an existing manual install with the same ID, remove the manually copied `plugin.js` before switching to the managed install.

## Use the pane

- **Continue a conversation** by selecting it in Hermes and opening Paced Chat once its current reply finishes. The pane loads the conversation’s existing user and assistant messages. To switch conversations, close the Paced Chat tab, select the other conversation, and run **Open Paced Chat** again.
- **Start a conversation** using **New chat** in Paced Chat. If there is no selected conversation when you first open Paced Chat, typing a message and pressing **Send** starts one. New conversations use the active profile’s configured model.
- **Send a message** with **Enter** or **Send**. Use **Shift+Enter** for a line break. You can draft the next message while the current reply is being revealed.
- **Set your reading speed** from 90 to 600 words per minute. The starting setting is 240. You can change it mid-reply, and the plug-in remembers it. Hermes generates at its normal speed. When Hermes produces text more slowly than the selected pace, words appear as they arrive.
- **Show all** reveals everything received so far and follows the rest of that reply as it arrives. The next reply uses your selected speed again.
- **Stop** interrupts the current Hermes turn. **Open in Hermes** opens the same saved conversation for Hermes-specific controls such as tool approvals, attachments, model changes, and slash commands. Close and reopen Paced Chat after adding messages in the standard view to refresh its history.

## Formatting and data access

This version handles text chat. It uses Hermes’ Markdown renderer where available for tables, code, and math, with a plain-text fallback. It displays images as their alternative text.

Paced Chat reads the selected conversation’s text history through the Hermes gateway, sends prompts when you submit them, and subscribes to the reply stream. **Stop** requests a Hermes session interrupt. Hermes processes prompts through the profile’s configured provider, including a cloud provider if selected, and saves the conversation in its normal history. The plug-in stores one setting, the reading speed, through the Desktop SDK. It makes zero direct third-party network requests and accesses zero credential files. It adds zero tools, hooks, shell calls, background processes, or telemetry. Tool approvals remain in Hermes.

When opening a conversation whose live session is gone, Paced Chat tries to re-attach it by its stored id. If the earlier messages cannot be read, the pane says so and sending starts a new conversation. If the gateway disconnects while the pane is open or you switch profiles, close Paced Chat and reopen it from the conversation. If Hermes cannot confirm a send, the pane retains the draft and asks you to check the conversation before resending.

## Quick test after installation

1. Start a new chat. At **90 words/min**, send “Explain the difference between processing time and waiting time in three paragraphs. Include a Markdown table and the formula $T_{total}=T_{work}+T_{wait}$.”
2. When the first words appear, move the slider to **600 words/min**. The reply should speed up. Click **Show all** to catch up.
3. Send “Give me an invoice example.” It should use the selected reading speed and the conversation context.
4. Click **Open in Hermes** and verify both prompts appear in the same conversation.

## Disable or remove

Turn off **Paced Chat** under **Capabilities → Plugins**. To remove it, delete the `paced-chat` folder from `desktop-plugins` and reload Desktop plug-ins.

## Release notes

- **0.1.1** re-attaches to the conversation when its live session is gone (gateway restart, restored conversation) instead of becoming read-only; an unreadable history no longer blocks sending. It also adds the Hermes package manifest, the standard Desktop entrypoint layout, and the public catalogue submission files.
- **0.1.0** introduces the single chat pane, live reply pacing, per-reply catch-up, and a saved reading-speed preference.

## Hermes references

- [Desktop plug-in SDK](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk)
- [Hermes Desktop guide](https://hermes-agent.nousresearch.com/docs/user-guide/desktop)
- [Hermes gateway integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)
