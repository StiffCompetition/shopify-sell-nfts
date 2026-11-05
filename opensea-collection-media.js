// OpenSea collection page banner (hero) uploader (added 4 Nov 2026, Marketing task 239).
// POST /opensea/collection-hero, header X-Sign-Secret = OPENSEA_SIGN_SECRET (same guard as /opensea/list).
// Body: { slug: "stiff-competition-1994", desktopUrl: "<mp4>", mobileUrl: "<mp4>", dryRun?: true }
// Sources must be raw.githubusercontent.com links in the StiffCompetition GitHub account.
// Flow (OpenSea docs, read 4 Nov 2026): the admin wallet signs in to OpenSea (SIWE) through the SDK's OpenSeaAuth
// with only the write:collections scope, uploads each MP4 to the hero_desktop / hero_mobile placement, sets
// hero.desktop_hero_media / hero.mobile_hero_media with PATCH /api/v2/collections/{slug}/metadata, reads it back,
// then revokes the short-lived token. The admin key never leaves this service. Nothing here touches the shop,
// claims, minting or listing. If this module fails to load, only this route is missing.
const crypto = require("crypto");

const API = "https://api.opensea.io";
const MAX_BYTES = 50 * 1024 * 1024;

function secretOk(given) {
  const expected = String(process.env.OPENSEA_SIGN_SECRET || "");
  try {
    const a = Buffer.from(String(given || ""), "utf8"), b = Buffer.from(expected, "utf8");
    return expected.length >= 24 && a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

function sourceOk(u) {
  try {
    const x = new URL(String(u || ""));
    return x.protocol === "https:" && x.hostname === "raw.githubusercontent.com" && x.pathname.startsWith("/StiffCompetition/") && x.pathname.toLowerCase().endsWith(".mp4");
  } catch (e) { return false; }
}

async function readOpenSeaError(r) {
  const t = await r.text().catch(() => "");
  return (r.status + " " + t).slice(0, 300);
}

module.exports = function mountOpenSeaCollectionMedia(app, express) {
  app.post("/opensea/collection-hero", express.json({ limit: "20kb" }), async (req, res) => {
    if (!secretOk(req.get("X-Sign-Secret"))) return res.status(403).json({ success: false, error: "Not allowed" });
    const b = req.body || {};
    const slug = String(b.slug || "");
    if (!/^[a-z0-9-]{1,50}$/.test(slug)) return res.status(400).json({ success: false, error: "slug must be lowercase letters, numbers and hyphens" });
    const items = [["hero_desktop", "desktop_hero_media", b.desktopUrl], ["hero_mobile", "mobile_hero_media", b.mobileUrl]].filter(i => i[2]);
    if (!items.length) return res.status(400).json({ success: false, error: "desktopUrl or mobileUrl is required" });
    if (items.some(i => !sourceOk(i[2]))) return res.status(400).json({ success: false, error: "Sources must be StiffCompetition raw.githubusercontent.com .mp4 links" });

    let auth, token;
    const steps = [];
    try {
      // 1. Download the banner files first, so a bad file stops before any sign-in.
      const files = [];
      for (const [placement, field, url] of items) {
        const r = await fetch(url);
        if (!r.ok) return res.status(400).json({ success: false, error: `Could not download ${placement}: ${r.status}` });
        const buf = Buffer.from(await r.arrayBuffer());
        if (!buf.length || buf.length > MAX_BYTES) return res.status(400).json({ success: false, error: `${placement} must be 1 byte to 50 MB` });
        if (buf.slice(4, 8).toString("latin1") !== "ftyp") return res.status(400).json({ success: false, error: `${placement} is not an MP4 file` });
        files.push({ placement, field, buf });
        steps.push({ step: "download", placement, bytes: buf.length });
      }

      const { ethers } = require("ethers6");
      const { OpenSeaAPI, OpenSeaAuth } = require("@opensea/sdk");
      if (typeof OpenSeaAuth !== "function") return res.status(500).json({ success: false, error: "Installed OpenSea SDK has no OpenSeaAuth" });
      const wallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY);
      if (b.dryRun !== false) return res.json({ success: true, dryRun: true, wallet: wallet.address, slug, steps });

      let apiKey = String(process.env.OPENSEA_API_KEY || "");
      if (apiKey.length < 16) {
        const k = await OpenSeaAPI.requestInstantApiKey();
        apiKey = String(k && k.apiKey || "");
      }
      if (apiKey.length < 16) return res.status(500).json({ success: false, error: "No OpenSea API key available" });

      // 2. Wallet sign-in with only the scope this route needs.
      auth = new OpenSeaAuth();
      token = await auth.authenticate(wallet, { scopes: ["write:collections"] });
      steps.push({ step: "sign-in", ok: true });
      const headers = { "X-API-KEY": apiKey, Authorization: `Bearer ${token.accessToken}`, Accept: "application/json" };

      // 3. Upload each file to its placement and keep the returned token.
      const hero = {};
      for (const f of files) {
        const ctxRes = await fetch(`${API}/api/v2/collections/${slug}/media/${f.placement}?content_type=video%2Fmp4`, { method: "POST", headers });
        if (!ctxRes.ok) return res.status(502).json({ success: false, error: `Upload context ${f.placement}: ${await readOpenSeaError(ctxRes)}`, steps });
        const ctx = await ctxRes.json();
        let up;
        if (String(ctx.method).toUpperCase() === "PUT") {
          up = await fetch(ctx.url, { method: "PUT", body: f.buf });
        } else {
          const form = new FormData();
          for (const [k, v] of Object.entries(ctx.fields || {})) form.append(k, v);
          form.append("file", new Blob([f.buf], { type: "video/mp4" }), `${f.placement}.mp4`);
          up = await fetch(ctx.url, { method: "POST", body: form });
        }
        if (!(up.status >= 200 && up.status < 300)) return res.status(502).json({ success: false, error: `Storage upload ${f.placement}: ${up.status}`, steps });
        hero[f.field] = { video: { token: ctx.token } };
        steps.push({ step: "upload", placement: f.placement, status: up.status });
      }

      // 4. Set the hero on the collection page (other page fields are left as they are).
      const patch = await fetch(`${API}/api/v2/collections/${slug}/metadata`, {
        method: "PATCH", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ hero }),
      });
      if (!patch.ok) return res.status(502).json({ success: false, error: `Metadata update: ${await readOpenSeaError(patch)}`, steps });
      steps.push({ step: "metadata", status: patch.status });

      // 5. Read it back.
      const get = await fetch(`${API}/api/v2/collections/${slug}/metadata`, { headers: { "X-API-KEY": apiKey, Accept: "application/json" } });
      const meta = get.ok ? await get.json() : {};
      res.json({ success: true, slug, steps, hero: meta && meta.hero ? meta.hero : null, readBackStatus: get.status });
    } catch (e) {
      res.status(500).json({ success: false, error: String(e && e.message || e).slice(0, 400), steps });
    } finally {
      // 6. Revoke the short-lived scoped token whatever happened.
      if (auth && token) { try { await auth.revoke(token.accessToken); } catch (e) { console.error("opensea revoke failed:", e && e.message); } }
    }
  });
};
