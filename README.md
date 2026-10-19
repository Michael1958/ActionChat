# Action Chat v2.0.0

Free, embeddable group chat. No sign-up, messages are never saved.
Runs on the Cloudflare free plan (Workers + Durable Objects).
Developed by Michael Gerontides.

## What's new in v2.0.0
- **Emoji reactions** (👍 ❤️ 😂 😮 😢 🔥 🎉 👏): hover over a message, or tap it on a phone.
- **Replies**: reply to a specific message. Click the quote to jump to the original.
- **@mentions**: type @ to pick a name. The person gets a sound and a gold highlight.
- **Confetti**: "congrats", "happy birthday", "χρόνια πολλά" or 🎉 makes confetti fall for everyone.
- **Fun commands**: /roll, /roll 2d6, /flip, /8ball question, /me action, /help. Type //text to send a message starting with "/".
- **Live polls** (admin): ⋮ menu → Start a poll. One vote per device, and votes can be changed.
- **Trivia game** (admin): ⋮ menu → Start trivia. Includes 40 built-in questions, ignores accents and capitals, and accepts one small typo.
- **Pinned announcement with countdown** (admin): ⋮ menu → Pin announcement, or use the 📌 button on a message.
- **Emoji avatars** on the join screen.
- **Unread counter** in the browser tab.
- **Sounds on/off** in the ⋮ menu.
- **Version and developer name** shown on the join screen, in the online list and in the menu.

Polls, trivia scores and the pinned announcement are kept until the admin removes them,
so they survive when the chat room goes to sleep. No chat messages are stored.

## Publish an update
1. In GitHub, open the `src` folder of the ActionChat repository.
2. Click Add file → Upload files, drag in `index.js` and `page.html`, and click Commit changes.
3. Optionally, upload this README.md to the top level of the repository.
4. Cloudflare redeploys automatically. Wait for the green tick under Deployments, then press Ctrl + F5 on the chat page.

Your secrets (ADMIN_PASSWORD, KLIPY_KEY) and logo.png stay as they are.
