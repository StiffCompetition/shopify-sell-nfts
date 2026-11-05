// Pinata read-only admin (added 4 Nov 2026, Andy: "set up the API for Pinata so you can manage it").
// GET /pinata/usage, header X-Sign-Secret = OPENSEA_SIGN_SECRET: pin count and total size from Pinata, with the free-plan limits.
// GET /pinata/pins?page=0, same header: a page of 100 pinned files (name, hash, size, date), newest first.
// The Pinata key (PINATA_JWT) never leaves this service. Nothing here pins, unpins or changes anything.
const crypto = require("crypto");

function secretOk(given) {
  const expected = String(process.env.OPENSEA_SIGN_SECRET || "");
  try {
    const a = Buffer.from(String(given || ""), "utf8"), b = Buffer.from(expected, "utf8");
    return expected.length >= 24 && a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

async function pinata(path) {
  const r = await fetch("https://api.pinata.cloud" + path, { headers: { Authorization: "Bearer " + String(process.env.PINATA_JWT || "") } });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, json, text: text.slice(0, 500) };
}

module.exports = function mountPinataAdmin(app) {
  app.get("/pinata/usage", async (req, res) => {
    if (!secretOk(req.get("X-Sign-Secret"))) return res.status(403).json({ success: false, error: "Not allowed" });
    try {
      const u = await pinata("/data/userPinnedDataTotal");
      if (u.status !== 200 || !u.json) return res.status(502).json({ success: false, error: "Pinata replied " + u.status, detail: u.text });
      const count = Number(u.json.pin_count || 0), bytes = Number(u.json.pin_size_total || 0);
      res.json({ success: true, pin_count: count, pin_size_bytes: bytes, pin_size_gb: Math.round(bytes / 1073741824 * 1000) / 1000,
        free_plan_limits: { files: 500, gb: 1 }, over_free_plan: count > 500 || bytes > 1073741824 });
    } catch (e) { res.status(500).json({ success: false, error: String(e && e.message || e) }); }
  });
  app.get("/pinata/pins", async (req, res) => {
    if (!secretOk(req.get("X-Sign-Secret"))) return res.status(403).json({ success: false, error: "Not allowed" });
    const page = Math.max(0, Math.min(1000, parseInt(req.query.page, 10) || 0));
    try {
      const p = await pinata("/data/pinList?status=pinned&pageLimit=100&pageOffset=" + (page * 100));
      if (p.status !== 200 || !p.json) return res.status(502).json({ success: false, error: "Pinata replied " + p.status, detail: p.text });
      const rows = (p.json.rows || []).map(r => ({ name: r.metadata && r.metadata.name || "", hash: r.ipfs_pin_hash, size: r.size, pinned: r.date_pinned }));
      res.json({ success: true, page, count: p.json.count, rows });
    } catch (e) { res.status(500).json({ success: false, error: String(e && e.message || e) }); }
  });
};
