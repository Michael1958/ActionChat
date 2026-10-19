// Action Chat - real-time group chat for Cloudflare Workers (free plan).
// Messages live only in memory and are never written to disk.
// The only things stored: the blocked-users list and the "images on/off" setting.

import { DurableObject } from "cloudflare:workers";
import PAGE_HTML from "./page.html";
import LOGO_PNG from "./logo.png";

// ---- Limits (tuned to stay well inside the free plan) ----
const MAX_FRAME = 3_000_000;        // largest incoming message (about 2 MB image after encoding)
const MAX_TEXT = 2000;              // characters per text message
const MAX_CAPTION = 300;            // characters under an image
const TEXT_GAP_MS = 700;            // min time between text messages per user
const IMAGE_GAP_MS = 20_000;        // min time between images per user
const MAX_ADMIN_TRIES = 5;          // wrong admin passwords before lockout
const LOCKOUT_MS = 10 * 60 * 1000;  // lockout length
const SALT = "action-chat-v1";      // used to scramble IP addresses before storing

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const room = cleanRoom(url.searchParams.get("room"));
      const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room));
      return stub.fetch(request);
    }

    if (url.pathname === "/logo.png" || url.pathname === "/favicon.ico") {
      return new Response(LOGO_PNG, {
        headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
      });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const adminName = cleanName(env.ADMIN_NAME) || "Admin";
      const html = PAGE_HTML.replace(
        "__ADMIN_NAME_JSON__",
        JSON.stringify(adminName).replace(/</g, "\\u003c")
      );
      const csp = [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self' 'unsafe-inline'",
        `connect-src 'self' wss://${url.host} ws://${url.host}`,
        "frame-ancestors " + (env.EMBED_ALLOWED || "*"),
      ].join("; ");
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
          "content-security-policy": csp,
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.blocked = [];      // [{ bid, name, keys: [...], at }]
    this.imagesOn = true;
    this.rate = new Map();  // userId -> { t, img }   (memory only)
    this.failed = new Map(); // ipHash -> { count, at } (memory only)

    // Answer client keep-alive pings without waking the room (saves free-plan time).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

    ctx.blockConcurrencyWhile(async () => {
      this.blocked = (await ctx.storage.get("blocked")) || [];
      const img = await ctx.storage.get("imagesOn");
      this.imagesOn = img === undefined ? true : !!img;
    });
  }

  async fetch(request) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const iph = await sha256Hex(SALT + ip);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: shortId(), iph, name: null, admin: false, cid: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string") return;
    if (raw.length > MAX_FRAME) {
      return this.send(ws, { type: "error", text: "That file is too large." });
    }
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    if (!data || typeof data !== "object") return;

    const me = ws.deserializeAttachment() || {};
    if (data.type === "join") return this.handleJoin(ws, me, data);
    if (!me.name) return; // must join first

    switch (data.type) {
      case "msg": return this.handleMessage(ws, me, data);
      case "delete": if (me.admin) this.broadcast({ type: "delete", id: String(data.id || "").slice(0, 40) }); return;
      case "block": if (me.admin) await this.handleBlock(ws, data); return;
      case "unblock": if (me.admin) await this.handleUnblock(ws, data); return;
      case "listBlocked": if (me.admin) this.sendBlockedList(ws); return;
      case "images":
        if (!me.admin) return;
        this.imagesOn = !!data.on;
        await this.ctx.storage.put("imagesOn", this.imagesOn);
        this.broadcast({ type: "settings", imagesOn: this.imagesOn });
        return;
      case "clear": if (me.admin) this.broadcast({ type: "clear", by: me.name }); return;
    }
  }

  async webSocketClose(ws, code) { this.leave(ws, code); }
  async webSocketError(ws) { this.leave(ws, 1011); }

  // ---------- handlers ----------

  async handleJoin(ws, me, data) {
    if (me.name) return;
    const name = cleanName(data.name);
    if (!name) return this.reject(ws, "Use 2 to 20 letters, numbers, spaces, or _ - .", "badname");

    const cid = String(data.cid || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
    if (this.isBlocked(cid, me.iph)) return this.reject(ws, "You have been blocked from this chat.", "blocked");

    const adminName = cleanName(this.env.ADMIN_NAME) || "Admin";
    let admin = false;
    if (name.toLowerCase() === adminName.toLowerCase()) {
      const f = this.failed.get(me.iph);
      if (f && f.count >= MAX_ADMIN_TRIES && Date.now() - f.at < LOCKOUT_MS) {
        return this.reject(ws, "Too many wrong passwords. Try again in 10 minutes.", "locked");
      }
      const ok = this.env.ADMIN_PASSWORD && (await safeEqual(String(data.password || ""), this.env.ADMIN_PASSWORD));
      if (!ok) {
        const cur = f && Date.now() - f.at < LOCKOUT_MS ? f : { count: 0, at: Date.now() };
        cur.count++; cur.at = Date.now();
        this.failed.set(me.iph, cur);
        return this.reject(ws, "This name is reserved for the admin. Wrong password.", "badpass");
      }
      this.failed.delete(me.iph);
      admin = true;
    }

    // Name must be unique among people currently online.
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws || other.readyState !== 1) continue;
      const a = other.deserializeAttachment();
      if (a && a.name && a.name.toLowerCase() === name.toLowerCase()) {
        if (cid && a.cid === cid) {
          // Same device reconnecting (for example after a network drop): replace the old connection.
          this.leave(other, 4000);
          try { other.close(4000, "Replaced by new connection"); } catch {}
        } else {
          return this.reject(ws, "That name is already in use. Please pick another.", "taken");
        }
      }
    }

    me.name = name; me.admin = admin; me.cid = cid;
    ws.serializeAttachment(me);

    this.send(ws, {
      type: "welcome",
      you: { id: me.id, name, admin },
      users: this.onlineUsers(),
      imagesOn: this.imagesOn,
    });
    this.broadcast({ type: "join", user: { id: me.id, name, admin } }, ws);
  }

  handleMessage(ws, me, data) {
    const now = Date.now();
    const r = this.rate.get(me.id) || { t: 0, img: 0 };
    const from = { id: me.id, name: me.name, admin: me.admin };
    let out;

    if (data.kind === "image") {
      if (!this.imagesOn && !me.admin) return this.send(ws, { type: "error", text: "Images are turned off by the admin." });
      const image = String(data.image || "");
      if (!/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(image)) {
        return this.send(ws, { type: "error", text: "Only JPG, PNG, WebP or GIF images are allowed." });
      }
      if (!me.admin && now - r.img < IMAGE_GAP_MS) {
        const wait = Math.ceil((IMAGE_GAP_MS - (now - r.img)) / 1000);
        return this.send(ws, { type: "error", text: `You can post one image every 20 seconds. Wait ${wait}s.` });
      }
      r.img = now;
      out = { type: "msg", id: shortId(), ts: now, from, kind: "image", image, text: cleanText(data.text, MAX_CAPTION) };
    } else {
      const text = cleanText(data.text, MAX_TEXT);
      if (!text) return;
      if (!me.admin && now - r.t < TEXT_GAP_MS) return this.send(ws, { type: "error", text: "Slow down a little." });
      r.t = now;
      out = { type: "msg", id: shortId(), ts: now, from, kind: "text", text };
    }
    this.rate.set(me.id, r);
    this.broadcast(out);
  }

  async handleBlock(adminWs, data) {
    const target = this.ctx.getWebSockets().find((s) => {
      const a = s.deserializeAttachment();
      return a && a.id === data.userId && a.name;
    });
    if (!target) return this.send(adminWs, { type: "error", text: "That user has already left." });
    const t = target.deserializeAttachment();
    if (t.admin) return this.send(adminWs, { type: "error", text: "You cannot block the admin." });

    const keys = [];
    if (t.cid) keys.push("c:" + t.cid);
    if (data.byNetwork) keys.push("i:" + t.iph);
    if (!keys.length) keys.push("i:" + t.iph);
    this.blocked.push({ bid: shortId(), name: t.name, keys, at: Date.now() });
    if (this.blocked.length > 1000) this.blocked = this.blocked.slice(-1000);
    await this.ctx.storage.put("blocked", this.blocked);

    if (data.purge) this.broadcast({ type: "purge", userId: t.id });
    this.send(target, { type: "rejected", code: "blocked", text: "You have been blocked from this chat." });
    this.leave(target, 4003);
    try { target.close(4003, "Blocked"); } catch {}
    this.send(adminWs, { type: "info", text: `${t.name} has been blocked.` });
  }

  async handleUnblock(adminWs, data) {
    this.blocked = this.blocked.filter((b) => b.bid !== data.bid);
    await this.ctx.storage.put("blocked", this.blocked);
    this.sendBlockedList(adminWs);
  }

  sendBlockedList(ws) {
    this.send(ws, {
      type: "blockedList",
      list: this.blocked.map((b) => ({ bid: b.bid, name: b.name, at: b.at, network: b.keys.some((k) => k.startsWith("i:")) })),
    });
  }

  // ---------- helpers ----------

  isBlocked(cid, iph) {
    return this.blocked.some((b) => (cid && b.keys.includes("c:" + cid)) || b.keys.includes("i:" + iph));
  }

  onlineUsers() {
    const users = [];
    for (const s of this.ctx.getWebSockets()) {
      if (s.readyState !== 1) continue;
      const a = s.deserializeAttachment();
      if (a && a.name) users.push({ id: a.id, name: a.name, admin: a.admin });
    }
    return users;
  }

  leave(ws, code) {
    const a = ws.deserializeAttachment();
    if (!a || !a.name) return;
    a.name = null; // make sure we announce the leave only once
    try { ws.serializeAttachment(a); } catch {}
    this.rate.delete(a.id);
    this.broadcast({ type: "leave", id: a.id }, ws);
    try { ws.close(code === 1005 || code === 1006 || !code ? 1000 : code, "bye"); } catch {}
  }

  reject(ws, text, code) {
    this.send(ws, { type: "rejected", code, text });
    try { ws.close(4001, "Rejected"); } catch {}
  }

  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }

  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || ws.readyState !== 1) continue;
      const a = ws.deserializeAttachment();
      if (!a || !a.name) continue;
      try { ws.send(s); } catch {}
    }
  }
}

// ---------- pure helpers ----------

function cleanRoom(r) {
  return (String(r || "main").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32)) || "main";
}

export function cleanName(n) {
  const s = String(n || "").normalize("NFC").replace(/\s+/g, " ").trim();
  if (s.length < 2 || s.length > 20) return "";
  return /^[\p{L}\p{N} _.\-]+$/u.test(s) ? s : "";
}

function cleanText(t, max) {
  return String(t || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, "")
    .slice(0, max)
    .trim();
}

function shortId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(ha, hb);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
