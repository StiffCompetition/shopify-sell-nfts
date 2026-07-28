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

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

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

app.get("/claim/lookup/:orderId", async (req, res) => {
  const { orderId } = req.params;
  const result = await pool.query("SELECT claim_token FROM claims WHERE order_id = $1 AND claimed = FALSE", [orderId]);
  if (result.rows.length === 0) {
    return res.send("<h1>Invalid or already claimed</h1>");
  }
  res.redirect(`/claim/order/${orderId}`);
});

app.get("/claim/order/:orderId", async (req, res) => {
  const { orderId } = req.params;
  const result = await pool.query("SELECT * FROM claims WHERE order_id = $1 AND claimed = FALSE", [orderId]);
  if (result.rows.length === 0) {
    return res.send("<h1>Invalid or already claimed</h1>");
  }
  const claims = result.rows;

  const shopUrl = SHOPIFY_SITE_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const shopifyToken = await getShopifyToken();

  const itemNames = [];
  for (const claim of claims) {
    const productResponse = await fetchWithRetry(`https://${shopUrl}/admin/api/2022-07/products/${claim.product_id}.json`, {
      headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' }
    });
    const productData = await productResponse.json();
    itemNames.push(productData.product.title);
  }

  const itemCountText = claims.length === 1 ? "1 NFT" : `${claims.length} NFTs`;
  const itemListHtml = itemNames.map(name => `<li>${name}</li>`).join('');

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Claim Your Stiff Competition NFT${claims.length > 1 ? 's' : ''}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: Arial, sans-serif; max-width: 500px; margin: 50px auto; padding: 20px; text-align: center; }
        input { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; font-size: 14px; }
        button { width: 100%; padding: 12px; background: #000; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; margin: 5px 0; }
        button:hover { background: #333; }
        .or { margin: 15px 0; color: #999; }
        .message { margin-top: 20px; padding: 10px; border-radius: 4px; }
        .success { background: #d4edda; color: #155724; }
        .error { background: #f8d7da; color: #721c24; }
        ul.items { text-align: left; margin: 15px 0; padding-left: 20px; }
        .nft-link { display: block; margin: 6px 0; }
      </style>
    </head>
    <body>
      <img src="https://res.cloudinary.com/dkapdtxek/image/upload/SC_small.svg" alt="Stiff Competition" style="max-width: 200px; margin-bottom: 20px;" />
      <h1>🎉 Claim Your ${itemCountText}</h1>
      <p>You've purchased ${itemCountText} from Stiff Competition! Enter your wallet address below to receive ${claims.length === 1 ? 'it' : 'all of them'}.</p>
      <ul class="items">${itemListHtml}</ul>
      <h3>I have a wallet</h3>
      <input type="text" id="walletAddress" placeholder="Enter your wallet address (0x...)" />
      <button onclick="claimWithWallet()">Claim to My Wallet</button>
      <div class="or">— OR —</div>
      <h3>I don't have a wallet</h3>
      <input type="email" id="emailAddress" placeholder="Enter your email address" />
      <button onclick="claimWithEmail()">Create Wallet & Claim</button>
      <div id="message"></div>
      <script>
        async function claimWithWallet() {
          const wallet = document.getElementById('walletAddress').value.trim();
          if (!wallet) { showMessage('Please enter your wallet address', false); return; }
          await submitClaim(wallet);
        }
        async function claimWithEmail() {
          const email = document.getElementById('emailAddress').value.trim();
          if (!email) { showMessage('Please enter your email address', false); return; }
          await submitClaim(null, email);
        }
        async function submitClaim(wallet, email) {
          const btn = document.querySelectorAll('button');
          btn.forEach(b => b.disabled = true);
          showMessage('Processing your claim... please wait', null);
          const response = await fetch('/claim/order/${orderId}/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ walletAddress: wallet, email: email })
          });
          const data = await response.json();
          if (data.success) {
            const links = data.items.map(item =>
              '<a class="nft-link" href="' + item.openseaUrl + '" target="_blank" style="color:#000;text-decoration:underline;">' + item.name + ' — View on OpenSea</a>'
            ).join('');
            const walletMsg = data.usedEmail
              ? '<br><br>A wallet has been created for you. <a href="https://thirdweb.com/wallet" target="_blank" style="color:#155724;font-weight:bold;">Visit thirdweb.com/wallet</a> and sign in with your email to access it and view your NFT on OpenSea.'
              : '';
            showMessage('🎉 Your NFT' + (data.items.length > 1 ? 's have' : ' has') + ' been minted and sent to your wallet!' + walletMsg + '<br>' + links, true);
          } else {
            showMessage('Something went wrong: ' + data.error, false);
            btn.forEach(b => b.disabled = false);
          }
        }
        function showMessage(msg, success) {
          const el = document.getElementById('message');
          el.className = 'message ' + (success === true ? 'success' : success === false ? 'error' : '');
          el.innerHTML = msg;
        }
      </script>
    </body>
    </html>
  `);
});

app.post("/claim/order/:orderId/submit", express.json(), async (req, res) => {
  const { orderId } = req.params;
  const { walletAddress, email } = req.body;
  try {
    const result = await pool.query("SELECT * FROM claims WHERE order_id = $1 AND claimed = FALSE", [orderId]);
    if (result.rows.length === 0) {
      return res.json({ success: false, error: "Invalid or already claimed" });
    }

    let mintAddress = walletAddress;
    if (!mintAddress && email) {
      const walletResponse = await fetch("https://api.thirdweb.com/v1/wallets/server", {
        method: "POST",
        headers: {
          "x-secret-key": THIRDWEB_SECRET_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ identifier: email }),
      });
      const walletData = await walletResponse.json();
      mintAddress = walletData.result.address;
      console.log(`Created/retrieved wallet for ${email}: ${mintAddress}`);
    }

    if (!mintAddress) {
      return res.json({ success: false, error: "Please provide a wallet address or email" });
    }

    const shopUrl = SHOPIFY_SITE_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const shopifyToken = await getShopifyToken();

    const sdk = ThirdwebSDK.fromPrivateKey(ADMIN_PRIVATE_KEY, "polygon", {
      secretKey: THIRDWEB_SECRET_KEY,
    });
    const nftCollection = await sdk.getNFTCollection(NFT_COLLECTION_ADDRESS);

    const mintedItems = [];

    for (const claim of result.rows) {
      const productResponse = await fetchWithRetry(`https://${shopUrl}/admin/api/2022-07/products/${claim.product_id}.json`, {
        headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' }
      });
      const productData = await productResponse.json();

      const metafieldsResponse = await fetchWithRetry(`https://${shopUrl}/admin/api/2022-07/products/${claim.product_id}/metafields.json`, {
        headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' }
      });
      const metafieldsData = await metafieldsResponse.json();

      const metafields = metafieldsData.metafields;
      console.log("ALL METAFIELDS for product", claim.product_id, ":", JSON.stringify(metafields, null, 2));
      const getMeta = (key, namespace = "verisart") => {
        const field = metafields.find((m) => m.namespace === namespace && m.key === key);
        return field ? field.value : "";
      };

      const cloudinaryImageUrl = productData.product.image.src;
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

    res.json({ success: true, items: mintedItems, walletAddress: mintAddress, usedEmail: !!email });

  } catch (error) {
    console.error("Minting error:", error);
    res.json({ success: false, error: error.message });
  }
});

app.listen(3000, () => console.log("Server running on port 3000!"));
