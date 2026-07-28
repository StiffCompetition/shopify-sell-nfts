const express = require("express");
const app = express();
const getRawBody = require("raw-body");
const crypto = require("crypto");
const { ThirdwebSDK } = require("@thirdweb-dev/sdk");
const { PrivyClient } = require("@privy-io/node");
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
  PRIVY_APP_ID,
  PRIVY_APP_SECRET,
} = process.env;

const privy = new PrivyClient({
  appId: PRIVY_APP_ID,
  appSecret: PRIVY_APP_SECRET,
});

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

// Create or retrieve Privy wallet for a given email
async function getOrCreatePrivyWallet(email) {
  // Try to find existing Privy user by email
  try {
    const existingUser = await privy.getUserByEmail(email);
    if (existingUser) {
      const existingWallet = existingUser.linkedAccounts.find(a => a.type === 'wallet' && a.chainType === 'ethereum');
      if (existingWallet && existingWallet.address) {
        console.log(`Found existing Privy wallet for ${email}: ${existingWallet.address}`);
        return existingWallet.address;
      }
    }
  } catch (e) {
    console.log(`No existing Privy user found for ${email}, creating new one`);
  }

  // Create new Privy user with email and Ethereum wallet
  const newUser = await privy.importUser({
    linkedAccounts: [{ type: 'email', address: email }],
    createEthereumWallet: true,
  });

  const wallet = newUser.linkedAccounts.find(a => a.type === 'wallet' && a.chainType === 'ethereum');
  if (!wallet || !wallet.address) {
    throw new Error('Privy wallet creation failed — no wallet address returned');
  }

  console.log(`Created new Privy wallet for ${email}: ${wallet.address}`);
  return wallet.address;
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

// Step 1: Send OTP via Thirdweb
app.post("/claim/order/:orderId/send-otp", express.json(), async (req, res) => {
  const { email } = req.body;
  if (!email) return res.json({ success: false, error: "Email required" });
  try {
    const response = await fetch("https://api.thirdweb.com/v1/auth/initiate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-secret-key": THIRDWEB_SECRET_KEY,
      },
      body: JSON.stringify({ method: "email", email }),
    });
    const data = await response.json();
    console.log("OTP send response:", JSON.stringify(data));
    if (data.message && data.message.toLowerCase().includes('invalid')) {
      return res.json({ success: false, error: "Could not send verification code — please try again" });
    }
    res.json({ success: true });
  } catch (error) {
    console.error("OTP send error:", error);
    res.json({ success: false, error: error.message });
  }
});

// Step 2: Verify OTP via Thirdweb, then create Privy wallet
app.post("/claim/order/:orderId/verify-otp", express.json(), async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.json({ success: false, error: "Email and code required" });
  try {
    // Verify OTP with Thirdweb
    const response = await fetch("https://api.thirdweb.com/v1/auth/complete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-secret-key": THIRDWEB_SECRET_KEY,
      },
      body: JSON.stringify({ method: "email", email, code }),
    });
    const data = await response.json();
    console.log("OTP verify response:", JSON.stringify(data));

    // Check for explicit error in response
    if (data.message || data.error) {
      const msg = data.message || data.error;
      console.log("OTP verification failed:", msg);
      return res.json({ success: false, error: "Invalid code — please check your email and try again" });
    }

    // Create or retrieve Privy wallet for this email
    const walletAddress = await getOrCreatePrivyWallet(email);
    res.json({ success: true, walletAddress });

  } catch (error) {
    console.error("OTP verify/wallet error:", error);
    res.json({ success: false, error: error.message });
  }
});

app.get("/claim/order/:orderId", async (req, res) => {
  const { orderId } = req.params;
  const result = await pool.query("SELECT * FROM claims WHERE order_id = $1 AND claimed = FALSE", [orderId]);
  if (result.rows.length === 0) {
    return res.send("<h1>Invalid or already claimed</h1>");
  }
  const claims = result.rows;

  const shopUrl = 'stiifcompnft.myshopify.com';
  const shopifyToken = await getShopifyToken();

  const itemNames = [];
  for (const claim of claims) {
    const productResponse = await fetchWithRetry(`https://${shopUrl}/admin/api/2024-01/products/${claim.product_id}.json`, {
      headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' }
    });
    const productData = await productResponse.json();
    console.log("Product response on claim page:", JSON.stringify(productData));
    itemNames.push(productData.product ? productData.product.title : 'Stiff Competition NFT');
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
        button:disabled { background: #999; cursor: not-allowed; }
        .or { margin: 15px 0; color: #999; }
        .message { margin-top: 20px; padding: 15px; border-radius: 4px; line-height: 1.6; }
        .success { background: #d4edda; color: #155724; }
        .error { background: #f8d7da; color: #721c24; }
        .info { background: #d1ecf1; color: #0c5460; }
        ul.items { text-align: left; margin: 15px 0; padding-left: 20px; }
        .nft-link { display: block; margin: 8px 0; }
        .hidden { display: none; }
      </style>
    </head>
    <body>
      <img src="https://res.cloudinary.com/dkapdtxek/image/upload/SC_small.svg" alt="Stiff Competition" style="max-width: 200px; margin-bottom: 20px;" />
      <h1>🎉 Claim Your ${itemCountText}</h1>
      <p>You've purchased ${itemCountText} from Stiff Competition! Choose how you'd like to receive ${claims.length === 1 ? 'it' : 'them'}.</p>
      <ul class="items">${itemListHtml}</ul>

      <div id="step-choose">
        <h3>I have a crypto wallet</h3>
        <input type="text" id="walletAddress" placeholder="Enter your wallet address (0x...)" />
        <button onclick="claimWithWallet()">Claim to My Wallet</button>
        <div class="or">— OR —</div>
        <h3>Create a free wallet with my email</h3>
        <p style="font-size:13px;color:#555;">No crypto knowledge needed. We'll create a secure digital wallet for you and send your NFT to it automatically. You'll receive a verification code by email.</p>
        <input type="email" id="emailAddress" placeholder="Enter your email address" />
        <button onclick="sendOTP()">Send Verification Code</button>
      </div>

      <div id="step-otp" class="hidden">
        <h3>Check your email</h3>
        <p id="otp-message"></p>
        <input type="text" id="otpCode" placeholder="Enter your 6-digit code" maxlength="6" style="letter-spacing:6px;font-size:20px;text-align:center;" />
        <button onclick="verifyOTP()">Verify & Claim My NFT</button>
        <button onclick="backToStart()" style="background:#555;margin-top:5px;">← Back</button>
      </div>

      <div id="message"></div>

      <script>
        let pendingEmail = '';

        async function claimWithWallet() {
          const wallet = document.getElementById('walletAddress').value.trim();
          if (!wallet) { showMessage('Please enter your wallet address', 'error'); return; }
          await submitClaim(wallet, null);
        }

        async function sendOTP() {
          const email = document.getElementById('emailAddress').value.trim();
          if (!email) { showMessage('Please enter your email address', 'error'); return; }
          pendingEmail = email;
          disableButtons(true);
          showMessage('Sending your verification code...', 'info');
          const response = await fetch('/claim/order/${orderId}/send-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
          });
          const data = await response.json();
          disableButtons(false);
          if (data.success) {
            document.getElementById('step-choose').classList.add('hidden');
            document.getElementById('step-otp').classList.remove('hidden');
            document.getElementById('otp-message').textContent = 'We sent a 6-digit verification code to ' + email + '. Please check your inbox (and spam folder). The code expires in 10 minutes.';
            showMessage('', null);
          } else {
            showMessage('Could not send code: ' + data.error, 'error');
          }
        }

        async function verifyOTP() {
          const code = document.getElementById('otpCode').value.trim();
          if (!code || code.length < 6) { showMessage('Please enter the 6-digit code from your email', 'error'); return; }
          disableButtons(true);
          showMessage('Verifying your code...', 'info');
          const verifyResponse = await fetch('/claim/order/${orderId}/verify-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: pendingEmail, code })
          });
          const verifyData = await verifyResponse.json();
          if (!verifyData.success) {
            disableButtons(false);
            showMessage(verifyData.error || 'Invalid code — please try again', 'error');
            return;
          }
          showMessage('Code verified! Minting your NFT — this may take up to 2 minutes, please do not close this page...', 'info');
          await submitClaim(verifyData.walletAddress, pendingEmail);
        }

        async function submitClaim(walletAddress, email) {
          disableButtons(true);
          const response = await fetch('/claim/order/${orderId}/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ walletAddress, email })
          });
          const data = await response.json();
          if (data.success) {
            const links = data.items.map(item =>
              '<a class="nft-link" href="' + item.openseaUrl + '" target="_blank" style="color:#155724;font-weight:bold;">' + item.name + ' — View on OpenSea ↗</a>'
            ).join('');
            const walletMsg = email
              ? '<br><br><strong>Your free wallet has been created!</strong><br>Visit <a href="https://home.privy.io" target="_blank" style="color:#155724;font-weight:bold;">home.privy.io</a> and sign in with <strong>' + email + '</strong> to access your wallet and manage your NFT.'
              : '';
            showMessage('🎉 Your NFT' + (data.items.length > 1 ? 's have' : ' has') + ' been minted and sent to your wallet!' + walletMsg + '<br><br>' + links, 'success');
            document.getElementById('step-choose').classList.add('hidden');
            document.getElementById('step-otp').classList.add('hidden');
          } else {
            disableButtons(false);
            showMessage('Something went wrong: ' + data.error, 'error');
          }
        }

        function backToStart() {
          document.getElementById('step-choose').classList.remove('hidden');
          document.getElementById('step-otp').classList.add('hidden');
          document.getElementById('otpCode').value = '';
          showMessage('', null);
        }

        function disableButtons(disabled) {
          document.querySelectorAll('button').forEach(b => b.disabled = disabled);
        }

        function showMessage(msg, type) {
          const el = document.getElementById('message');
          el.className = 'message' + (type ? ' ' + type : '');
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
