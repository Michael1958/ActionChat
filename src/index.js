// Action Chat v2.3.0 - real-time group chat for Cloudflare Workers (free plan).
// Developed by Michael Gerontides.
// Chat messages are never written to the server's disk. Each user's browser keeps its own copy for 7 days.
// Stored on the server (small, no chat text): blocked users, images on/off, current poll, trivia game,
// pinned announcement, a 7-day list of deleted message IDs (so saved copies can be cleaned up),
// and the profile photos of people who are online right now (deleted as soon as they leave).

import { DurableObject } from "cloudflare:workers";
import PAGE_HTML from "./page.html";
import LOGO_PNG from "./logo.png";

const APP_VERSION = "2.3.0";

// ---- Limits (tuned to stay well inside the free plan) ----
const MAX_FRAME = 3_000_000;        // largest incoming message (about 2 MB image after encoding)
const MAX_TEXT = 2000;              // characters per text message
const MAX_CAPTION = 300;            // characters under an image
const MAX_PHOTO = 16_000;           // largest profile photo (characters); the browser makes them about 2-10 KB
const TEXT_GAP_MS = 700;            // min time between text messages / commands per user
const IMAGE_GAP_MS = 20_000;        // min time between uploaded images per user
const GIF_GAP_MS = 5_000;           // min time between GIFs from the GIF library per user
const REACT_GAP_MS = 150;           // min time between reactions per user
const VOTE_GAP_MS = 500;            // min time between poll votes per user
const MAX_ADMIN_TRIES = 5;          // wrong admin passwords before lockout
const LOCKOUT_MS = 10 * 60 * 1000;  // lockout length
const HISTORY_MS = 7 * 86400000;    // how long browsers keep chat history (and the server keeps deletion notes)
const MAX_TOMBS = 2000;             // max deletion notes kept
const SALT = "action-chat-v1";      // used to scramble IP addresses before storing

const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "👏"];
// Must match the AVATARS list in page.html exactly.
const AVATARS = ["👶", "🧒", "👧", "👦", "🧑", "👩", "👨", "👱‍♀️", "👱", "👩‍🦰", "👨‍🦰", "👩‍🦱", "👨‍🦱", "👩‍🦳", "👨‍🦳", "👩‍🦲", "👨‍🦲", "🧔", "🧓", "👵", "👴", "👮", "🕵️", "💂", "👷", "🤴", "👸", "🤵", "👰", "🧑‍⚕️", "🧑‍🎓", "🧑‍🏫", "🧑‍🍳", "🧑‍🌾", "🧑‍🔧", "🧑‍💻", "🧑‍🎤", "🧑‍🎨", "🧑‍✈️", "🧑‍🚀", "🧑‍🚒", "🥷", "🦸", "🦹", "🧙", "🧚", "🧛", "🧜", "🧝", "🧞", "🧟", "🎅", "🤶", "🤠", "🦁", "🐯", "🐺", "🦊", "🐻", "🐼", "🐨", "🐸", "🐵", "🦄", "🐙", "🦅", "🐬", "🚀", "⚡", "🔥", "⭐", "🎮", "⚽", "🎸"];
const EIGHT_BALL = [
  "It is certain.", "It is decidedly so.", "Without a doubt.", "Yes, definitely.", "You may rely on it.",
  "As I see it, yes.", "Most likely.", "Outlook good.", "Yes.", "Signs point to yes.",
  "Reply hazy, try again.", "Ask again later.", "Better not tell you now.", "Cannot predict now.", "Concentrate and ask again.",
  "Don't count on it.", "My reply is no.", "My sources say no.", "Outlook not so good.", "Very doubtful.",
];

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
      const klipyKey = String(env.KLIPY_KEY || "").replace(/[^A-Za-z0-9_-]/g, "");
      const html = PAGE_HTML
        .replace("__ADMIN_NAME_JSON__", JSON.stringify(adminName).replace(/</g, "\\u003c"))
        .replace("__KLIPY_KEY_JSON__", JSON.stringify(klipyKey))
        .replace("__APP_VERSION_JSON__", JSON.stringify(APP_VERSION));
      const csp = [
        "default-src 'self'",
        "img-src 'self' data: blob: https://*.klipy.com https://klipy.com",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self' 'unsafe-inline'",
        `connect-src 'self' wss://${url.host} ws://${url.host} https://api.klipy.com`,
        "frame-ancestors " + (env.EMBED_ALLOWED || "*"),
      ].join("; ");
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
          "content-security-policy": csp,
          "referrer-policy": "strict-origin-when-cross-origin",
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
    this.blocked = [];       // [{ bid, name, keys: [...], at }]
    this.imagesOn = true;
    this.poll = null;        // { id, q, options, votes: { key: index }, open }
    this.trivia = null;      // { id, q, answers, display, status, round, scores, winner }
    this.pin = null;         // { text, until, at }
    this.tombs = [];         // deletion notes, no text: { k: "d", id } deleted msg, { k: "p", u } purged user, { k: "c" } cleared
    this.photos = new Map(); // userId -> photo (only people online right now)
    this.noPhoto = new Set();// devices whose photo the admin removed (memory only)
    this.rate = new Map();   // userId -> timestamps (memory only)
    this.failed = new Map(); // ipHash -> { count, at } (memory only)
    this.pollTimer = null;

    // Answer client keep-alive pings without waking the room (saves free-plan time).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

    ctx.blockConcurrencyWhile(async () => {
      this.blocked = (await ctx.storage.get("blocked")) || [];
      const img = await ctx.storage.get("imagesOn");
      this.imagesOn = img === undefined ? true : !!img;
      this.poll = (await ctx.storage.get("poll")) || null;
      this.trivia = (await ctx.storage.get("trivia")) || null;
      this.pin = (await ctx.storage.get("pin")) || null;
      this.tombs = (await ctx.storage.get("tombs")) || [];

      // Reload photos of people still connected (after the room wakes up); delete any leftovers.
      const live = new Set();
      for (const s of ctx.getWebSockets()) {
        const a = s.deserializeAttachment();
        if (a && a.name && a.ph) live.add(a.id);
      }
      const stored = await ctx.storage.list({ prefix: "ph:" });
      const stale = [];
      for (const [k, v] of stored) {
        const id = k.slice(3);
        if (live.has(id)) this.photos.set(id, v); else stale.push(k);
      }
      for (let i = 0; i < stale.length; i += 128) await ctx.storage.delete(stale.slice(i, i + 128));
    });
  }

  async fetch(request) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const iph = await sha256Hex(SALT + ip);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: shortId(), iph, name: null, admin: false, cid: null, av: "", ph: false });
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
      case "react": return this.handleReact(ws, me, data);
      case "vote": return this.handleVote(ws, me, data);
      case "delete": {
        if (!me.admin) return;
        const id = cleanId(data.id);
        if (!id) return;
        this.broadcast({ type: "delete", id });
        await this.addTomb({ k: "d", id });
        return;
      }
      case "block": if (me.admin) await this.handleBlock(ws, data); return;
      case "unblock": if (me.admin) await this.handleUnblock(ws, data); return;
      case "listBlocked": if (me.admin) this.sendBlockedList(ws); return;
      case "removePhoto": if (me.admin) await this.removePhoto(ws, data); return;
      case "images":
        if (!me.admin) return;
        this.imagesOn = !!data.on;
        await this.ctx.storage.put("imagesOn", this.imagesOn);
        this.broadcast({ type: "settings", imagesOn: this.imagesOn });
        return;
      case "clear": {
        if (!me.admin) return;
        const at = Date.now();
        this.broadcast({ type: "clear", by: me.name, at });
        // Everything older is covered by the clear note, so the older notes are no longer needed.
        this.tombs = [{ k: "c", at }];
        await this.ctx.storage.put("tombs", this.tombs);
        return;
      }
      case "pollStart": if (me.admin) await this.pollStart(ws, data); return;
      case "pollEnd": if (me.admin) await this.pollEnd(); return;
      case "pollRemove": if (me.admin) await this.pollRemove(); return;
      case "triviaStart": if (me.admin) await this.triviaStart(ws, data); return;
      case "triviaReveal": if (me.admin) await this.triviaReveal(); return;
      case "triviaEnd": if (me.admin) await this.triviaEnd(); return;
      case "pin": if (me.admin) await this.setPin(ws, data); return;
      case "unpin": if (me.admin) await this.setPin(ws, null); return;
    }
  }

  async webSocketClose(ws, code) { this.leave(ws, code); }
  async webSocketError(ws) { this.leave(ws, 1011); }

  // ---------- deletion notes (no message text) ----------

  freshTombs() {
    const cutoff = Date.now() - HISTORY_MS;
    return this.tombs.filter((t) => t.at >= cutoff);
  }

  async addTomb(t) {
    t.at = Date.now();
    this.tombs = this.freshTombs();
    this.tombs.push(t);
    if (this.tombs.length > MAX_TOMBS) {
      // Keep the newest notes, but never drop the latest "cleared" note.
      const lastClear = [...this.tombs].reverse().find((x) => x.k === "c");
      this.tombs = this.tombs.slice(-MAX_TOMBS);
      if (lastClear && !this.tombs.includes(lastClear)) this.tombs.unshift(lastClear);
    }
    await this.ctx.storage.put("tombs", this.tombs);
  }

  // ---------- join ----------

  async handleJoin(ws, me, data) {
    if (me.name) return;
    const name = cleanName(data.name);
    if (!name) return this.reject(ws, "Use 2 to 20 letters, numbers, spaces, or _ - .", "badname");

    const cid = String(data.cid || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);

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

    // Blocks never apply to the admin (so blocking someone on the same Wi-Fi can't lock the admin out).
    if (!admin && this.isBlocked(cid, me.iph)) return this.reject(ws, "You have been blocked from this chat.", "blocked");

    // Name must be unique among people currently online.
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws || other.readyState !== 1) continue;
      const a = other.deserializeAttachment();
      if (a && a.name && a.name.toLowerCase() === name.toLowerCase()) {
        if (cid && a.cid === cid) {
          this.leave(other, 4000);
          try { other.close(4000, "Replaced by new connection"); } catch {}
        } else {
          return this.reject(ws, "That name is already in use. Please pick another.", "taken");
        }
      }
    }

    // Profile photo (the admin always shows the lion logo).
    let photo = "", photoNote = "";
    if (!admin && data.photo) {
      if (cid && this.noPhoto.has(cid)) photoNote = "removed";
      else if (validPhoto(data.photo)) photo = data.photo;
      else photoNote = "invalid";
    }

    me.name = name; me.admin = admin; me.cid = cid;
    me.av = AVATARS.includes(data.av) ? data.av : "";
    me.ph = !!photo;
    ws.serializeAttachment(me);
    if (photo) {
      this.photos.set(me.id, photo);
      await this.ctx.storage.put("ph:" + me.id, photo);
    }

    const poll = this.pollPublic();
    if (poll) {
      const v = this.poll.votes[cid || me.id];
      poll.myVote = v === undefined ? null : v;
    }
    this.send(ws, {
      type: "welcome",
      version: APP_VERSION,
      now: Date.now(),
      you: userOf(me),
      photoNote,
      users: this.onlineUsers(true),
      imagesOn: this.imagesOn,
      poll,
      trivia: this.triviaPublic(),
      pin: this.pin,
      tombs: this.freshTombs(),
    });
    const joined = userOf(me);
    if (photo) joined.photo = photo;
    this.broadcast({ type: "join", user: joined }, ws);
  }

  // ---------- messages & commands ----------

  handleMessage(ws, me, data) {
    const now = Date.now();
    const r = this.rate.get(me.id) || { t: 0, img: 0, gif: 0, re: 0, vote: 0 };
    const from = userOf(me);
    const replyTo = cleanReply(data.replyTo);
    let out;

    if (data.kind === "image" || data.kind === "gif") {
      if (!this.imagesOn && !me.admin) return this.send(ws, { type: "error", text: "Images and GIFs are turned off by the admin." });
    }

    if (data.kind === "gif") {
      const gifUrl = cleanGifUrl(data.url);
      if (!gifUrl) return this.send(ws, { type: "error", text: "That GIF could not be sent." });
      if (!me.admin && now - r.gif < GIF_GAP_MS) {
        const wait = Math.ceil((GIF_GAP_MS - (now - r.gif)) / 1000);
        return this.send(ws, { type: "error", text: `You can post one GIF every 5 seconds. Wait ${wait}s.` });
      }
      r.gif = now;
      out = { type: "msg", id: shortId(), ts: now, from, kind: "gif", url: gifUrl, text: cleanText(data.text, MAX_CAPTION), replyTo };
    } else if (data.kind === "image") {
      const image = String(data.image || "");
      if (!/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(image)) {
        return this.send(ws, { type: "error", text: "Only JPG, PNG, WebP or GIF images are allowed." });
      }
      if (!me.admin && now - r.img < IMAGE_GAP_MS) {
        const wait = Math.ceil((IMAGE_GAP_MS - (now - r.img)) / 1000);
        return this.send(ws, { type: "error", text: `You can post one image every 20 seconds. Wait ${wait}s.` });
      }
      r.img = now;
      out = { type: "msg", id: shortId(), ts: now, from, kind: "image", image, text: cleanText(data.text, MAX_CAPTION), replyTo };
    } else {
      let text = cleanText(data.text, MAX_TEXT);
      if (!text) return;
      if (!me.admin && now - r.t < TEXT_GAP_MS) return this.send(ws, { type: "error", text: "Slow down a little." });
      r.t = now;
      this.rate.set(me.id, r);
      if (text.startsWith("//")) text = text.slice(1);          // "//text" sends a literal slash
      else if (text.startsWith("/")) return this.handleCommand(ws, me, text, now);
      out = { type: "msg", id: shortId(), ts: now, from, kind: "text", text, replyTo };
      this.broadcast(out);
      return this.checkTrivia(me, text);
    }
    this.rate.set(me.id, r);
    this.broadcast(out);
  }

  handleCommand(ws, me, text, now) {
    const m = text.match(/^\/(\S+)\s*([\s\S]*)$/);
    const cmd = (m ? m[1] : "").toLowerCase();
    const arg = (m ? m[2] : "").trim();
    const base = { type: "msg", id: shortId(), ts: now, from: userOf(me), kind: "action", cmd };

    switch (cmd) {
      case "help":
        return this.send(ws, { type: "help" });
      case "roll": {
        let n = 1, s = 6;
        const d = arg.match(/^(\d{1,2})?\s*d\s*(\d{1,4})$/i);
        if (d) { n = d[1] ? +d[1] : 1; s = +d[2]; }
        else if (/^\d{1,4}$/.test(arg)) { s = +arg; }
        else if (arg) return this.send(ws, { type: "error", text: "Try /roll, /roll 20 or /roll 2d6." });
        if (n < 1 || n > 10 || s < 2 || s > 1000) return this.send(ws, { type: "error", text: "Use 1 to 10 dice with 2 to 1000 sides." });
        const rolls = Array.from({ length: n }, () => rnd(s) + 1);
        const sum = rolls.reduce((a, b) => a + b, 0);
        return this.broadcast({ ...base, icon: "🎲", text: `rolled ${n}d${s}` + (n > 1 ? ` (${rolls.join(" + ")})` : ""), result: String(sum) });
      }
      case "flip":
        return this.broadcast({ ...base, icon: "🪙", text: "flipped a coin", result: rnd(2) ? "Heads" : "Tails" });
      case "8ball": {
        if (!arg) return this.send(ws, { type: "error", text: "Ask a question, for example: /8ball Will it rain tomorrow?" });
        return this.broadcast({ ...base, icon: "🎱", text: `asked: "${arg.slice(0, 200)}"`, result: EIGHT_BALL[rnd(EIGHT_BALL.length)] });
      }
      case "me": {
        if (!arg) return this.send(ws, { type: "error", text: "Add an action, for example: /me waves hello" });
        return this.broadcast({ ...base, icon: "✨", text: arg.slice(0, 300), result: "" });
      }
      default:
        return this.send(ws, { type: "error", text: "Unknown command. Type /help to see all commands." });
    }
  }

  handleReact(ws, me, data) {
    const id = cleanId(data.id);
    if (!id || !REACTIONS.includes(data.emoji)) return;
    const now = Date.now();
    const r = this.rate.get(me.id) || { t: 0, img: 0, gif: 0, re: 0, vote: 0 };
    if (now - r.re < REACT_GAP_MS) return;
    r.re = now; this.rate.set(me.id, r);
    this.broadcast({ type: "react", id, emoji: data.emoji, on: !!data.on, user: { id: me.id, name: me.name } });
  }

  // ---------- polls ----------

  pollPublic() {
    const p = this.poll;
    if (!p) return null;
    const counts = p.options.map(() => 0);
    for (const k in p.votes) { const v = p.votes[k]; if (counts[v] !== undefined) counts[v]++; }
    return { id: p.id, q: p.q, options: p.options, counts, total: counts.reduce((a, b) => a + b, 0), open: p.open };
  }

  async pollStart(ws, data) {
    const q = cleanText(data.q, 200);
    const options = (Array.isArray(data.options) ? data.options : []).map((o) => cleanText(o, 80)).filter(Boolean).slice(0, 6);
    if (!q || options.length < 2) return this.send(ws, { type: "error", text: "A poll needs a question and at least 2 options." });
    this.poll = { id: shortId(), q, options, votes: {}, open: true };
    await this.ctx.storage.put("poll", this.poll);
    this.broadcast({ type: "poll", poll: this.pollPublic(), event: "start" });
  }

  async handleVote(ws, me, data) {
    const p = this.poll;
    if (!p || !p.open || data.pollId !== p.id) return;
    const idx = Number(data.option);
    if (!Number.isInteger(idx) || idx < 0 || idx >= p.options.length) return;
    const now = Date.now();
    const r = this.rate.get(me.id) || { t: 0, img: 0, gif: 0, re: 0, vote: 0 };
    if (now - r.vote < VOTE_GAP_MS) return;
    r.vote = now; this.rate.set(me.id, r);
    const key = me.cid || me.id;
    if (p.votes[key] === undefined && Object.keys(p.votes).length >= 5000) return;
    p.votes[key] = idx;
    await this.ctx.storage.put("poll", p);
    if (!this.pollTimer) {
      this.pollTimer = setTimeout(() => {
        this.pollTimer = null;
        this.broadcast({ type: "poll", poll: this.pollPublic() });
      }, 700);
    }
  }

  async pollEnd() {
    if (!this.poll) return;
    this.poll.open = false;
    await this.ctx.storage.put("poll", this.poll);
    this.broadcast({ type: "poll", poll: this.pollPublic(), event: "end" });
  }

  async pollRemove() {
    this.poll = null;
    await this.ctx.storage.delete("poll");
    this.broadcast({ type: "poll", poll: null });
  }

  // ---------- trivia ----------

  triviaPublic() {
    const t = this.trivia;
    if (!t) return null;
    return {
      id: t.id, q: t.q, round: t.round, status: t.status, winner: t.winner || null,
      answer: t.status !== "open" ? t.display : null, scores: topScores(t.scores),
    };
  }

  async triviaStart(ws, data) {
    const q = cleanText(data.q, 300);
    const raw = String(data.a || "").split("|").map((s) => cleanText(s, 80)).filter(Boolean).slice(0, 10);
    const answers = raw.map(normAnswer).filter(Boolean);
    if (!q || !answers.length) return this.send(ws, { type: "error", text: "Trivia needs a question and an answer." });
    const prev = this.trivia;
    this.trivia = {
      id: shortId(), q, answers, display: raw[0], status: "open",
      round: prev ? prev.round + 1 : 1, scores: prev ? prev.scores : {}, winner: null,
    };
    await this.ctx.storage.put("trivia", this.trivia);
    this.broadcast({ type: "trivia", trivia: this.triviaPublic(), event: "question" });
  }

  async checkTrivia(me, text) {
    const t = this.trivia;
    if (!t || t.status !== "open" || me.admin) return;
    const guess = normAnswer(text);
    if (!guess || !t.answers.some((a) => closeEnough(guess, a))) return;
    t.status = "solved";
    t.winner = me.name;
    const key = me.cid || me.id;
    const s = t.scores[key] || { name: me.name, pts: 0 };
    s.name = me.name; s.pts++;
    t.scores[key] = s;
    await this.ctx.storage.put("trivia", t);
    this.broadcast({ type: "trivia", trivia: this.triviaPublic(), event: "solved" });
  }

  async triviaReveal() {
    const t = this.trivia;
    if (!t || t.status !== "open") return;
    t.status = "revealed";
    await this.ctx.storage.put("trivia", t);
    this.broadcast({ type: "trivia", trivia: this.triviaPublic(), event: "reveal" });
  }

  async triviaEnd() {
    if (!this.trivia) return;
    const final = topScores(this.trivia.scores);
    this.trivia = null;
    await this.ctx.storage.delete("trivia");
    this.broadcast({ type: "trivia", trivia: null, event: "end", final });
  }

  // ---------- pinned announcement ----------

  async setPin(ws, data) {
    if (!data) {
      this.pin = null;
      await this.ctx.storage.delete("pin");
      return this.broadcast({ type: "pin", pin: null });
    }
    const text = cleanText(data.text, 200);
    if (!text) return this.send(ws, { type: "error", text: "The announcement is empty." });
    let until = Number(data.until) || 0;
    const now = Date.now();
    if (until && (until < now || until > now + 366 * 86400000)) until = 0;
    this.pin = { text, until, at: now };
    await this.ctx.storage.put("pin", this.pin);
    this.broadcast({ type: "pin", pin: this.pin, event: "new" });
  }

  // ---------- moderation ----------

  findUser(id) {
    return this.ctx.getWebSockets().find((s) => {
      const a = s.deserializeAttachment();
      return a && a.id === id && a.name;
    });
  }

  async removePhoto(adminWs, data) {
    const target = this.findUser(data.userId);
    if (!target) return this.send(adminWs, { type: "error", text: "That user has already left." });
    const t = target.deserializeAttachment();
    if (!t.ph) return this.send(adminWs, { type: "info", text: `${t.name} has no photo.` });
    t.ph = false;
    target.serializeAttachment(t);
    this.photos.delete(t.id);
    await this.ctx.storage.delete("ph:" + t.id);
    if (t.cid) this.noPhoto.add(t.cid);
    this.broadcast({ type: "photo", id: t.id, photo: null });
    this.send(adminWs, { type: "info", text: `${t.name}'s photo was removed.` });
  }

  async handleBlock(adminWs, data) {
    const target = this.findUser(data.userId);
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

    if (t.ph) this.broadcast({ type: "photo", id: t.id, photo: null });
    if (data.purge) {
      this.broadcast({ type: "purge", userId: t.id });
      await this.addTomb({ k: "p", u: t.id });
    }
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

  onlineUsers(withPhotos) {
    const users = [];
    for (const s of this.ctx.getWebSockets()) {
      if (s.readyState !== 1) continue;
      const a = s.deserializeAttachment();
      if (!a || !a.name) continue;
      const u = userOf(a);
      if (withPhotos && this.photos.has(a.id)) u.photo = this.photos.get(a.id);
      users.push(u);
    }
    return users;
  }

  leave(ws, code) {
    const a = ws.deserializeAttachment();
    if (!a || !a.name) return;
    const hadPhoto = a.ph;
    a.name = null; a.ph = false; // make sure we announce the leave only once
    try { ws.serializeAttachment(a); } catch {}
    this.rate.delete(a.id);
    if (hadPhoto || this.photos.has(a.id)) {
      this.photos.delete(a.id);
      try { this.ctx.storage.delete("ph:" + a.id); } catch {}
    }
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

function userOf(a) { return { id: a.id, name: a.name, admin: !!a.admin, av: a.av || "" }; }

function validPhoto(p) {
  const s = String(p || "");
  return s.length <= MAX_PHOTO && /^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/=]+$/.test(s);
}

function cleanRoom(r) {
  return (String(r || "main").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32)) || "main";
}

function cleanId(id) { return String(id || "").replace(/[^a-z0-9]/gi, "").slice(0, 40); }

export function cleanName(n) {
  const s = String(n || "").normalize("NFC").replace(/\s+/g, " ").trim();
  if (s.length < 2 || s.length > 20) return "";
  return /^[\p{L}\p{N} _.\-]+$/u.test(s) ? s : "";
}

function cleanReply(r) {
  if (!r || typeof r !== "object") return null;
  const id = cleanId(r.id), name = cleanName(r.name);
  if (!id || !name) return null;
  return { id, name, snippet: cleanText(r.snippet, 120) };
}

// Only allow GIF links that point to the KLIPY library (stops people posting random web images).
export function cleanGifUrl(u) {
  const s = String(u || "");
  if (s.length > 1500) return "";
  try {
    const x = new URL(s);
    if (x.protocol !== "https:") return "";
    const h = x.hostname.toLowerCase();
    if (h !== "klipy.com" && !h.endsWith(".klipy.com")) return "";
    return x.href;
  } catch { return ""; }
}

function cleanText(t, max) {
  return String(t || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, "")
    .slice(0, max)
    .trim();
}

// Makes answers comparable: no accents, no capitals, no punctuation, no leading "the/a/an".
export function normAnswer(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/^(the|a|an) /, "").slice(0, 80);
}

// Accepts the exact answer, or one small typo (wrong, missing, extra or swapped letter) for answers of 5+ characters.
export function closeEnough(guess, answer) {
  if (guess === answer) return true;
  if (answer.length < 5 || Math.abs(guess.length - answer.length) > 1) return false;
  const a = guess, b = answer;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length] <= 1;
}

function topScores(scores) {
  return Object.values(scores || {}).sort((x, y) => y.pts - x.pts).slice(0, 5);
}

function rnd(n) {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] % n;
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
