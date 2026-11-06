// One-off collection deploy (added 6 Nov 2026, Andy: "you can do all of this").
// POST /opensea/deploy-collection, header X-Sign-Secret = OPENSEA_SIGN_SECRET (same guard as /opensea/list).
// Body {dry:true} (default): returns the admin wallet, its POL balance and the planned settings. Changes nothing.
// Body {dry:false, confirm:"DEPLOY-ONCE"}: deploys ONE new empty thirdweb NFT Collection on Polygon from the admin wallet
// (gas only, no price, so no thirdweb sale fee) and returns its address. A second deploy in the same process is refused.
const crypto = require("crypto");
const { ThirdwebSDK } = require("@thirdweb-dev/sdk");

let deployed = null;

function secretOk(given) {
  const expected = String(process.env.OPENSEA_SIGN_SECRET || "");
  try {
    const a = Buffer.from(String(given || ""), "utf8"), b = Buffer.from(expected, "utf8");
    return expected.length >= 24 && a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

module.exports = function mountDeployCollection(app, express) {
  app.post("/opensea/deploy-collection", express.json(), async (req, res) => {
    if (!secretOk(req.get("X-Sign-Secret"))) return res.status(403).json({ success: false, error: "Not allowed" });
    try {
      const body = req.body || {};
      const dry = body.dry !== false;
      const sdk = ThirdwebSDK.fromPrivateKey(process.env.ADMIN_PRIVATE_KEY, "polygon", { secretKey: process.env.THIRDWEB_SECRET_KEY });
      const wallet = await sdk.wallet.getAddress();
      const bal = await sdk.wallet.balance();
      const settings = {
        name: String(body.name || "Stiff Competition: The Blueprint"),
        symbol: String(body.symbol || "SCBP"),
        description: "The Blueprint by Stiff Competition. One-of-one pieces.",
        primary_sale_recipient: wallet,
        fee_recipient: wallet,
        seller_fee_basis_points: 1000,
        platform_fee_basis_points: 0,
        platform_fee_recipient: wallet,
      };
      if (dry) return res.json({ success: true, dry: true, wallet, pol_balance: bal.displayValue, existing_collection: process.env.NFT_COLLECTION_ADDRESS, settings });
      if (body.confirm !== "DEPLOY-ONCE") return res.status(400).json({ success: false, error: "confirm missing" });
      if (deployed) return res.status(409).json({ success: false, error: "Already deployed in this process", address: deployed });
      if (Number(bal.displayValue) < 0.5) return res.status(400).json({ success: false, error: "Wallet POL balance too low for deploy", pol_balance: bal.displayValue });
      const address = await sdk.deployer.deployNFTCollection(settings);
      deployed = address;
      res.json({ success: true, dry: false, address, wallet, settings });
    } catch (e) { res.status(500).json({ success: false, error: String(e && e.message || e) }); }
  });
};
