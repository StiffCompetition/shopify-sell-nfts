// OpenSea listing signer (added 3 Nov 2026 for the OpenSea drops, SC - OpenSea Drop List in n8n).
// POST /opensea/list, header X-Sign-Secret = OPENSEA_SIGN_SECRET (new, separate from every other secret).
// Body: { tokenIds: ["38", ...], price: 1.5, expirationDays?: 30, dryRun?: true }
// OpenSea API key: Railway variable OPENSEA_API_KEY (full key) if set; otherwise a free instant key is requested from OpenSea.
// Lists tokens of THIS collection only (NFT_COLLECTION_ADDRESS), owned by the admin wallet, with one
// Seaport signature for the whole batch (OpenSea SDK createBulkListings). The admin key never leaves this service.
// Nothing here touches the shop, the claim flow or minting. If this module fails to load, only this route fails.
const crypto = require("crypto");

function secretOk(given) {
  const expected = String(process.env.OPENSEA_SIGN_SECRET || "");
  try {
    const a = Buffer.from(String(given || ""), "utf8"), b = Buffer.from(expected, "utf8");
    return expected.length >= 24 && a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

module.exports = function mountOpenSeaList(app, express) {
  app.post("/opensea/list", express.json({ limit: "100kb" }), async (req, res) => {
    if (!secretOk(req.get("X-Sign-Secret"))) return res.status(403).json({ success: false, error: "Not allowed" });
    const b = req.body || {};
    const ids = Array.isArray(b.tokenIds) ? b.tokenIds.map(String) : [];
    if (!ids.length || ids.length > 30 || ids.some(i => !/^\d{1,9}$/.test(i)) || new Set(ids).size !== ids.length) {
      return res.status(400).json({ success: false, error: "tokenIds must be 1 to 30 different token numbers" });
    }
    const price = Number(b.price);
    if (!(price > 0) || price > 1000000) return res.status(400).json({ success: false, error: "price must be above 0" });
    const mins = Number(b.expirationMinutes) > 0 ? Math.min(Math.max(Math.floor(Number(b.expirationMinutes)), 10), 1440) : 0;
    const currency = String(b.currency || "POL").toUpperCase() === "WETH" ? "WETH" : "POL";
    const days = Math.min(Math.max(Number(b.expirationDays) || 30, 1), 180);
    try {
      const { ethers } = require("ethers6");
      const { OpenSeaSDK, OpenSeaAPI, Chain } = require("@opensea/sdk");
      const collection = String(process.env.NFT_COLLECTION_ADDRESS || "");
      if (!/^0x[0-9a-fA-F]{40}$/.test(collection)) return res.status(500).json({ success: false, error: "Collection address not set" });
      let rpcReq;
      if (process.env.THIRDWEB_SECRET_KEY && !process.env.POLYGON_RPC_URL) {
        // thirdweb RPC, authenticated with the service's existing thirdweb secret (supports archive-style calls the OpenSea SDK makes)
        rpcReq = new ethers.FetchRequest("https://137.rpc.thirdweb.com");
        rpcReq.setHeader("x-secret-key", process.env.THIRDWEB_SECRET_KEY);
      } else {
        rpcReq = process.env.POLYGON_RPC_URL || "https://polygon.drpc.org";
      }
      const provider = new ethers.JsonRpcProvider(rpcReq, 137, { staticNetwork: true });
      const wallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);
      const nft = new ethers.Contract(collection, ["function ownerOf(uint256) view returns (address)"], provider);
      const notOwned = [];
      for (const id of ids) {
        const owner = await nft.ownerOf(id).catch(() => "");
        if (String(owner).toLowerCase() !== wallet.address.toLowerCase()) notOwned.push(id);
      }
      const balance = ethers.formatEther(await provider.getBalance(wallet.address));
      if (notOwned.length) return res.status(400).json({ success: false, error: "Not owned by the admin wallet: " + notOwned.join(", "), wallet: wallet.address, polBalance: balance });
      if (b.dryRun !== false) return res.json({ success: true, dryRun: true, wallet: wallet.address, polBalance: balance, wouldList: ids.length, price, currency, expirationDays: days });

      let apiKey = String(process.env.OPENSEA_API_KEY || "");
      let keyKind = "full key";
      if (apiKey.length < 16) {
        const k = await OpenSeaAPI.requestInstantApiKey();
        apiKey = String(k && k.apiKey || "");
        keyKind = "free instant key";
      }
      if (apiKey.length < 16) return res.status(500).json({ success: false, error: "No OpenSea API key available" });
      const sdk = new OpenSeaSDK(wallet, { chain: Chain.Polygon, apiKey });
      // Price currency: POL (Polygon's native token, default) or WETH. The SDK takes the listing currency from the
      // collection data it fetches, and otherwise lists in WETH, so for POL we hand it the native token (zero address).
      if (currency === "POL") {
        const origGetCollection = sdk.api.getCollection.bind(sdk.api);
        sdk.api.getCollection = async (slug) => {
          const c = await origGetCollection(slug);
          const pc = c.pricingCurrencies || {};
          return { ...c, pricingCurrencies: { ...pc, listingCurrency: { ...(pc.listingCurrency || {}), address: "0x0000000000000000000000000000000000000000" } } };
        };
      }
      const expirationTime = Math.floor(Date.now() / 1000) + (mins ? mins * 60 : days * 86400);
      const result = await sdk.createBulkListings({
        accountAddress: wallet.address,
        continueOnError: true,
        listings: ids.map(id => ({ asset: { tokenAddress: collection, tokenId: id }, amount: price, expirationTime })),
      });
      const listed = (result.successful || []).map(o => ({ orderHash: o.orderHash, status: o.status }));
      const failed = (result.failed || []).map(f => ({ error: String((f && (f.error && f.error.message || f.message)) || f).slice(0, 300) }));
      res.json({ success: failed.length === 0, listed, failed, wallet: wallet.address, price, currency, expirationDays: days, expirationMinutes: mins || undefined, keyKind });
    } catch (e) {
      res.status(500).json({ success: false, error: String(e && e.message || e).slice(0, 400) });
    }
  });
};
