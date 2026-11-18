// Moves drop pieces from the owner wallet to the signer wallet (added 18 Nov 2026).
// Why: Seaport listings must be signed by the token owner; the owner key is not in this service, the signer key is.
// The owner wallet approved the signer wallet with setApprovalForAll, so the signer can transferFrom owner -> signer.
// POST /opensea/transfer, header X-Sign-Secret = OPENSEA_SIGN_SECRET. Body: { tokenIds: ["38", ...], dryRun?: true }
// Only ever sends tokens to the signer wallet itself, from the owner wallet below, in DROP_COLLECTION_ADDRESS.
// Isolated like opensea-list: if it cannot load, only this route is missing.
const crypto = require("crypto");
const OWNER = "0x2691616fE1fC198e288bCa7Ba61e10c094359657";

function secretOk(given) {
  const expected = String(process.env.OPENSEA_SIGN_SECRET || "");
  try {
    const a = Buffer.from(String(given || ""), "utf8"), b = Buffer.from(expected, "utf8");
    return expected.length >= 24 && a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

module.exports = function mountOpenSeaTransfer(app, express) {
  app.post("/opensea/transfer", express.json({ limit: "100kb" }), async (req, res) => {
    if (!secretOk(req.get("X-Sign-Secret"))) return res.status(403).json({ success: false, error: "Not allowed" });
    const b = req.body || {};
    const ids = Array.isArray(b.tokenIds) ? b.tokenIds.map(String) : [];
    if (!ids.length || ids.length > 30 || ids.some(i => !/^\d{1,9}$/.test(i)) || new Set(ids).size !== ids.length) {
      return res.status(400).json({ success: false, error: "tokenIds must be 1 to 30 different token numbers" });
    }
    try {
      const { ethers } = require("ethers6");
      const collection = String(process.env.DROP_COLLECTION_ADDRESS || "");
      if (!/^0x[0-9a-fA-F]{40}$/.test(collection)) return res.status(500).json({ success: false, error: "DROP_COLLECTION_ADDRESS not set" });
      let rpcReq;
      if (process.env.THIRDWEB_SECRET_KEY && !process.env.POLYGON_RPC_URL) {
        rpcReq = new ethers.FetchRequest("https://137.rpc.thirdweb.com");
        rpcReq.setHeader("x-secret-key", process.env.THIRDWEB_SECRET_KEY);
      } else {
        rpcReq = process.env.POLYGON_RPC_URL || "https://polygon.drpc.org";
      }
      const provider = new ethers.JsonRpcProvider(rpcReq, 137, { staticNetwork: true });
      const wallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);
      const nft = new ethers.Contract(collection, [
        "function ownerOf(uint256) view returns (address)",
        "function isApprovedForAll(address,address) view returns (bool)",
        "function transferFrom(address,address,uint256)",
      ], wallet);
      const approved = await nft.isApprovedForAll(OWNER, wallet.address);
      const balance = ethers.formatEther(await provider.getBalance(wallet.address));
      const state = {};
      for (const id of ids) {
        const o = String(await nft.ownerOf(id).catch(() => "")).toLowerCase();
        state[id] = o === OWNER.toLowerCase() ? "owner" : o === wallet.address.toLowerCase() ? "signer" : "other";
      }
      const other = ids.filter(i => state[i] === "other");
      if (other.length) return res.status(400).json({ success: false, error: "Held by neither wallet: " + other.join(", ") });
      const toMove = ids.filter(i => state[i] === "owner");
      const already = ids.filter(i => state[i] === "signer");
      if (b.dryRun !== false) return res.json({ success: true, dryRun: true, approved, signer: wallet.address, polBalance: balance, wouldMove: toMove.length, alreadyAtSigner: already.length });
      if (!approved) return res.status(400).json({ success: false, error: "Owner wallet has not approved the signer wallet" });

      const fee = await provider.getFeeData();
      const minTip = ethers.parseUnits("40", "gwei");
      const tip = fee.maxPriorityFeePerGas && fee.maxPriorityFeePerGas > minTip ? fee.maxPriorityFeePerGas : minTip;
      const maxFee = (fee.maxFeePerGas || ethers.parseUnits("100", "gwei")) + tip;
      const moved = [], failed = [];
      for (const id of toMove) {
        try {
          const tx = await nft.transferFrom(OWNER, wallet.address, id, { maxPriorityFeePerGas: tip, maxFeePerGas: maxFee });
          await tx.wait(1, 90000);
          moved.push(id);
        } catch (e) {
          failed.push({ id, error: String(e && e.message || e).slice(0, 200) });
          break; // stop on the first failure so nothing is left half-understood
        }
      }
      res.json({ success: failed.length === 0, moved: moved.length, movedIds: moved, alreadyAtSigner: already.length, failed, signer: wallet.address });
    } catch (e) {
      res.status(500).json({ success: false, error: String(e && e.message || e).slice(0, 400) });
    }
  });
};
