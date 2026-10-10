/* PP MOD Cloudflare Worker + D1 API (v1)
 * Deploy: GitHub repo root e wrangler.toml + src/index.js push korlei auto-deploy.
 * Auth: Firebase ID token (Authorization: Bearer) -> Google accounts:lookup e verify.
 * D1 binding name: DB
 */

const PROJECT_ID = "ppmod1";
const TOKEN_ISS = "https://securetoken.google.com/ppmod1";

/* ---------------- helpers ---------------- */
const nowISO = () => new Date().toISOString();
const nid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
const num = (v, d = 0) => { const n = Number(v); return isNaN(n) ? d : n; };

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,X-Gateway-Secret,X-Import-Key",
    "Access-Control-Max-Age": "86400",
    ...extra,
  };
}
const J = (data, status = 200, cache = 0) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors(cache ? { "Cache-Control": `public, max-age=${cache}` } : { "Cache-Control": "no-store" }) },
  });
const E = (msg, status = 400) => J({ ok: false, error: msg }, status);

/* simple per-isolate throttle for mutations: 40 req/min per IP */
const bucket = new Map();
function throttled(req, n = 40) {
  try {
    const ip = req.headers.get("CF-Connecting-IP") || "x";
    const k = Math.floor(Date.now() / 60000) + ":" + ip;
    const c = (bucket.get(k) || 0) + 1;
    bucket.set(k, c);
    if (bucket.size > 2000) bucket.clear();
    return c > n;
  } catch { return false; }
}

/* ---------------- Firebase ID token verify (no crypto lib needed) ---------------- */
const tokCache = new Map(); // token -> {at, user}
async function verifyIdToken(env, token) {
  if (!token) return null;
  const hit = tokCache.get(token);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.user;
  try {
    const key = env.FIREBASE_API_KEY || "AIzaSyAQmiWD9fP0nFpl7ShPjE51udtyFWo6jpA";
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: token }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const u = j && j.users && j.users[0];
    if (!u || !u.localId) return null;
    const user = {
      uid: String(u.localId),
      email: (u.email || "").toString(),
      name: (u.displayName || "").toString(),
      picture: (u.photoUrl || "").toString(),
    };
    if (tokCache.size > 2000) tokCache.clear();
    tokCache.set(token, { at: Date.now(), user });
    return user;
  } catch { return null; }
}
function isAdmin(env, user) {
  if (!user || !user.email) return false;
  const list = ((env.ADMIN_EMAILS || "admin@gmail.com") + "").toLowerCase().split(/[,;\s]+/).filter(Boolean);
  return list.includes(user.email.toLowerCase());
}
async function needAuth(env, req) {
  const h = req.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  const user = await verifyIdToken(env, m ? m[1].trim() : "");
  return user;
}

/* ---------------- config ---------------- */
const DEF_CFG = {
  fee: 3, coinRate: 7, pointRate: 0.6, pendingDays: 3, withdrawMin: 50, minDeposit: 21,
  starRate: 6, starPack3: 18, starsEnabled: true, starAdmin: "@Blackmoney54",
  bkash: "01647712206", nagad: "01647712206", rocket: "01647712206", tgStars: "@Blackmoney54",
  admin: "https://t.me/Blackmoney54", support: "https://t.me/Blackmoney54",
  group: "https://t.me/googleplaypointhack", notice: "",
  popupTitle: "", popupMsg: "", popupImage: "", popupUntil: "",
  bcTitle: "", bcMsg: "", bcImage: "", bcId: "", bcUntil: "",
  maintenance: false, maintMsg: "App is under scheduled maintenance. Will resume shortly.",
  serviceOff: false, serviceMsg: "Game service ekhon bondho ache. Pore abar try korun.",
  botMode: false, bins: ["453590"], activeBin: "453590",
  genMode: "free", genPrice: 10, genDays: 7, genOffMsg: "",
  addrGenEnabled: true, addrOffMsg: "",
  idBot: "https://t.me/userinfobot", notifyBot: "https://t.me/Ppmod_bot",
  autoDeposit: true, appVersionBuild: "",
};
async function getCfg(db) {
  const out = { ...DEF_CFG };
  try {
    const rs = await db.prepare("SELECT key, value FROM config").all();
    for (const r of rs.results || []) {
      try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
    }
  } catch {}
  return out;
}
async function setCfg(db, patch) {
  const b = db.batch();
  for (const [k, v] of Object.entries(patch)) {
    b.push(db.prepare("INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(k, JSON.stringify(v)));
  }
  await b.send();
}

/* ---------------- users ---------------- */
function rowUser(r) {
  if (!r) return null;
  return {
    uid: r.uid, name: r.name || "", email: r.email || "", photo: r.photo || "", avatar: r.avatar || "",
    balance: num(r.balance), playPoints: num(r.play_points), pendingPoints: num(r.pending_points),
    banned: !!r.banned, tgChatId: r.tg_chat_id || "", refCode: r.ref_code || "", referredBy: r.referred_by || "",
    refCount: num(r.ref_count), refEarned: num(r.ref_earned), genUntil: num(r.gen_until),
  };
}
async function ensureUser(db, fb) {
  let r = await db.prepare("SELECT * FROM users WHERE uid=?").bind(fb.uid).first();
  const t = nowISO();
  if (!r) {
    await db.prepare("INSERT INTO users(uid,name,email,photo,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .bind(fb.uid, fb.name || "User", fb.email || "", fb.picture || "", t, t).run();
    r = await db.prepare("SELECT * FROM users WHERE uid=?").bind(fb.uid).first();
  } else if ((fb.name && fb.name !== r.name) || (fb.email && fb.email !== r.email) || (fb.picture && fb.picture !== r.photo)) {
    await db.prepare("UPDATE users SET name=?,email=?,photo=?,updated_at=? WHERE uid=?")
      .bind(fb.name || r.name, fb.email || r.email, fb.picture || r.photo, t, fb.uid).run();
    r = { ...r, name: fb.name || r.name, email: fb.email || r.email, photo: fb.picture || r.photo };
  }
  return r;
}

/* ---------------- public mappers ---------------- */
const mapOffer = (r) => ({ id: r.id, name: r.name, logo: r.logo || "", points: r.points ?? 50, banner: r.banner || "", active: !!r.active, order: num(r.ord), createdAt: r.created_at });
const mapStore = (r, rate) => {
  const pts = num(r.points);
  const price = num(r.price) > 0 ? num(r.price) : Math.round(pts * rate);
  return { id: r.id, title: r.title, points: pts, price, tag: r.tag || "", order: num(r.ord), inStock: !!r.in_stock, active: !!r.active, createdAt: r.created_at };
};
const mapDep = (r) => ({ id: r.id, uid: r.uid, name: r.name, email: r.email, method: r.method, amount: num(r.amount), coins: num(r.coins), trxId: r.trx_id, status: r.status, adminMsg: r.admin_msg || "", autoApproved: !!r.auto_approved, createdAt: r.created_at, approvedAt: r.approved_at || null });
const mapOrd = (r) => ({ id: r.id, uid: r.uid, name: r.name, email: r.email, game: r.game, logo: r.logo || "", method: r.method, amount: num(r.amount), trxId: r.trx_id || "", accEmail: r.acc_email || "", accPass: r.acc_pass || "", userTgId: r.user_tg || "", status: r.status, adminMsg: r.admin_msg || "", createdAt: r.created_at });
const mapSell = (r) => ({ id: r.id, uid: r.uid, userName: r.user_name, userEmail: r.user_email, packageTitle: r.package_title, points: num(r.points), payoutAmount: num(r.payout_amount), gmail: r.gmail, password: r.password, userTg: r.user_tg, status: r.status, createdAt: r.created_at });
const mapPend = (r) => ({ id: r.id, uid: r.uid, points: num(r.points), packageTitle: r.package_title, status: r.status, createdAt: r.created_at, unlockAt: r.unlock_at, movedAt: r.moved_at || null });
const mapWd = (r) => ({ id: r.id, uid: r.uid, name: r.name, email: r.email, method: r.method, account: r.account, points: num(r.points), amount: num(r.amount), status: r.status, createdAt: r.created_at });

/* ---------------- deposits: approve + gateway ---------------- */
async function approveDeposit(db, depId, v, verifiedAmount, coinRate) {
  const trx = (v.trx_id || "").toUpperCase();
  if (!trx) throw new Error("NO_TRX");
  const used = await db.prepare("SELECT trx_id FROM used_trx WHERE trx_id=?").bind(trx).first();
  if (used) throw new Error("TRX_ALREADY_USED");
  if ((v.status || "") !== "pending") throw new Error("DEP_INVALID");
  const rate = num(coinRate, 7);
  const coins = num(v.coins) || Math.floor(num(verifiedAmount) / rate) || 3;
  const t = nowISO();
  const u = await db.prepare("SELECT * FROM users WHERE uid=?").bind(v.uid).first();
  const stmts = [];
  if (!u) {
    stmts.push(db.prepare("INSERT INTO users(uid,name,email,balance,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(v.uid, v.name || "User", v.email || "", coins, t, t));
  } else {
    stmts.push(db.prepare("UPDATE users SET balance=balance+?, updated_at=? WHERE uid=?").bind(coins, t, v.uid));
  }
  stmts.push(db.prepare("UPDATE deposits SET status='approved', auto_approved=1, approved_at=? WHERE id=?").bind(t, depId));
  stmts.push(db.prepare("INSERT INTO used_trx(trx_id,uid,amount,dep_id,used_at) VALUES(?,?,?,?,?)").bind(trx, v.uid, verifiedAmount, depId, t));
  stmts.push(db.prepare("UPDATE gateway_sms SET claimed=1, claimed_by=? WHERE trx_id=?").bind(v.uid, trx));
  await db.batch(stmts);
  return coins;
}
function parseSmsBody(sender, body) {
  if (!body) return null;
  const text = String(body).replace(/\n/g, " ");
  let method = null, trxId = null, amount = null;
  if (/bkash/i.test(sender) || /bkash/i.test(text)) {
    method = "bKash";
    const tm = text.match(/TrxID\s+([A-Za-z0-9]+)/i) || text.match(/\b([A-Z0-9]{10})\b/);
    const am = text.match(/Tk\s+([\d,]+(?:\.\d+)?)/i);
    if (tm) trxId = tm[1].trim();
    if (am) amount = parseFloat(am[1].replace(/,/g, ""));
  } else if (/nagad/i.test(sender) || /nagad/i.test(text)) {
    method = "Nagad";
    const tm = text.match(/TxnID:\s*([A-Za-z0-9]+)/i) || text.match(/\b([A-Z0-9]{8,10})\b/);
    const am = text.match(/Tk\s+([\d,]+(?:\.\d+)?)/i);
    if (tm) trxId = tm[1].trim();
    if (am) amount = parseFloat(am[1].replace(/,/g, ""));
  } else if (/rocket|16216/i.test(sender) || /rocket/i.test(text)) {
    method = "Rocket";
    const tm = text.match(/TxnId:\s*([A-Za-z0-9]+)/i) || text.match(/Txn:\s*([A-Za-z0-9]+)/i);
    const am = text.match(/Tk\s*([\d,]+(?:\.\d+)?)/i);
    if (tm) trxId = tm[1].trim();
    if (am) amount = parseFloat(am[1].replace(/,/g, ""));
  }
  if (trxId && amount) return { method, trxId: trxId.toUpperCase(), amount };
  return null;
}
async function tgNotify(env, chatId, html) {
  try {
    const tok = env.BOT_TOKEN || "";
    if (!tok || !chatId) return;
    await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: String(chatId), text: html, parse_mode: "HTML" }),
    });
  } catch {}
}

/* ---------------- router ---------------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const db = env.DB;
    if (req.method === "OPTIONS") return new Response(null, { headers: cors() });
    if (path === "/" || path === "/v1/health") return J({ ok: true, service: "ppm-d1-api", time: nowISO() });

    try {
      /* ===== public (edge-cached 60s) ===== */
      if (req.method === "GET" && path === "/v1/config") {
        const cfg = await getCfg(db);
        return J({ ok: true, config: cfg }, 200, 60);
      }
      if (req.method === "GET" && path === "/v1/offers") {
        const rs = await db.prepare("SELECT * FROM offers WHERE active=1 ORDER BY ord LIMIT 60").all();
        return J({ ok: true, offers: (rs.results || []).map(mapOffer) }, 200, 60);
      }
      if (req.method === "GET" && path === "/v1/store") {
        const cfg = await getCfg(db);
        const rs = await db.prepare("SELECT * FROM store_items ORDER BY ord LIMIT 100").all();
        const list = (rs.results || []).filter((r) => r.active !== 0).map((r) => mapStore(r, num(cfg.pointRate, 0.6)));
        return J({ ok: true, items: list, pointRate: num(cfg.pointRate, 0.6) }, 200, 60);
      }

      /* ===== SMS gateway (Android app) ===== */
      if (path === "/v1/gateway/sms" && req.method === "POST") {
        const secret = req.headers.get("X-Gateway-Secret") || "";
        const want = env.GATEWAY_SECRET || "PPMOD_GATEWAY_SEC_2025";
        if (secret !== want) return E("Unauthorized Gateway App", 401);
        const b = await req.json().catch(() => ({}));
        if (!b.message) return E("No message");
        const parsed = parseSmsBody(b.sender || "", b.message);
        if (!parsed) return J({ ok: true, matched: false });
        const t = nowISO();
        await db.prepare("INSERT INTO gateway_sms(trx_id,sender,raw,method,amount,received_at) VALUES(?,?,?,?,?,?) ON CONFLICT(trx_id) DO UPDATE SET raw=excluded.raw, amount=excluded.amount")
          .bind(parsed.trxId, b.sender || "", b.message, parsed.method, parsed.amount, t).run();
        const cfg = await getCfg(db);
        if (cfg.autoDeposit === false) return J({ ok: true, matched: true, autoApproved: false });
        const dep = await db.prepare("SELECT * FROM deposits WHERE status='pending' AND trx_id=? LIMIT 1").bind(parsed.trxId).first();
        if (dep) {
          const smsMs = b.timestamp || Date.now();
          const depMs = dep.created_at ? Date.parse(dep.created_at) : Date.now();
          if (Math.abs(Date.now() - smsMs) > 300000 || Math.abs(Date.now() - depMs) > 300000) {
            await db.prepare("UPDATE deposits SET status='rejected', admin_msg=? WHERE id=?").bind("5 min time sesh!", dep.id).run();
            return E("EXPIRED");
          }
          if (num(dep.amount) === num(parsed.amount)) {
            const coins = await approveDeposit(db, dep.id, dep, parsed.amount, cfg.coinRate);
            const u = await db.prepare("SELECT tg_chat_id FROM users WHERE uid=?").bind(dep.uid).first();
            if (u && u.tg_chat_id) tgNotify(env, u.tg_chat_id, `Deposit approved! +${coins} Coins`);
            return J({ ok: true, matched: true, autoApproved: true });
          }
          await db.prepare("UPDATE deposits SET status='rejected', admin_msg=? WHERE id=?").bind("Takar poriman mileni!", dep.id).run();
        }
        return J({ ok: true, matched: true, autoApproved: false });
      }

      /* ===== auth required below ===== */
      const me = await needAuth(env, req);
      if (!me && !path.startsWith("/v1/admin/import")) return E("Login required", 401);

      if (path === "/v1/me" && req.method === "GET") {
        const r = await ensureUser(db, me);
        const u = rowUser(r);
        if (u.banned) return J({ ok: true, user: u, banned: true });
        return J({ ok: true, user: u });
      }
      if (path === "/v1/me" && (req.method === "PUT" || req.method === "POST")) {
        if (throttled(req)) return E("Too fast, ektu pore try korun", 429);
        const b = await req.json().catch(() => ({}));
        const r = await ensureUser(db, me);
        const patch = {};
        if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim().slice(0, 60);
        if (typeof b.avatar === "string") patch.avatar = b.avatar.slice(0, 500);
        if (typeof b.tgChatId === "string") patch.tg_chat_id = b.tgChatId.replace(/[^0-9]/g, "").slice(0, 20);
        if (Object.keys(patch).length) {
          patch.updated_at = nowISO();
          const sets = Object.keys(patch).map((k) => `${k}=?`).join(",");
          await db.prepare(`UPDATE users SET ${sets} WHERE uid=?`).bind(...Object.values(patch), me.uid).run();
        }
        const r2 = await db.prepare("SELECT * FROM users WHERE uid=?").bind(me.uid).first();
        return J({ ok: true, user: rowUser(r2) });
      }

      /* history: pending live + last 15 each, merged */
      if (path === "/v1/history" && req.method === "GET") {
        const lim = Math.min(40, Math.max(1, num(url.searchParams.get("limit"), 15)));
        const q = async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
        const [deps, ords, wds, sells, pends, led] = await Promise.all([
          q("SELECT * FROM deposits WHERE uid=? ORDER BY created_at DESC LIMIT ?", me.uid, lim),
          q("SELECT * FROM orders WHERE uid=? ORDER BY created_at DESC LIMIT ?", me.uid, lim),
          q("SELECT * FROM withdrawals WHERE uid=? ORDER BY created_at DESC LIMIT ?", me.uid, lim),
          q("SELECT * FROM point_sells WHERE uid=? ORDER BY created_at DESC LIMIT ?", me.uid, 15),
          q("SELECT * FROM pending_points WHERE uid=? ORDER BY unlock_at LIMIT 15", me.uid),
          q("SELECT * FROM ledger WHERE uid=? ORDER BY created_at DESC LIMIT ?", me.uid, lim),
        ]);
        const items = [
          ...deps.map((r) => ({ kind: "TOP-UP", ...mapDep(r) })),
          ...ords.map((r) => ({ kind: "TASK", ...mapOrd(r) })),
          ...wds.map((r) => ({ kind: "WITHDRAW", ...mapWd(r) })),
          ...sells.map((r) => ({ kind: "SELL", ...mapSell(r) })),
          ...pends.filter((r) => r.status === "live").map((r) => ({ kind: "PENDLIVE", ...mapPend(r) })),
          ...led.map((r) => ({ kind: r.kind === "EXCHANGE" ? "EXCHANGE" : "REDEEM", id: r.id, uid: r.uid, code: r.code, amount: num(r.amount), points: num(r.points_delta) * -1 || num(r.coins_delta) * 10, coins: num(r.coins_delta), note: r.note, status: r.status, createdAt: r.created_at })),
        ];
        items.sort((a, b) => String(b.createdAt || "") < String(a.createdAt || "") ? -1 : 1);
        return J({ ok: true, items: items.slice(0, 60) });
      }
      if (path === "/v1/pending" && req.method === "GET") {
        const rs = await db.prepare("SELECT * FROM pending_points WHERE uid=? AND status='pending' ORDER BY unlock_at LIMIT 15").bind(me.uid).all();
        return J({ ok: true, pending: (rs.results || []).map(mapPend) });
      }
      if (path === "/v1/withdrawals" && req.method === "GET") {
        const lim = Math.min(30, Math.max(1, num(url.searchParams.get("limit"), 15)));
        const rs = await db.prepare("SELECT * FROM withdrawals WHERE uid=? ORDER BY created_at DESC LIMIT ?").bind(me.uid, lim + 15).all();
        const all = (rs.results || []).map(mapWd);
        const pend = all.filter((w) => w.status === "pending").slice(0, 15);
        const done = all.filter((w) => w.status !== "pending").slice(0, lim);
        return J({ ok: true, withdrawals: pend.concat(done) });
      }

      /* ---- orders ---- */
      if (path === "/v1/orders" && req.method === "POST") {
        if (throttled(req)) return E("Too fast", 429);
        const cfg = await getCfg(db);
        if (cfg.serviceOff === true) return E(cfg.serviceMsg || "Service off");
        const b = await req.json().catch(() => ({}));
        const game = (b.game || "").toString().slice(0, 120);
        if (!game) return E("Game select korun");
        const fee = num(cfg.fee, 3);
        const u = await ensureUser(db, me);
        if (u.banned) return E("Banned", 403);
        if (num(u.balance) < fee) return E("Insufficient PP Coins");
        const t = nowISO();
        const id = nid();
        const exp = new Date(Date.now() + 10 * 86400000).toISOString();
        await db.batch([
          db.prepare("UPDATE users SET balance=balance-?, updated_at=? WHERE uid=?").bind(fee, t, me.uid),
          db.prepare("INSERT INTO orders(id,uid,name,email,game,logo,method,amount,trx_id,acc_email,acc_pass,user_tg,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(id, me.uid, u.name || me.name, me.email, game, (b.logo || "").slice(0, 500), "PP Coins", fee, "W" + Date.now().toString(36).toUpperCase(), "", "", (b.tg || "").slice(0, 40), "pending", t, exp),
        ]);
        return J({ ok: true, orderId: id });
      }
      if (path === "/v1/order/credentials" && req.method === "POST") {
        if (throttled(req)) return E("Too fast", 429);
        const b = await req.json().catch(() => ({}));
        const o = await db.prepare("SELECT * FROM orders WHERE id=?").bind(b.orderId || "").first();
        if (!o || o.uid !== me.uid) return E("Order paini", 404);
        if (!["pending", "paid"].includes(o.status)) return E("Already submitted");
        const em = (b.accEmail || "").trim(), ps = (b.accPass || "").trim();
        if (!em || !ps) return E("Gmail + Password din");
        await db.prepare("UPDATE orders SET acc_email=?, acc_pass=?, user_tg=? WHERE id=?").bind(em.slice(0, 120), ps.slice(0, 120), (b.tg || "").slice(0, 40), o.id).run();
        return J({ ok: true });
      }

      /* ---- deposits ---- */
      if (path === "/v1/deposits" && req.method === "POST") {
        if (throttled(req)) return E("Too fast", 429);
        const cfg = await getCfg(db);
        const b = await req.json().catch(() => ({}));
        const coins = Math.floor(num(b.coins));
        const amount = Math.floor(num(b.amount));
        if (!coins || coins < 3) return E("Minimum 3 Coins");
        const method = (b.method || "bKash").toString();
        const isStars = method === "Telegram Stars";
        let trx = (b.trxId || "").toString().trim();
        if (!trx) return E(isStars ? "Telegram Username likhun" : "TrxID din");
        trx = isStars ? (trx.startsWith("@") ? trx : "@" + trx) : trx.toUpperCase();
        if (!isStars) {
          const used = await db.prepare("SELECT trx_id FROM used_trx WHERE trx_id=?").bind(trx).first();
          if (used) return E("Ei TrxID age bebohar hoyeche!");
          const sms = await db.prepare("SELECT * FROM gateway_sms WHERE trx_id=?").bind(trx).first();
          if (!sms) {
            const id0 = nid(), t0 = nowISO();
            await db.prepare("INSERT INTO deposits(id,uid,name,email,method,amount,coins,trx_id,status,admin_msg,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
              .bind(id0, me.uid, me.name, me.email, method, amount, coins, trx, "rejected", "Ei TrxID diye kono taka aseni!", t0).run();
            return E("Kono payment pawa jayni! Sothik TrxID din.");
          }
          if (num(sms.amount) !== amount) {
            const id0 = nid(), t0 = nowISO();
            await db.prepare("INSERT INTO deposits(id,uid,name,email,method,amount,coins,trx_id,status,admin_msg,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
              .bind(id0, me.uid, me.name, me.email, method, amount, coins, trx, "rejected", "Takar poriman vul!", t0).run();
            return E("Takar poriman mileni! Asol payment chilo " + sms.amount + " BDT");
          }
          const smsMs = sms.received_at ? Date.parse(sms.received_at) : Date.now();
          if (Date.now() - smsMs > 300000) return E("5 min par hoye geche!");
        }
        const id = nid(), t = nowISO();
        await db.prepare("INSERT INTO deposits(id,uid,name,email,method,amount,coins,trx_id,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
          .bind(id, me.uid, me.name || "", me.email || "", method, amount, coins, trx, "pending", t).run();
        // instant auto-approve when SMS matched
        if (!isStars && cfg.autoDeposit !== false) {
          try {
            const dep = await db.prepare("SELECT * FROM deposits WHERE id=?").bind(id).first();
            const sms = await db.prepare("SELECT * FROM gateway_sms WHERE trx_id=?").bind(trx).first();
            const c = await approveDeposit(db, id, dep, sms.amount, cfg.coinRate);
            return J({ ok: true, autoApproved: true, coins: c });
          } catch (e) {
            if (String((e && e.message) || "").includes("TRX_ALREADY_USED")) return E("Ei TrxID age bebohar hoyeche!");
          }
        }
        return J({ ok: true, autoApproved: false });
      }

      /* ---- sells ---- */
      if (path === "/v1/sells" && req.method === "POST") {
        if (throttled(req)) return E("Too fast", 429);
        const b = await req.json().catch(() => ({}));
        const gmail = (b.gmail || "").trim(), pass = (b.password || "").trim();
        if (!gmail || !pass) return E("Gmail + Password din");
        const pts = Math.max(1, Math.floor(num(b.points, 100)));
        const id = nid(), t = nowISO();
        await db.prepare("INSERT INTO point_sells(id,uid,user_name,user_email,package_title,points,payout_amount,gmail,password,user_tg,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
          .bind(id, me.uid, me.name || "User", me.email || "", (b.packageTitle || pts + " Points").slice(0, 120), pts, Math.floor(num(b.price, 60)), gmail.slice(0, 120), pass.slice(0, 120), (b.tg || "None").slice(0, 60), "pending", t).run();
        return J({ ok: true, sellId: id });
      }

      /* ---- withdraw ---- */
      if (path === "/v1/withdraw" && req.method === "POST") {
        if (throttled(req)) return E("Too fast", 429);
        const cfg = await getCfg(db);
        const b = await req.json().catch(() => ({}));
        const pts = Math.floor(num(b.points));
        const min = num(cfg.withdrawMin, 50);
        const method = (b.method || "bKash").toString().slice(0, 30);
        const acc = (b.account || "").replace(/[^0-9]/g, "");
        if (acc.length < 10) return E("Sothik account number din");
        if (!pts || pts < min) return E("Minimum " + min + " Points");
        const rate = num(cfg.pointRate, 0.6);
        const u = await ensureUser(db, me);
        if (num(u.play_points) < pts) return E("Live balance kom ache");
        const id = nid(), t = nowISO();
        await db.batch([
          db.prepare("UPDATE users SET play_points=play_points-?, updated_at=? WHERE uid=?").bind(pts, t, me.uid),
          db.prepare("INSERT INTO withdrawals(id,uid,name,email,method,account,points,amount,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
            .bind(id, me.uid, me.name, me.email, method, acc, pts, Math.floor(pts * rate), "pending", t),
        ]);
        return J({ ok: true, withdrawId: id });
      }

      /* ---- exchange 10:1 ---- */
      if (path === "/v1/exchange" && req.method === "POST") {
        if (throttled(req)) return E("Too fast", 429);
        const b = await req.json().catch(() => ({}));
        const pts = Math.floor(num(b.points));
        if (!pts || pts < 10 || pts % 10 !== 0) return E("10-এর গুণিতক দিন");
        const coins = Math.floor(pts / 10);
        const u = await ensureUser(db, me);
        if (num(u.play_points) < pts) return E("Live balance kom ache");
        const t = nowISO(), id = nid();
        await db.batch([
          db.prepare("UPDATE users SET play_points=play_points-?, balance=balance+?, updated_at=? WHERE uid=?").bind(pts, coins, t, me.uid),
          db.prepare("INSERT INTO ledger(id,uid,name,email,kind,code,points_delta,coins_delta,note,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(id, me.uid, me.name, me.email, "EXCHANGE", "EXCHANGE", -pts, coins, pts + " Points → " + coins + " PP Coin", "approved", t, new Date(Date.now() + 10 * 86400000).toISOString()),
        ]);
        return J({ ok: true, coins });
      }

      /* ---- claim matured pending ---- */
      if (path === "/v1/claim" && req.method === "POST") {
        const now = nowISO();
        const rs = await db.prepare("SELECT * FROM pending_points WHERE uid=? AND status='pending' AND unlock_at<=? LIMIT 10").bind(me.uid, now).all();
        let total = 0;
        for (const m of rs.results || []) {
          const pts = num(m.points);
          if (!pts) continue;
          const t = nowISO();
          await db.batch([
            db.prepare("UPDATE pending_points SET status='live', moved_at=? WHERE id=? AND status='pending'").bind(t, m.id),
            db.prepare("UPDATE users SET play_points=play_points+?, pending_points=max(0,pending_points-?), updated_at=? WHERE uid=?").bind(pts, pts, t, me.uid),
          ]);
          total += pts;
        }
        return J({ ok: true, claimed: total });
      }

      /* ---- redeem ---- */
      if (path === "/v1/redeem" && req.method === "POST") {
        if (throttled(req)) return E("Too fast", 429);
        const b = await req.json().catch(() => ({}));
        const code = (b.code || "").toUpperCase().trim();
        if (!code) return E("Code likhun");
        const c = await db.prepare("SELECT * FROM codes WHERE code=?").bind(code).first();
        if (!c || !c.active || num(c.amount) <= 0) return E("Bhulo ba bondho code");
        if (num(c.max_uses) > 0 && num(c.used) >= num(c.max_uses)) return E("Limit sesh");
        const dup = await db.prepare("SELECT id FROM ledger WHERE uid=? AND code=? AND kind='REDEEM' LIMIT 1").bind(me.uid, code).first();
        if (dup && num(c.max_uses) <= 1) { /* single-use per user guard when maxUses small */ }
        const t = nowISO(), id = nid();
        await db.batch([
          db.prepare("UPDATE codes SET used=used+1 WHERE code=?").bind(code),
          db.prepare("UPDATE users SET balance=balance+?, updated_at=? WHERE uid=?").bind(num(c.amount), t, me.uid),
          db.prepare("INSERT INTO ledger(id,uid,name,email,kind,code,points_delta,coins_delta,note,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(id, me.uid, me.name, me.email, "REDEEM", code, 0, num(c.amount), c.note || "", "approved", t, new Date(Date.now() + 10 * 86400000).toISOString()),
        ]);
        const u2 = await db.prepare("SELECT balance FROM users WHERE uid=?").bind(me.uid).first();
        return J({ ok: true, amount: num(c.amount), note: c.note || "", balance: num(u2 && u2.balance) });
      }

      /* ---- card-gen unlock ---- */
      if (path === "/v1/gen-unlock" && req.method === "POST") {
        const cfg = await getCfg(db);
        const price = Math.max(0, Math.floor(num(cfg.genPrice)));
        const days = Math.max(1, Math.floor(num(cfg.genDays, 7)));
        if (!price) return E("Price set hoyni");
        const u = await ensureUser(db, me);
        if (num(u.balance) < price) return E("Insufficient Coins");
        if (num(u.gen_until) > Date.now()) return E("Premium agei chalu ache");
        const base = Math.max(Date.now(), num(u.gen_until));
        const t = nowISO(), id = nid();
        await db.batch([
          db.prepare("UPDATE users SET balance=balance-?, gen_until=?, updated_at=? WHERE uid=?").bind(price, base + days * 86400000, t, me.uid),
          db.prepare("INSERT INTO ledger(id,uid,name,email,kind,code,points_delta,coins_delta,note,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(id, me.uid, me.name, me.email, "GEN", "GEN-UNLOCK", 0, -price, "CardGen Premium " + days + " days", "approved", t, new Date(Date.now() + 10 * 86400000).toISOString()),
        ]);
        return J({ ok: true, days });
      }

      /* ===== admin ===== */
      if (path.startsWith("/v1/admin")) {
        if (!isAdmin(env, me)) return E("Admin only", 403);
        const seg = path.slice("/v1/admin".length) || "/";
        const q = async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];

        if (seg === "/overview" && req.method === "GET") {
          const c = async (t, w = "") => (await db.prepare(`SELECT COUNT(*) c FROM ${t} ${w}`).first()).c;
          return J({
            ok: true,
            pendingDeposits: await c("deposits", "WHERE status='pending'"),
            pendingOrders: await c("orders", "WHERE status='pending'"),
            pendingSells: await c("point_sells", "WHERE status='pending'"),
            pendingWithdrawals: await c("withdrawals", "WHERE status='pending'"),
            totalUsers: await c("users"),
            liveOffers: await c("offers", "WHERE active=1"),
          });
        }
        if (seg === "/config" && req.method === "GET") return J({ ok: true, config: await getCfg(db) });
        if (seg === "/config" && (req.method === "PUT" || req.method === "POST")) {
          const b = await req.json().catch(() => ({}));
          await setCfg(db, b);
          return J({ ok: true });
        }
        const listQ = async (tbl, status) => {
          const st = (status || "pending").toString();
          if (st === "all") return q(`SELECT * FROM ${tbl} ORDER BY created_at DESC LIMIT 200`);
          return q(`SELECT * FROM ${tbl} WHERE status=? ORDER BY created_at DESC LIMIT 200`, st);
        };
        if (seg === "/deposits" && req.method === "GET") {
          const rows = await listQ("deposits", url.searchParams.get("status"));
          return J({ ok: true, deposits: rows.map(mapDep) });
        }
        if (seg === "/orders" && req.method === "GET") {
          const rows = await listQ("orders", url.searchParams.get("status"));
          return J({ ok: true, orders: rows.map(mapOrd) });
        }
        if (seg === "/sells" && req.method === "GET") {
          const rows = await listQ("point_sells", url.searchParams.get("status"));
          return J({ ok: true, sells: rows.map(mapSell) });
        }
        if (seg === "/withdrawals" && req.method === "GET") {
          const rows = await listQ("withdrawals", url.searchParams.get("status"));
          return J({ ok: true, withdrawals: rows.map(mapWd) });
        }
        if (seg === "/pending" && req.method === "GET") {
          const rows = await q("SELECT * FROM pending_points WHERE status='pending' ORDER BY unlock_at LIMIT 200");
          return J({ ok: true, pending: rows.map(mapPend) });
        }
        if (seg === "/users" && req.method === "GET") {
          const s = (url.searchParams.get("q") || "").trim();
          const rows = s
            ? await q("SELECT * FROM users WHERE email LIKE ? OR name LIKE ? OR uid=? LIMIT 50", `%${s}%`, `%${s}%`, s)
            : await q("SELECT * FROM users ORDER BY created_at DESC LIMIT 100");
          return J({ ok: true, users: rows.map(rowUser) });
        }
        if (seg === "/archive" && req.method === "GET") {
          const src = url.searchParams.get("src") || "all";
          const rows = src === "all"
            ? await q("SELECT * FROM tx_archive ORDER BY archived_at DESC LIMIT 50")
            : await q("SELECT * FROM tx_archive WHERE src=? ORDER BY archived_at DESC LIMIT 50", src);
          return J({ ok: true, archive: rows });
        }
        const mAct = seg.match(/^\/(deposits|orders|sells|withdrawals)\/([^/]+)\/(approve|reject|complete|refund|paid)$/);
        if (mAct && req.method === "POST") {
          const [, kind, id, act] = mAct;
          const t = nowISO();
          const tbl = kind === "sells" ? "point_sells" : kind;
          const row = await db.prepare(`SELECT * FROM ${tbl} WHERE id=?`).bind(id).first();
          if (!row) return E("Not found", 404);
          if (kind === "deposits") {
            if (act === "approve") {
              const cfg = await getCfg(db);
              try {
                const coins = await approveDeposit(db, id, row, row.amount, cfg.coinRate);
                return J({ ok: true, coins });
              } catch (e) { return E(String((e && e.message) || "Failed")); }
            }
            await db.prepare("UPDATE deposits SET status='rejected', admin_msg=? WHERE id=?").bind("Admin rejected", id).run();
            return J({ ok: true });
          }
          if (kind === "orders") {
            if (act === "complete") {
              await db.prepare("UPDATE orders SET status='completed', completed_at=? WHERE id=?").bind(t, id).run();
              try { await creditReferral(db, row.uid, id, row.game); } catch {}
              return J({ ok: true });
            }
            if (act === "refund") {
              await db.batch([
                db.prepare("UPDATE users SET balance=balance+? WHERE uid=?").bind(num(row.amount), row.uid),
                db.prepare("UPDATE orders SET status='refunded' WHERE id=?").bind(id),
              ]);
              return J({ ok: true });
            }
            const b = await req.json().catch(() => ({}));
            await db.prepare("UPDATE orders SET status=?, admin_msg=? WHERE id=?").bind(act === "paid" ? "paid" : "rejected", (b.msg || "").slice(0, 300), id).run();
            return J({ ok: true });
          }
          if (kind === "sells") {
            if (act === "approve") {
              const cfg = await getCfg(db);
              const days = Math.max(0, num(cfg.pendingDays, 3));
              const pts = num(row.points);
              const unlock = new Date(Date.now() + days * 86400000).toISOString();
              const pid = nid();
              await db.batch([
                db.prepare("INSERT INTO pending_points(id,uid,user_name,user_email,points,package_title,sell_id,status,pending_days,created_at,unlock_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
                  .bind(pid, row.uid, row.user_name, row.user_email, pts, row.package_title, id, "pending", days, t, unlock),
                db.prepare("UPDATE users SET pending_points=pending_points+?, updated_at=? WHERE uid=?").bind(pts, t, row.uid),
                db.prepare("UPDATE point_sells SET status='completed', credited_points=?, pending_days=?, approved_at=? WHERE id=?").bind(pts, days, t, id),
              ]);
              return J({ ok: true, pendingDays: days });
            }
            await db.prepare("UPDATE point_sells SET status='rejected' WHERE id=?").bind(id).run();
            return J({ ok: true });
          }
          if (kind === "withdrawals") {
            if (act === "approve") {
              await db.prepare("UPDATE withdrawals SET status='approved', approved_at=? WHERE id=?").bind(t, id).run();
              return J({ ok: true });
            }
            await db.batch([
              db.prepare("UPDATE users SET play_points=play_points+?, updated_at=? WHERE uid=?").bind(num(row.points), t, row.uid),
              db.prepare("UPDATE withdrawals SET status='rejected' WHERE id=?").bind(id),
            ]);
            return J({ ok: true, refunded: true });
          }
        }
        if (seg === "/deposit/manual" && req.method === "POST") {
          const b = await req.json().catch(() => ({}));
          const cfg = await getCfg(db);
          const coins = Math.floor(num(b.coins)) || Math.floor(num(b.amount) / num(cfg.coinRate, 7)) || 3;
          const trx = ((b.trxId || "MANUAL-" + Date.now().toString(36).toUpperCase())).toUpperCase();
          const used = await db.prepare("SELECT trx_id FROM used_trx WHERE trx_id=?").bind(trx).first();
          if (used) return E("TrxID used!");
          const id = nid(), t = nowISO();
          const u = b.uid ? await db.prepare("SELECT * FROM users WHERE uid=?").bind(b.uid).first() : null;
          const stmts = [
            db.prepare("INSERT INTO deposits(id,uid,name,email,method,amount,coins,trx_id,status,auto_approved,approved_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
              .bind(id, b.uid || "", "", "", b.method || "bKash", num(b.amount), coins, trx, "approved", 0, t, t),
            db.prepare("INSERT INTO used_trx(trx_id,uid,amount,dep_id,used_at) VALUES(?,?,?,?,?)").bind(trx, b.uid || "", num(b.amount), id, t),
          ];
          if (u) stmts.push(db.prepare("UPDATE users SET balance=balance+?, updated_at=? WHERE uid=?").bind(coins, t, b.uid));
          await db.batch(stmts);
          return J({ ok: true, coins });
        }
        if (seg.startsWith("/users/") && req.method === "POST") {
          const parts = seg.split("/");
          const uid = parts[2] || "", fn = parts[3] || "";
          const b = await req.json().catch(() => ({}));
          const t = nowISO();
          if (fn === "balance") {
            const sets = [];
            if (b.balance !== undefined) sets.push(["balance", Math.max(0, Math.floor(num(b.balance)))]);
            if (b.playPoints !== undefined) sets.push(["play_points", Math.max(0, Math.floor(num(b.playPoints)))]);
            if (b.pendingPoints !== undefined) sets.push(["pending_points", Math.max(0, Math.floor(num(b.pendingPoints)))]);
            if (!sets.length) return E("Nothing to set");
            await db.prepare(`UPDATE users SET ${sets.map((s) => s[0] + "=?").join(",")}, updated_at=? WHERE uid=?`).bind(...sets.map((s) => s[1]), t, uid).run();
            return J({ ok: true });
          }
          if (fn === "ban") {
            await db.prepare("UPDATE users SET banned=?, updated_at=? WHERE uid=?").bind(b.ban ? 1 : 0, t, uid).run();
            return J({ ok: true });
          }
          return E("Unknown", 404);
        }
        const crud = seg.match(/^\/(offers|store|store_items|codes)$/);
        if (crud && req.method === "GET") {
          const k = crud[1];
          if (k === "offers") return J({ ok: true, offers: (await q("SELECT * FROM offers ORDER BY ord LIMIT 200")).map(mapOffer) });
          const cfg = await getCfg(db);
          return J({ ok: true, items: (await q("SELECT * FROM store_items ORDER BY ord LIMIT 200")).map((r) => mapStore(r, num(cfg.pointRate, 0.6))) });
        }
        if (crud && req.method === "POST") {
          const k = crud[1], b = await req.json().catch(() => ({}));
          const t = nowISO(), id = nid();
          if (k === "offers") {
            await db.prepare("INSERT INTO offers(id,name,logo,points,banner,active,ord,created_at) VALUES(?,?,?,?,?,?,?,?)")
              .bind(id, (b.name || "").slice(0, 120), (b.logo || "").slice(0, 500), String(b.points ?? 50).slice(0, 10), (b.banner || "").slice(0, 500), 1, Math.floor(num(b.order)), t).run();
            return J({ ok: true, id });
          }
          if (k === "store" || k === "store_items") {
            const cfg = await getCfg(db);
            const pts = Math.floor(num(b.points, 100));
            await db.prepare("INSERT INTO store_items(id,title,points,price,rate_used,tag,ord,in_stock,active,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
              .bind(id, (b.title || pts + " Points").slice(0, 120), pts, Math.round(pts * num(cfg.pointRate, 0.6)), num(cfg.pointRate, 0.6), (b.tag || "").slice(0, 60), Math.floor(num(b.order, 1)), 1, 1, t).run();
            return J({ ok: true, id });
          }
          await db.prepare("INSERT INTO codes(code,amount,max_uses,active,note,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET amount=excluded.amount, max_uses=excluded.max_uses, active=excluded.active, note=excluded.note")
            .bind((b.code || "").toUpperCase().slice(0, 40), Math.floor(num(b.amount)), Math.floor(num(b.maxUses)), 1, (b.note || "").slice(0, 200), t).run();
          return J({ ok: true });
        }
        const cmod = seg.match(/^\/(offers|store|store_items|codes)\/([^/]+)$/);
        if (cmod && (req.method === "PUT" || req.method === "DELETE")) {
          const k = cmod[1], id = decodeURIComponent(cmod[2]);
          const b = req.method === "PUT" ? await req.json().catch(() => ({})) : {};
          if (req.method === "DELETE") {
            const tbl = k === "offers" ? "offers" : k === "codes" ? "codes" : "store_items";
            await db.prepare(`DELETE FROM ${tbl} WHERE ${k === "codes" ? "code" : "id"}=?`).bind(id).run();
            return J({ ok: true });
          }
          if (k === "offers") {
            await db.prepare("UPDATE offers SET name=?, logo=?, points=?, banner=?, ord=? WHERE id=?")
              .bind((b.name || "").slice(0, 120), (b.logo || "").slice(0, 500), String(b.points ?? 50).slice(0, 10), (b.banner || "").slice(0, 500), Math.floor(num(b.order)), id).run();
            return J({ ok: true });
          }
          if (k === "codes") {
            await db.prepare("UPDATE codes SET amount=?, max_uses=?, active=?, note=? WHERE code=?")
              .bind(Math.floor(num(b.amount)), Math.floor(num(b.maxUses)), b.active === false ? 0 : 1, (b.note || "").slice(0, 200), id).run();
            return J({ ok: true });
          }
          const cfg = await getCfg(db);
          const pts = Math.floor(num(b.points, 100));
          await db.prepare("UPDATE store_items SET title=?, points=?, price=?, rate_used=?, tag=?, ord=?, in_stock=?, active=? WHERE id=?")
            .bind((b.title || "").slice(0, 120), pts, Math.round(pts * num(cfg.pointRate, 0.6)), num(cfg.pointRate, 0.6), (b.tag || "").slice(0, 60), Math.floor(num(b.order, 1)), b.inStock === false ? 0 : 1, b.active === false ? 0 : 1, id).run();
          return J({ ok: true });
        }
        /* bulk import (migration): header X-Import-Key */
        if (seg === "/import" && req.method === "POST") {
          if ((req.headers.get("X-Import-Key") || "") !== (env.ADMIN_IMPORT_KEY || "")) return E("Bad import key", 403);
          const b = await req.json().catch(() => ({}));
          const table = (b.table || "").toString();
          const rows = Array.isArray(b.rows) ? b.rows.slice(0, 200) : [];
          const allow = ["config", "users", "offers", "store_items", "codes", "deposits", "orders", "point_sells", "pending_points", "withdrawals", "ledger", "used_trx"];
          if (!allow.includes(table) || !rows.length) return E("Bad import");
          const stmts = [];
          for (const r of rows) {
            const ks = Object.keys(r);
            stmts.push(db.prepare(`INSERT INTO ${table}(${ks.join(",")}) VALUES(${ks.map(() => "?").join(",")}) ON CONFLICT(${table === "codes" ? "code" : table === "config" ? "key" : table === "used_trx" || table === "gateway_sms" ? "trx_id" : "id"}) DO UPDATE SET ${ks.filter((k) => k !== "id" && k !== "code" && k !== "key" && k !== "trx_id").map((k) => `${k}=excluded.${k}`).join(",") || "uid=excluded.uid"}`).bind(...ks.map((k) => r[k])));
          }
          await db.batch(stmts);
          return J({ ok: true, imported: rows.length });
        }
        return E("Unknown admin route", 404);
      }

      return E("Not found", 404);
    } catch (e) {
      return E("Server error: " + String((e && e.message) || e), 500);
    }
  },

  /* scheduled: mature pending (every 5m) + archive (every 15m) + retention */
  async scheduled(ev, env) {
    const db = env.DB;
    try {
      const now = nowISO();
      const mat = await db.prepare("SELECT * FROM pending_points WHERE status='pending' AND unlock_at<=? LIMIT 100").bind(now).all();
      for (const m of mat.results || []) {
        const pts = num(m.points);
        if (!pts) continue;
        const t = nowISO();
        try {
          await db.batch([
            db.prepare("UPDATE pending_points SET status='live', moved_at=? WHERE id=? AND status='pending'").bind(t, m.id),
            db.prepare("UPDATE users SET play_points=play_points+?, pending_points=max(0,pending_points-?), updated_at=? WHERE uid=?").bind(pts, pts, t, m.uid),
          ]);
          const u = await db.prepare("SELECT tg_chat_id FROM users WHERE uid=?").bind(m.uid).first();
          if (u && u.tg_chat_id) tgNotify(env, u.tg_chat_id, `${pts} Points Live হয়েছে! Ekhon withdraw korte parben.`);
        } catch {}
      }
    } catch {}
    try {
      const st = await db.prepare("SELECT value FROM state WHERE key='arch_at'").bind().first();
      const last = st ? num(st.value) : 0;
      if (Date.now() - last > 14 * 60 * 1000) {
        const cur = await db.prepare("SELECT value FROM state WHERE key='arch_cur'").bind().first();
        const cursors = cur ? JSON.parse(cur.value || "{}") : {};
        const cols = ["deposits", "orders", "withdrawals", "point_sells", "pending_points", "ledger"];
        for (const src of cols) {
          try {
            const since = cursors[src] || new Date(Date.now() - 15 * 86400000).toISOString();
            const rs = await db.prepare(`SELECT * FROM ${src === "ledger" ? "ledger" : src} WHERE created_at>=? ORDER BY created_at LIMIT 200`).bind(since).all();
            if ((rs.results || []).length) {
              const stmts = [];
              let mx = since;
              for (const v of rs.results) {
                if ((v.created_at || "") > mx) mx = v.created_at;
                const id = src + "_" + (v.id || v.code);
                const title = src === "deposits" ? (v.method + " Deposit") : src === "orders" ? (v.game || "Task")
                  : src === "withdrawals" ? (v.points + " Pts -> " + v.amount + " BDT")
                  : src === "point_sells" ? (v.package_title || "") : src === "pending_points" ? ("+" + v.points + " Pts") : (v.code || v.kind || "");
                stmts.push(db.prepare("INSERT INTO tx_archive(id,src,src_id,uid,title,sub,amount,points,status,created_at,archived_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
                  .bind(id, src, v.id || v.code || "", v.uid || "", String(title).slice(0, 120), String(v.name || v.email || "").slice(0, 160), num(v.amount), num(v.points), (v.status || "").slice(0, 20), v.created_at || nowISO(), nowISO()));
              }
              await db.batch(stmts);
              cursors[src] = mx;
            } else {
              cursors[src] = nowISO();
            }
          } catch {}
        }
        await db.prepare("INSERT INTO state(key,value) VALUES('arch_cur',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(cursors)).run();
        await db.prepare("INSERT INTO state(key,value) VALUES('arch_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(Date.now())).run();
        try {
          const old = await db.prepare("SELECT id FROM tx_archive WHERE archived_at<? LIMIT 50").bind(new Date(Date.now() - 15 * 86400000).toISOString()).all();
          if ((old.results || []).length) {
            await db.batch((old.results || []).map((r) => db.prepare("DELETE FROM tx_archive WHERE id=?").bind(r.id)));
          }
        } catch {}
      }
    } catch {}
  },
};

/* referral bonus on task complete (server-side, double-pay guarded by orders.ref_paid) */
async function creditReferral(db, buyerUid, orderId, game) {
  try {
    const o = await db.prepare("SELECT * FROM orders WHERE id=?").bind(orderId).first();
    if (!o || o.ref_paid) return;
    await db.prepare("UPDATE orders SET ref_paid=1 WHERE id=?").bind(orderId).run();
    const b = await db.prepare("SELECT referred_by FROM users WHERE uid=?").bind(o.uid || buyerUid).first();
    const owner = b && (b.referred_by || "").trim();
    if (!owner || owner === (o.uid || buyerUid)) return;
    const t = nowISO(), id = nid();
    await db.batch([
      db.prepare("UPDATE users SET balance=balance+1, ref_earned=ref_earned+1 WHERE uid=?").bind(owner),
      db.prepare("INSERT INTO ledger(id,uid,kind,code,points_delta,coins_delta,note,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .bind(id, owner, "REFERRAL", "REFERRAL", 0, 1, "Referral bonus" + (game ? " (" + game + ")" : ""), "approved", t, new Date(Date.now() + 10 * 86400000).toISOString()),
    ]);
  } catch {}
}
