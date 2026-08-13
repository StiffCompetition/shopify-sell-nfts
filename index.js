const express = require("express");
const app = express();
const getRawBody = require("raw-body");
const crypto = require("crypto");
const { ThirdwebSDK } = require("@thirdweb-dev/sdk");
const fetch = require("node-fetch");
const FormData = require("form-data");
const { Pool } = require("pg");
require("dotenv").config();

const {
  ADMIN_PRIVATE_KEY,
  NFT_COLLECTION_ADDRESS,
  SHOPIFY_SECRET_KEY,
  SHOPIFY_SITE_URL,
  SHOPIFY_ACCESS_TOKEN,
  SHOPIFY_CLIENT_ID,
  THIRDWEB_SECRET_KEY,
  PINATA_JWT,
  DATABASE_URL,
  MINTING_ENABLED,
} = process.env;

const path = require('path');
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

const SHOP_URL = 'stiifcompnft.myshopify.com';
const API_VERSION = '2025-10';
const NFT_PRODUCT_TYPE = 'NFT';

// Kill switch. Set MINTING_ENABLED=false in Railway to halt all minting immediately.
function mintingEnabled() {
  return String(MINTING_ENABLED || 'true').toLowerCase() !== 'false';
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS claims (
      id SERIAL PRIMARY KEY,
      claim_token TEXT UNIQUE NOT NULL,
      order_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      customer_email TEXT,
      claimed BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE claims ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1`);

  // Idempotency. One claim row per product per order, so a repeated webhook
  // delivery can never create a second claim and mint a duplicate NFT.
  // Guarded so historic duplicates cannot stop the service booting.
  try {
    await pool.query(
      `ALTER TABLE claims ADD CONSTRAINT claims_order_product_unique UNIQUE (order_id, product_id)`
    );
    console.log("Idempotency constraint applied.");
  } catch (e) {
    if (e.code === '42710' || e.code === '42P07') {
      console.log("Idempotency constraint already present.");
    } else {
      console.warn("Idempotency constraint NOT applied — clear duplicate rows first:", e.message);
    }
  }

  console.log("Database ready!");
}
initDB();

async function fetchWithRetry(url, options, retries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (error) {
      console.log(`Fetch attempt ${attempt}/${retries} failed for ${url}: ${error.message}`);
      if (attempt === retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

async function getShopifyToken() {
  const response = await fetchWithRetry(`https://${SHOP_URL}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept-Encoding": "identity" },
    body: new URLSearchParams({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_ACCESS_TOKEN,
      grant_type: "client_credentials"
    }).toString()
  });
  const data = await response.json();
  if (!data.access_token) console.error("Shopify token request failed:", JSON.stringify(data));
  return data.access_token;
}

async function shopifyGet(pathname, token) {
  const response = await fetchWithRetry(`https://${SHOP_URL}/admin/api/${API_VERSION}/${pathname}`, {
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
      'Accept-Encoding': 'identity',
    }
  });
  return response.json();
}

// ---------- email helpers ----------

function normaliseEmail(value) {
  return String(value || '').trim().toLowerCase();
}

// j••••@gmail.com — enough for the buyer to recognise, not enough to guess.
function maskEmail(value) {
  const email = normaliseEmail(value);
  const at = email.indexOf('@');
  if (at < 1) return '';
  const name = email.slice(0, at);
  const domain = email.slice(at);
  return `${name.slice(0, 1)}${'•'.repeat(Math.max(name.length - 1, 3))}${domain}`;
}

// ---------- attempt limiting ----------
// Order IDs are short and guessable, so the buyer's email is the secret that
// protects the claim. This stops that secret being found by repetition.

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60 * 60 * 1000;
const attempts = new Map();

function isLockedOut(orderId) {
  const record = attempts.get(orderId);
  if (!record) return false;
  if (Date.now() - record.first > LOCKOUT_MS) {
    attempts.delete(orderId);
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

function recordFailure(orderId) {
  const record = attempts.get(orderId);
  if (!record || Date.now() - record.first > LOCKOUT_MS) {
    attempts.set(orderId, { count: 1, first: Date.now() });
  } else {
    record.count += 1;
  }
}

function clearFailures(orderId) {
  attempts.delete(orderId);
}

// ---------- IPFS ----------

async function uploadImageToIPFS(imageUrl) {
  const imageResponse = await fetchWithRetry(imageUrl);
  const imageBuffer = await imageResponse.buffer();
  const contentType = imageResponse.headers.get("content-type");
  const filename = imageUrl.split("/").pop();
  const formData = new FormData();
  formData.append("file", imageBuffer, { filename, contentType });
  const pinataResponse = await fetchWithRetry("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${PINATA_JWT}`, ...formData.getHeaders() },
    body: formData,
  });
  const pinataData = await pinataResponse.json();
  if (!pinataData.IpfsHash) throw new Error(`Pinata image upload failed: ${JSON.stringify(pinataData)}`);
  // Written on chain as ipfs:// so the token never depends on one gateway staying up.
  return `ipfs://${pinataData.IpfsHash}`;
}

async function uploadMetadataToIPFS(metadata) {
  const pinataResponse = await fetchWithRetry("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PINATA_JWT}`,
      "Content-Type": "application/json",
      "Accept-Encoding": "identity",
    },
    body: JSON.stringify({ pinataContent: metadata }),
  });
  const pinataData = await pinataResponse.json();
  if (!pinataData.IpfsHash) throw new Error(`Pinata metadata upload failed: ${JSON.stringify(pinataData)}`);
  return `ipfs://${pinataData.IpfsHash}`;
}

// ---------- webhook ----------

app.post("/webhooks/orders/create", async (req, res) => {
  const hmac = req.get("X-Shopify-Hmac-Sha256");
  const body = await getRawBody(req);
  const hash = crypto.createHmac("sha256", SHOPIFY_SECRET_KEY).update(body, "utf8", "hex").digest("base64");

  let valid = false;
  try {
    const a = Buffer.from(hash, 'utf8');
    const b = Buffer.from(String(hmac || ''), 'utf8');
    valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) {
    valid = false;
  }

  if (!valid) return res.sendStatus(403);

  // Acknowledge immediately. Shopify retries slow responses, and a retry landing
  // mid-processing is what creates duplicate claims.
  res.sendStatus(200);

  try {
    const orderData = JSON.parse(body);
    const orderId = orderData.id.toString();
    const customerEmail = orderData.email;
    const token = await getShopifyToken();

    for (const item of orderData.line_items) {
      if (!item.product_id) continue;

      // Order webhooks do not carry product type, so it is read from the product.
      const productData = await shopifyGet(`products/${item.product_id}.json`, token);
      const productType = productData.product ? productData.product.product_type : null;

      if (productType !== NFT_PRODUCT_TYPE) {
        console.log(`Order ${orderId}: skipping non-NFT product ${item.product_id} (${productType})`);
        continue;
      }

      const claimToken = crypto.randomBytes(32).toString("hex");
      await pool.query(
        `INSERT INTO claims (claim_token, order_id, product_id, customer_email, quantity)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (order_id, product_id) DO NOTHING`,
        [claimToken, orderId, item.product_id.toString(), customerEmail, item.quantity || 1]
      );
      console.log(`Order ${orderId}: claim ready for product ${item.product_id} x${item.quantity || 1}`);
    }
  } catch (error) {
    console.error("Webhook processing error:", error);
  }
});

// ---------- claim ----------

app.get("/claim/lookup/:orderId", async (req, res) => {
  // Always hand off to the React app so every outcome is branded.
  res.redirect(`/claim/order/${req.params.orderId}`);
});

app.get("/claim/order/:orderId/details", async (req, res) => {
  const { orderId } = req.params;
  try {
    const result = await pool.query(
      "SELECT * FROM claims WHERE order_id = $1 AND claimed = FALSE",
      [orderId]
    );
    if (result.rows.length === 0) {
      return res.json({ error: "Invalid or already claimed" });
    }

    const token = await getShopifyToken();
    const itemNames = [];
    for (const claim of result.rows) {
      const productData = await shopifyGet(`products/${claim.product_id}.json`, token);
      itemNames.push(productData.product ? productData.product.title : 'Stiff Competition NFT');
    }

    res.json({
      items: itemNames,
      emailHint: maskEmail(result.rows[0].customer_email),
      locked: isLockedOut(orderId),
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.post("/claim/order/:orderId/submit", express.json(), async (req, res) => {
  const { orderId } = req.params;
  const { walletAddress, email } = req.body;

  try {
    if (!mintingEnabled()) {
      return res.json({ success: false, error: "Claiming is temporarily unavailable. Please try again shortly." });
    }

    if (isLockedOut(orderId)) {
      return res.json({ success: false, error: "Too many attempts. Please try again in an hour, or contact hq@stiffcompetition.shop." });
    }

    const result = await pool.query(
      "SELECT * FROM claims WHERE order_id = $1 AND claimed = FALSE",
      [orderId]
    );
    if (result.rows.length === 0) {
      return res.json({ success: false, error: "Invalid or already claimed" });
    }

    // The claim link only ever appears in the order confirmation email, so the
    // buyer's own address is proof they received it. Without this check, a guessed
    // order ID mints to whatever wallet the caller supplies.
    const supplied = normaliseEmail(email);
    const onOrder = normaliseEmail(result.rows[0].customer_email);
    if (!supplied || supplied !== onOrder) {
      recordFailure(orderId);
      return res.json({
        success: false,
        error: "That email doesn't match the one on this order. Please use the address your order confirmation was sent to.",
      });
    }
    clearFailures(orderId);

    const mintAddress = walletAddress;
    if (!mintAddress || !/^0x[a-fA-F0-9]{40}$/.test(mintAddress)) {
      return res.json({ success: false, error: "That wallet address doesn't look right — it should start with 0x and be 42 characters long." });
    }

    const shopifyToken = await getShopifyToken();

    const sdk = ThirdwebSDK.fromPrivateKey(ADMIN_PRIVATE_KEY, "polygon", {
      secretKey: THIRDWEB_SECRET_KEY,
    });
    const nftCollection = await sdk.getNFTCollection(NFT_COLLECTION_ADDRESS);

    const mintedItems = [];

    for (const claim of result.rows) {
      const productData = await shopifyGet(`products/${claim.product_id}.json`, shopifyToken);

      if (!productData.product) {
        throw new Error(`Product not found for ID ${claim.product_id}`);
      }

      const cloudinaryImageUrl = (productData.product.image && productData.product.image.src)
        || (productData.product.images && productData.product.images[0] && productData.product.images[0].src);

      if (!cloudinaryImageUrl) {
        throw new Error(`No image found for product ${claim.product_id}`);
      }

      const metafieldsData = await shopifyGet(`products/${claim.product_id}/metafields.json`, shopifyToken);
      const metafields = metafieldsData.metafields || [];

      const getMeta = (key, namespace = "verisart") => {
        const field = metafields.find((m) => m.namespace === namespace && m.key === key);
        return field ? field.value : "";
      };

      const ipfsImageUrl = await uploadImageToIPFS(cloudinaryImageUrl);

      // No customer data is written on chain.
      const metadata = {
        name: productData.product.title,
        description: (productData.product.body_html || '').replace(/<[^>]*>/g, ''),
        image: ipfsImageUrl,
        attributes: [
          { trait_type: "Character", value: getMeta("character", "custom") },
          { trait_type: "Theme", value: getMeta("gimmick", "custom") },
          { trait_type: "Collection", value: getMeta("collection", "custom") },
          { trait_type: "Grade", value: getMeta("grade", "custom") },
          { trait_type: "Volume", value: getMeta("volume", "custom") },
          { trait_type: "Structural Rigidity", value: getMeta("structural_rigidity") },
          { trait_type: "Innuendo Intensity", value: getMeta("innuendo_intensity") },
          { trait_type: "Friction Force", value: getMeta("friction_force") },
          { trait_type: "Tactical Girth", value: getMeta("tactical_girth") },
          { trait_type: "Lore", value: getMeta("expanded_lore", "custom") },
        ],
      };

      const metadataUri = await uploadMetadataToIPFS(metadata);

      const quantity = claim.quantity || 1;
      for (let i = 0; i < quantity; i++) {
        const minted = await nftCollection.mintTo(mintAddress, metadataUri);
        const tokenId = minted.id.toString();
        const txHash = (minted.receipt && minted.receipt.transactionHash) || null;
        console.log(`Minted token ${tokenId} for order ${orderId}, tx ${txHash}`);

        mintedItems.push({
          name: metadata.name,
          tokenId,
          txHash,
          openseaUrl: `https://opensea.io/assets/matic/${NFT_COLLECTION_ADDRESS}/${tokenId}`,
        });
      }

      await pool.query("UPDATE claims SET claimed = TRUE WHERE claim_token = $1", [claim.claim_token]);
    }

    res.json({ success: true, items: mintedItems, walletAddress: mintAddress });

  } catch (error) {
    console.error("Minting error:", error);
    res.json({ success: false, error: error.message });
  }
});

// ---------- static ----------

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(3000, () => console.log("Server running on port 3000!"));
