# Action Chat

Free, embeddable group chat. No sign-up, messages are never saved.
Runs on the Cloudflare free plan (Workers + Durable Objects).

## Files
| File | What it is |
|---|---|
| `src/index.js` | The chat server |
| `src/page.html` | The chat screen (design, colors, texts) |
| `src/logo.png` | The lion logo |
| `wrangler.jsonc` | Cloudflare settings, including the admin name |
| `package.json` | Tells Cloudflare which deploy tool to use |

## Setup (no installs, about 15 minutes)

### 1. Put the files on GitHub
1. Go to github.com, then **New repository**. Name it `action-chat`. Private is fine. Click **Create**.
2. Click **uploading an existing file**.
3. Drag in **everything inside** the unzipped `action-chat` folder, including the `src` folder.
4. Click **Commit changes**.

### 2. Deploy on Cloudflare
1. Open dash.cloudflare.com, then **Workers & Pages**, then **Create**.
2. Choose **Import a repository** and connect your GitHub account the first time.
3. Pick the `action-chat` repository.
4. Leave the build settings at their defaults. The deploy command is `npx wrangler deploy`.
5. Click **Deploy** and wait about 1 minute.
6. Cloudflare shows your address, for example `https://action-chat.YOURNAME.workers.dev`.

### 3. Set the admin password (required)
1. In Cloudflare, open the `action-chat` Worker, then **Settings**, then **Variables and Secrets**, then **Add**.
2. Type: **Secret**. Name: `ADMIN_PASSWORD`. Value: your password.
3. Click **Deploy** or **Save**.

Without this step, nobody can log in as admin.

To log in as admin, type the admin name (`Admin` by default) on the join screen. A password box appears.
To change the admin name, edit `ADMIN_NAME` in `wrangler.jsonc` on GitHub. Cloudflare redeploys automatically.

### 4. Put it on your website
```html
<iframe src="https://action-chat.YOURNAME.workers.dev"
        style="width:100%;height:600px;border:0;border-radius:12px"
        allow="clipboard-write" title="Action Chat"></iframe>
```
Separate rooms: add `?room=name` to the address, for example `...workers.dev/?room=events`. Each room is independent.

Optional: to allow embedding only on your own site, add a variable `EMBED_ALLOWED` in `wrangler.jsonc` under `vars`, for example `"https://www.example.com"`.

## Admin tools
- Hover over a message to **delete** it or **block** its author.
- Hover over a name in the Online list to block that person.
- Use the ⋮ menu for **Turn images on/off**, **Blocked users** (unblock), and **Clear chat for everyone**.

Blocking works on the person's device. The option "Also block their internet connection" is stronger, but can block other people on the same Wi-Fi.
IP addresses are scrambled (hashed) before storage and are never kept in readable form.

## Built-in limits (keep it free and fast)
- Text: 2,000 characters, one message every 0.7 seconds per person.
- Images: shrunk in the browser to about 200 KB. One image every 20 seconds per person.
- GIFs: up to 2 MB.
- The admin is exempt from the speed limits.

If the daily free limits are ever exceeded, the chat pauses until 03:00 Greek time. Cloudflare never sends a bill on the free plan.
