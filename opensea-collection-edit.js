// OpenSea collection name/description editor (added 6 Nov 2026, Andy: new Blueprint collection, old one renamed back).
// POST /opensea/collection-edit, header X-Sign-Secret = OPENSEA_SIGN_SECRET (same guard as /opensea/list).
// Body: { slug, name?, description?, dryRun? }. dryRun (default) only READS the collection from OpenSea and shows what would change.
// Live: the admin wallet signs in (OpenSeaAuth, write:collections only), PATCH /api/v2/collections/{slug} with name and/or
// description, reads it back, revokes the token. The slug is never sent, so links never change.
// Guard: the bare name "The Blueprint" is refused (OpenSea delisted a collection renamed to it, 5 Nov 2026).
const crypto = require("crypto");

const API = "https://api.opensea.io";
const BLOCKED_NAMES = ["the blueprint", "blueprint"];

function secretOk(given) {
  const expected = String(process.env.OPENSEA_SIGN_SECRET || "");
  try {
    const a = Buffer.from(String(given || ""), "utf8"), b = Buffer.from(expected, "utf8");
    return expected.length >= 24 && a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

module.exports = function mountOpenSeaCollectionEdit(app, express) {
  app.post("/opensea/collection-edit", express.json({ limit: "20kb" }), async (req, res) => {
    if (!secretOk(req.get("X-Sign-Secret"))) return res.status(403).json({ success: false, error: "Not allowed" });
    const b = req.body || {};
    const slug = String(b.slug || "");
    if (!/^[a-z0-9-]{1,50}$/.test(slug)) return res.status(400).json({ success: false, error: "slug must be lowercase letters, numbers and hyphens" });
    const change = {};
    if (b.name != null) {
      const name = String(b.name);
      if (!/^[\x20-\x7E]{1,100}$/.test(name)) return res.status(400).json({ success: false, error: "name must be 1 to 100 printable ASCII characters" });
      if (BLOCKED_NAMES.indexOf(name.trim().toLowerCase()) !== -1) return res.status(400).json({ success: false, error: "That name is refused: OpenSea delists collections with it" });
      change.name = name;
    }
    if (b.description != null) change.description = String(b.description).slice(0, 1000);
    if (!Object.keys(change).length) return res.status(400).json({ success: false, error: "name or description is required" });

    let auth, token;
    try {
      let apiKey = String(process.env.OPENSEA_API_KEY || "");
      const { OpenSeaAPI, OpenSeaAuth } = require("@opensea/sdk");
      if (apiKey.length < 16) {
        const k = await OpenSeaAPI.requestInstantApiKey();
        apiKey = String(k && k.apiKey || "");
      }
      if (apiKey.length < 16) return res.status(500).json({ success: false, error: "No OpenSea API key available" });
      const read = async () => {
        const r = await fetch(`${API}/api/v2/collections/${slug}`, { headers: { "X-API-KEY": apiKey, Accept: "application/json" } });
        const j = r.ok ? await r.json() : {};
        return { status: r.status, name: j.name, description: j.description, slug: j.collection || j.slug, contracts: j.contracts, fees: j.fees, safelist: j.safelist_status || j.safelist_request_status };
      };
      const before = await read();
      if (b.dryRun !== false) return res.json({ success: true, dryRun: true, slug, current: before, wouldChange: change });
      if (before.status !== 200) return res.status(404).json({ success: false, error: "Collection not found on OpenSea (" + before.status + ")" });

      const { ethers } = require("ethers6");
      if (typeof OpenSeaAuth !== "function") return res.status(500).json({ success: false, error: "Installed OpenSea SDK has no OpenSeaAuth" });
      const wallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY);
      auth = new OpenSeaAuth();
      token = await auth.authenticate(wallet, { scopes: ["write:collections"] });
      const patch = await fetch(`${API}/api/v2/collections/${slug}`, {
        method: "PATCH",
        headers: { "X-API-KEY": apiKey, Authorization: `Bearer ${token.accessToken}`, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(change),
      });
      const patchText = await patch.text().catch(() => "");
      if (!patch.ok) return res.status(502).json({ success: false, error: `Update: ${patch.status} ${patchText.slice(0, 300)}`, before });
      const after = await read();
      res.json({ success: true, slug, before, after, patchStatus: patch.status });
    } catch (e) {
      res.status(500).json({ success: false, error: String(e && e.message || e).slice(0, 400) });
    } finally {
      if (auth && token) { try { await auth.revoke(token.accessToken); } catch (e) { console.error("opensea revoke failed:", e && e.message); } }
    }
  });
};
