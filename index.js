const express = require("express");
const app = express();
const getRawBody = require("raw-body");
const crypto = require("crypto");
const { ThirdwebSDK } = require("@thirdweb-dev/sdk");
const fetch = require("node-fetch");
const FormData = require("form-data");
const { Pool } = require("pg");
const nodemailer = require("nodemailer");
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
  EMAIL_FROM,
  EMAIL_PASSWORD,
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

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: EMAIL_FROM,
    pass: EMAIL_PASSWORD,
  },
});

async function sendClaimEmail(customerEmail, customerName, claimToken, productTitle) {
  const claimUrl = `https://shopify-sell-nfts-production.up.railway.app/claim/${claimToken}`;
  await transporter.sendMail({
    from: `"Stiff Competition" <${EMAIL_FROM}>`,
    to: customerEmail,
    subject: `Claim Your Stiff Competition NFT - ${productTitle}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; text-align: center; padding: 20px;">
        <img src="https://res.cloudinary.com/dkapdtxek/image/upload/SC_small.svg" alt="Stiff Competition" style="max-width: 200px; margin-bottom: 20px;" />
        <h1>🎉 Your NFT is Ready to Claim!</h1>
        <p>Hi ${customerName},</p>
        <p>Thank you for purchasing <strong>${productTitle}</strong>. Your Stiff Competition NFT is ready to claim!</p>
        <p>Click the button below to choose your wallet and receive your NFT.</p>
        <a href="${claimUrl}" style="display: inline-block; padding: 15px 30px; background: #000; color: #fff; text-decoration: none; border-radius: 4px; font-size: 16px; margin: 20px 0;">Claim Your NFT</a>
        <p style="color: #999; font-size: 12px;">This link is unique to your order. Please do not share it.</p>
      </div>
    `,
  });
  console.log(`Claim email sent to ${customerEmail}`);
}

async function getShopifyToken() {
  const response = await fetch(`https://stiifcompnft.myshopify.com/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
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

async function uploadImageToIPFS(imageUrl) {
  const imageResponse = await fetch(imageUrl);
  const imageBuffer = await imageResponse.buffer();
  const contentType = imageResponse.headers.get("content-type");
  const filename = imageUrl.split("/").pop();
  const formData = new FormData();
  formData.append("file", imageBuffer, { filename, contentType });
  const pinataResponse = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${PINATA_JWT}`, ...formData.getHeaders() },
    body: formData,
  });
  const pinataData = await pinataResponse.json();
  return `ipfs://${pinataData.IpfsHash}`;
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
    const customerName = orderData.billing_address ? orderData.billing_address.first_name : "Collector";

    for (const item of itemsPurchased) {
      const claimToken = crypto.randomBytes(32).toString("hex");
      await pool.query(
        "INSERT INTO claims (claim_token, order_id, product_id, customer_email) VALUES ($1, $2, $3, $4) ON CONFLICT (claim_token) DO NOTHING",
        [claimToken, orderData.id.toString(), item.product_id.toString(), customerEmail]
      );
      console.log(`Claim token created: ${claimToken} for product ${item.product_id}`);
      await sendClaimEmail(customerEmail, customerName, claimToken, item.title);
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(403);
  }
});

app.get("/claim/:token", async (req, res) => {
  const { token } = req.params;
  const result = await pool.query("SELECT * FROM claims WHERE claim_token = $1", [token]);
  if (result.rows.length === 0) {
    return res.send("<h1>Invalid claim link</h1>");
  }
  const claim = result.rows[0];
  if (claim.claimed) {
    return res.send("<h1>This NFT has already been claimed</h1>");
  }
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Claim Your Stiff Competition NFT</title>
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
      </style>
    </head>
    <body>
      <img src="https://res.cloudinary.com/dkapdtxek/image/upload/SC_small.svg" alt="Stiff Competition" style="max-width: 200px; margin-bottom: 20px;" />
      <h1>🎉 Claim Your NFT</h1>
      <p>You've purchased a Stiff Competition NFT! Enter your wallet address below to receive it.</p>
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
          const response = await fetch('/claim/${token}/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ walletAddress: wallet, email: email })
          });
          const data = await response.json();
          if (data.success) {
            showMessage('🎉 Your NFT has been minted and sent to your wallet!', true);
          } else {
            showMessage('Something went wrong: ' + data.error, false);
            btn.forEach(b => b.disabled = false);
          }
        }
        function showMessage(msg, success) {
          const el = document.getElementById('message');
          el.className = 'message ' + (success === true ? 'success' : success === false ? 'error' : '');
          el.textContent = msg;
        }
      </script>
    </body>
    </html>
  `);
});

app.post("/claim/:token/submit", express.json(), async (req, res) => {
  const { token } = req.params;
  const { walletAddress, email } = req.body;
  try {
    const result = await pool.query("SELECT * FROM claims WHERE claim_token = $1 AND claimed = FALSE", [token]);
    if (result.rows.length === 0) {
      return res.json({ success: false, error: "Invalid or already claimed" });
    }
    const claim = result.rows[0];
    let mintAddress = walletAddress;
    if (!mintAddress && email) {
      mintAddress = email;
    }
    if (!mintAddress) {
      return res.json({ success: false, error: "Please provide a wallet address or email" });
    }

    const shopUrl = SHOPIFY_SITE_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const shopifyToken = await getShopifyToken();

    const productResponse = await fetch(`https://${shopUrl}/admin/api/2022-07/products/${claim.product_id}.json`, {
      headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' }
    });
    const productData = await productResponse.json();
    console.log("Product data:", JSON.stringify(productData));

    const metafieldsResponse = await fetch(`https://${shopUrl}/admin/api/2022-07/products/${claim.product_id}/metafields.json`, {
      headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' }
    });
    const metafieldsData = await metafieldsResponse.json();

    const metafields = metafieldsData.metafields;
    const getMeta = (key) => {
      const field = metafields.find((m) => m.namespace === "verisart" && m.key === key);
      return field ? field.value : "";
    };

    const cloudinaryImageUrl = productData.product.image.src;
    const ipfsImageUrl = await uploadImageToIPFS(cloudinaryImageUrl);

    const metadata = {
      name: productData.product.title,
      description: productData.product.body_html.replace(/<[^>]*>/g, ''),
      image: ipfsImageUrl,
      attributes: [
        { trait_type: "Character", value: getMeta("character") },
        { trait_type: "Theme", value: getMeta("gimmick") },
        { trait_type: "Collection", value: getMeta("inspection_grade") },
        { trait_type: "Structural Rigidity", value: getMeta("structural_rigidity") },
        { trait_type: "Innuendo Intensity", value: getMeta("innuendo_intensity") },
        { trait_type: "Friction Force", value: getMeta("friction_force") },
        { trait_type: "Tactical Girth", value: getMeta("tactical_girth") },
        { trait_type: "Lore", value: getMeta("expanded_lore") },
      ],
    };

    const sdk = ThirdwebSDK.fromPrivateKey(ADMIN_PRIVATE_KEY, "polygon", {
      secretKey: THIRDWEB_SECRET_KEY,
    });
    const nftCollection = await sdk.getNFTCollection(NFT_COLLECTION_ADDRESS);
    const minted = await nftCollection.mintTo(mintAddress, metadata);

    await pool.query("UPDATE claims SET claimed = TRUE WHERE claim_token = $1", [token]);
    console.log("NFT minted successfully!", minted);
    res.json({ success: true });

  } catch (error) {
    console.error("Minting error:", error);
    res.json({ success: false, error: error.message });
  }
});

app.listen(3000, () => console.log("Server running on port 3000!"));
