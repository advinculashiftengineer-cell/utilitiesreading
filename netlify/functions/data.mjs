// Aurelia Utility Tracker - storage API (Netlify Function + Netlify Blobs)
//
//   GET  /api/data                -> { readings: [...], budgets: {...} }
//   POST /api/data {op:"login"}   -> { token }
//   POST /api/data {op:"add" | "delete" | "budget" | "import", ...}
//
// Every request except "login" needs:  Authorization: Bearer <token>
// The password lives ONLY in the APP_PASSWORD environment variable on Netlify.

import { getStore } from "@netlify/blobs";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const UTILS = new Set(["elec", "water", "lpg"]);
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_MONTH = /^\d{4}-\d{2}$/;
const RE_ID = /^[A-Za-z0-9_-]{1,48}$/;
const MAX_BODY = 1_000_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = () => getStore({ name: "aurelia", consistency: "strong" });
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Aurelia": "1" },
  });

// ---------- auth ----------
const secret = () => globalThis.Netlify?.env?.get("APP_PASSWORD") ?? process.env.APP_PASSWORD ?? "";
const sha = (x) => createHash("sha256").update(String(x)).digest();
const safeEq = (a, b) => timingSafeEqual(sha(a), sha(b));
const hmacKey = () => sha("aurelia-token-key:" + secret());
const sign = (p) => createHmac("sha256", hmacKey()).update(p).digest("base64url");

function makeToken(days) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + days * 864e5 })).toString("base64url");
  return payload + "." + sign(payload);
}
function authed(req) {
  const h = req.headers.get("authorization") || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  const [p, s] = t.split(".");
  if (!p || !s || !secret() || !safeEq(s, sign(p))) return false;
  try {
    return JSON.parse(Buffer.from(p, "base64url").toString()).exp > Date.now();
  } catch {
    return false;
  }
}

// ---------- validation ----------
const num = (x, max) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x < max;
function cleanReading(x) {
  if (!x || typeof x !== "object") return null;
  const { id, d, u, c, r } = x;
  if (!RE_ID.test(String(id)) || !RE_DATE.test(String(d)) || !UTILS.has(u) || !num(c, 1e9) || !num(r, 1e9)) return null;
  return { id: String(id), d, u, c, r };
}

// ---------- storage helpers (optimistic concurrency with ETags) ----------
async function mutate(s, key, fn, empty) {
  for (let i = 0; i < 6; i++) {
    const cur = await s.getWithMetadata(key, { type: "json" });
    const next = fn(cur ? cur.data : structuredClone(empty));
    const res = cur
      ? await s.set(key, JSON.stringify(next), { onlyIfMatch: cur.etag })
      : await s.set(key, JSON.stringify(next), { onlyIfNew: true });
    if (res.modified) return next;
    await sleep(40 * (i + 1) + Math.random() * 60);
  }
  throw new Error("conflict");
}

async function readAll(s) {
  const { blobs } = await s.list({ prefix: "readings/" });
  const parts = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })));
  const readings = parts.flat().filter(Boolean);
  const budgets = (await s.get("budgets", { type: "json" })) ?? {};
  return { readings, budgets };
}

const setBudget = (o, m, u, v) => {
  if (v == null || !(v > 0)) {
    if (o[m]) {
      delete o[m][u];
      if (!Object.keys(o[m]).length) delete o[m];
    }
  } else (o[m] ||= {})[u] = v;
  return o;
};

// ---------- handler ----------
export default async (req) => {
  if (!secret()) return json({ error: "APP_PASSWORD is not set on the server" }, 500);

  if (req.method === "GET") {
    if (!authed(req)) return json({ error: "unauthorized" }, 401);
    return json(await readAll(store()));
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const text = await req.text();
  if (text.length > MAX_BODY) return json({ error: "too large" }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "bad json" }, 400);
  }

  if (body.op === "login") {
    if (typeof body.password !== "string" || !safeEq(body.password, secret())) {
      await sleep(700); // slows down password guessing
      return json({ error: "unauthorized" }, 401);
    }
    return json({ token: makeToken(body.remember ? 30 : 1) });
  }

  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  const s = store();

  try {
    if (body.op === "add") {
      const x = cleanReading(body.reading);
      if (!x) return json({ error: "invalid reading" }, 400);
      await mutate(s, "readings/" + x.d.slice(0, 7), (a) => a.filter((y) => y.id !== x.id).concat(x), []);
      return json({ ok: true });
    }
    if (body.op === "delete") {
      if (!RE_ID.test(String(body.id)) || !RE_DATE.test(String(body.d))) return json({ error: "invalid" }, 400);
      await mutate(s, "readings/" + body.d.slice(0, 7), (a) => a.filter((y) => y.id !== body.id), []);
      return json({ ok: true });
    }
    if (body.op === "budget") {
      const { m, u, v } = body;
      if (!RE_MONTH.test(String(m)) || !UTILS.has(u) || !(v === null || num(v, 1e12))) return json({ error: "invalid budget" }, 400);
      await mutate(s, "budgets", (o) => setBudget(o, m, u, v), {});
      return json({ ok: true });
    }
    if (body.op === "import") {
      const list = Array.isArray(body.readings) ? body.readings.slice(0, 5000).map(cleanReading).filter(Boolean) : [];
      const byMonth = {};
      for (const x of list) (byMonth[x.d.slice(0, 7)] ||= []).push(x);
      for (const [m, items] of Object.entries(byMonth)) {
        const ids = new Set(items.map((y) => y.id));
        await mutate(s, "readings/" + m, (a) => a.filter((y) => !ids.has(y.id)).concat(items), []);
      }
      const b = body.budgets && typeof body.budgets === "object" ? body.budgets : {};
      const entries = [];
      for (const [m, o] of Object.entries(b))
        if (RE_MONTH.test(m) && o && typeof o === "object")
          for (const [u, v] of Object.entries(o)) if (UTILS.has(u) && num(v, 1e12) && v > 0) entries.push([m, u, v]);
      if (entries.length) await mutate(s, "budgets", (o) => entries.reduce((acc, [m, u, v]) => setBudget(acc, m, u, v), o), {});
      return json({ ok: true, readings: list.length, budgets: entries.length });
    }
  } catch (e) {
    return json({ error: e.message === "conflict" ? "busy, try again" : "storage error" }, e.message === "conflict" ? 409 : 500);
  }
  return json({ error: "unknown op" }, 400);
};

export const config = { path: "/api/data" };
