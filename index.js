const express = require("express");
const app = express();
const getRawBody = require("raw-body");
const crypto = require("crypto");
const { ThirdwebSDK } = require("@thirdweb-dev/sdk");
const { Shopify, DataType } = require("@shopify/shopify-api");
require("dotenv").config();

const {
  ADMIN_PRIVATE_KEY,
  NFT_COLLECTION_ADDRESS,
  SHOPIFY_SECRET_KEY,
  SHOPIFY_SITE_URL,
  SHOPIFY_ACCESS_TOKEN,
} = process.env;

app.post("/webhooks/orders/create", async (req, res) => {
  console.log("Order event received!");

  const hmac = req.get("X-Shopify-Hmac-Sha256");
  const body = await getRawBody(req);
  const hash = crypto
    .createHmac("sha256", SHOPIFY_SECRET_KEY)
    .update(body, "utf8", "hex")
    .digest("base64");

  if (hash === hmac) {
    const client = new Shopify.Clients.Rest(
      SHOPIFY_SITE_URL,
      SHOPIFY_ACCESS_TOKEN
    );

    const shopifyOrderId = req.get("X-Shopify-Order-Id");
    const response = await client.get({
      type: DataType.JSON,
      path: `/admin/api/2022-07/orders/${shopifyOrderId}.json`,
    });

    const itemsPurchased = response.body.order.line_items;

    const sdk = ThirdwebSDK.fromPrivateKey(
      ADMIN_PRIVATE_KEY,
      "polygon"
    );

    const nftCollection = await sdk.getNFTCollection(NFT_COLLECTION_ADDRESS);

    for (const item of itemsPurchased) {
      const productQuery = await client.get({
        type: DataType.JSON,
        path: `/admin/api/2022-07/products/${item.product_id}.json`,
      });

      // Fetch metafields (traits) for this product
      const metafieldsQuery = await client.get({
        type: DataType.JSON,
        path: `/admin/api/2022-07/products/${item.product_id}/metafields.json`,
      });

      const metafields = metafieldsQuery.body.metafields;

      // Helper to find a metafield value by key
      const getMeta = (key) => {
        const field = metafields.find(
          (m) => m.namespace === "verisart" && m.key === key
        );
        return field ? field.value : "";
      };

      const metadata = {
        name: productQuery.body.product.title,
        description: productQuery.body.product.body_html,
        image: productQuery.body.product.image.src,
        attributes: [
          { trait_type: "Character", value: getMeta("character") },
          { trait_type: "Gimmick", value: getMeta("gimmick") },
          { trait_type: "Inspection Grade", value: getMeta("inspection_grade") },
          { trait_type: "Structural Rigidity", value: getMeta("structural_rigidity") },
          { trait_type: "Innuendo Intensity", value: getMeta("innuendo_intensity") },
          { trait_type: "Friction Force", value: getMeta("friction_force") },
          { trait_type: "Tactical Girth", value: getMeta("tactical_girth") },
          { trait_type: "Expanded Lore", value: getMeta("expanded_lore") },
        ],
      };

      const walletAddress = item.properties.find(
        (p) => p.name === "Wallet Address"
      ).value;

      const minted = await nftCollection.mintTo(walletAddress, metadata);
      console.log("Successfully minted NFT with traits!", minted);
    }

    res.sendStatus(200);
  } else {
    res.sendStatus(403);
  }
});

app.listen(3000, () => console.log("Example app listening on port 3000!"));
