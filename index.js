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
} = process.env;


const path = require('path');
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Serve React build
app.use(express.static(path.join(__dirname, 'public')));

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
  const response = await fetchWithRetry(`https://stiifcompnft.myshopify.com/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept-Encoding": "identity" },
    body: new URLSearchParams({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_ACCESS_TOKEN,
      grant_type: "client_credentials"
    }).toString()
  });
  const data = await response.json();
  console.log("Token response:", JSON.stringify(data));
  return data.access_token;
}

function ipfsToGatewayUrl(ipfsUri) {
  return ipfsUri.replace("ipfs://", "https://gateway.pinata.cloud/ipfs/");
}

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
  return ipfsToGatewayUrl(`ipfs://${pinataData.IpfsHash}`);
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
  return ipfsToGatewayUrl(`ipfs://${pinataData.IpfsHash}`);
}


app.post("/webhooks/orders/create", async (req, res) => {
  console.log("Order event received!");
  const hmac = req.get("X-Shopify-Hmac-Sha256");
  const body = await getRawBody(req);
  const hash = crypto.createHmac("sha256", SHOPIFY_SECRET_KEY).update(body, "utf8", "hex").digest("base64");
  if (hash === hmac) {
    const orderData = JSON.parse(body);
    const itemsPurchased = orderData.line_items;
    const customerEmail = orderData.email;
    for (const item of itemsPurchased) {
      const claimToken = crypto.randomBytes(32).toString("hex");
      await pool.query(
        "INSERT INTO claims (claim_token, order_id, product_id, customer_email) VALUES ($1, $2, $3, $4) ON CONFLICT (claim_token) DO NOTHING",
        [claimToken, orderData.id.toString(), item.product_id.toString(), customerEmail]
      );
      console.log(`Claim token created: ${claimToken} for product ${item.product_id}`);
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(403);
  }
});

// New endpoint: returns order details for the React claim page
app.get("/claim/order/:orderId/details", async (req, res) => {
  const { orderId } = req.params;
  const result = await pool.query("SELECT * FROM claims WHERE order_id = $1 AND claimed = FALSE", [orderId]);
  if (result.rows.length === 0) {
    return res.json({ error: "Invalid or already claimed" });
  }
  const claims = result.rows;
  const shopUrl = 'stiifcompnft.myshopify.com';
  try {
    const shopifyToken = await getShopifyToken();
    const itemNames = [];
    for (const claim of claims) {
      const productResponse = await fetchWithRetry(`https://${shopUrl}/admin/api/2024-01/products/${claim.product_id}.json`, {
        headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' }
      });
      const productData = await productResponse.json();
      itemNames.push(productData.product ? productData.product.title : 'Stiff Competition NFT');
    }
    res.json({ items: itemNames });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get("/claim/lookup/:orderId", async (req, res) => {
  const { orderId } = req.params;
  const result = await pool.query("SELECT claim_token FROM claims WHERE order_id = $1 AND claimed = FALSE", [orderId]);
  if (result.rows.length === 0) {
    return res.send("<h1>Invalid or already claimed</h1>");
  }
  res.redirect(`/claim/order/${orderId}`);
});

// Serve React app for claim pages
app.get("/claim/order/:orderId", (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post("/claim/order/:orderId/submit", express.json(), async (req, res) => {
  const { orderId } = req.params;
  const { walletAddress, email } = req.body;
  try {
    const result = await pool.query("SELECT * FROM claims WHERE order_id = $1 AND claimed = FALSE", [orderId]);
    if (result.rows.length === 0) {
      return res.json({ success: false, error: "Invalid or already claimed" });
    }

    const mintAddress = walletAddress;
    if (!mintAddress) {
      return res.json({ success: false, error: "No wallet address provided" });
    }

    const shopUrl = 'stiifcompnft.myshopify.com';
    const shopifyToken = await getShopifyToken();

    const sdk = ThirdwebSDK.fromPrivateKey(ADMIN_PRIVATE_KEY, "polygon", {
      secretKey: THIRDWEB_SECRET_KEY,
    });
    const nftCollection = await sdk.getNFTCollection(NFT_COLLECTION_ADDRESS);

    const mintedItems = [];

    for (const claim of result.rows) {
      const productResponse = await fetchWithRetry(`https://${shopUrl}/admin/api/2024-01/products/${claim.product_id}.json`, {
        headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' }
      });
      const productData = await productResponse.json();
      console.log("Product data in submit:", JSON.stringify(productData));

      if (!productData.product) {
        throw new Error(`Product not found for ID ${claim.product_id}: ${JSON.stringify(productData)}`);
      }

      const cloudinaryImageUrl = (productData.product.image && productData.product.image.src)
        || (productData.product.images && productData.product.images[0] && productData.product.images[0].src);

      if (!cloudinaryImageUrl) {
        throw new Error(`No image found for product ${claim.product_id}`);
      }

      const metafieldsResponse = await fetchWithRetry(`https://${shopUrl}/admin/api/2024-01/products/${claim.product_id}/metafields.json`, {
        headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' }
      });
      const metafieldsData = await metafieldsResponse.json();
      const metafields = metafieldsData.metafields;
      console.log("ALL METAFIELDS for product", claim.product_id, ":", JSON.stringify(metafields, null, 2));

      const getMeta = (key, namespace = "verisart") => {
        const field = metafields.find((m) => m.namespace === namespace && m.key === key);
        return field ? field.value : "";
      };

      const ipfsImageUrl = await uploadImageToIPFS(cloudinaryImageUrl);

      const metadata = {
        name: productData.product.title,
        description: productData.product.body_html.replace(/<[^>]*>/g, ''),
        image: ipfsImageUrl,
        attributes: [
          { trait_type: "Character", value: getMeta("character", "custom") },
          { trait_type: "Theme", value: getMeta("gimmick", "custom") },
          { trait_type: "Collection", value: getMeta("inspection_grade") },
          { trait_type: "Structural Rigidity", value: getMeta("structural_rigidity") },
          { trait_type: "Innuendo Intensity", value: getMeta("innuendo_intensity") },
          { trait_type: "Friction Force", value: getMeta("friction_force") },
          { trait_type: "Tactical Girth", value: getMeta("tactical_girth") },
          { trait_type: "Lore", value: getMeta("expanded_lore", "custom") },
        ],
      };

      console.log("METADATA BEING MINTED:", JSON.stringify(metadata, null, 2));

      const metadataUri = await uploadMetadataToIPFS(metadata);
      console.log("METADATA URI:", metadataUri);

      const minted = await nftCollection.mintTo(mintAddress, metadataUri);
      console.log("NFT minted successfully!", minted);

      await pool.query("UPDATE claims SET claimed = TRUE WHERE claim_token = $1", [claim.claim_token]);

      const openseaUrl = `https://opensea.io/assets/matic/${NFT_COLLECTION_ADDRESS}/${minted.id.toString()}`;
      mintedItems.push({ name: metadata.name, openseaUrl });
    }

    res.json({ success: true, items: mintedItems, walletAddress: mintAddress });

  } catch (error) {
    console.error("Minting error:", error);
    res.json({ success: false, error: error.message });
  }
});

app.listen(3000, () => console.log("Server running on port 3000!"));
