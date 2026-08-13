/**
 * SC — one-off backfill of web_3.nft_variants across all NFT products.
 *
 * Shopify requires every product with NFT variants to declare those variant IDs
 * in a metafield. Without it the store does not meet the NFT distribution spec.
 *
 * Run once from Railway:  node backfill-nft-variants.js
 * Safe to re-run: it only writes products that are missing or out of date.
 *
 * Dry run first:  DRY_RUN=true node backfill-nft-variants.js
 */

const fetch = require("node-fetch");
require("dotenv").config();

const { SHOPIFY_CLIENT_ID, SHOPIFY_ACCESS_TOKEN } = process.env;
const SHOP_URL = "stiifcompnft.myshopify.com";
const API_VERSION = "2025-10";
const DRY_RUN = String(process.env.DRY_RUN || "false").toLowerCase() === "true";

async function getToken() {
  const res = await fetch(`https://${SHOP_URL}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept-Encoding": "identity" },
    body: new URLSearchParams({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_ACCESS_TOKEN,
      grant_type: "client_credentials",
    }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token request failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function gql(token, query, variables) {
  const res = await fetch(`https://${SHOP_URL}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
      "Accept-Encoding": "identity",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

const FETCH_PAGE = `
  query($cursor: String) {
    products(first: 50, after: $cursor, query: "product_type:NFT") {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          variants(first: 100) { edges { node { id } } }
          metafield(namespace: "web_3", key: "nft_variants") { value }
        }
      }
    }
  }
`;

const WRITE_METAFIELDS = `
  mutation($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`;

// Shopify expects bare numeric variant IDs, not GIDs.
const bareId = (gid) => String(gid).split("/").pop();

async function main() {
  const token = await getToken();

  let cursor = null;
  let hasNext = true;
  let scanned = 0;
  const pending = [];

  while (hasNext) {
    const data = await gql(token, FETCH_PAGE, { cursor });
    const page = data.products;

    for (const { node } of page.edges) {
      scanned++;
      const variantIds = node.variants.edges.map((v) => bareId(v.node.id));
      const desired = JSON.stringify(variantIds);

      if (node.metafield && node.metafield.value === desired) continue;

      pending.push({
        ownerId: node.id,
        namespace: "web_3",
        key: "nft_variants",
        type: "list.single_line_text_field",
        value: desired,
      });
    }

    hasNext = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
    process.stdout.write(`\rScanned ${scanned} products, ${pending.length} need writing...`);
  }

  console.log(`\nScan complete. ${scanned} NFT products, ${pending.length} to update.`);

  if (DRY_RUN) {
    console.log("DRY RUN — nothing written. Sample of first 3:");
    console.log(JSON.stringify(pending.slice(0, 3), null, 2));
    return;
  }

  if (pending.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  let written = 0;
  const failures = [];

  // metafieldsSet accepts up to 25 per call.
  for (let i = 0; i < pending.length; i += 25) {
    const batch = pending.slice(i, i + 25);
    try {
      const result = await gql(token, WRITE_METAFIELDS, { metafields: batch });
      const errors = result.metafieldsSet.userErrors;
      if (errors.length) {
        failures.push(...errors);
        console.error("\nBatch errors:", JSON.stringify(errors));
      }
      written += result.metafieldsSet.metafields.length;
    } catch (e) {
      failures.push({ message: e.message });
      console.error("\nBatch failed:", e.message);
    }
    process.stdout.write(`\rWritten ${written}/${pending.length}...`);
    await new Promise((r) => setTimeout(r, 600)); // stay inside rate limits
  }

  console.log(`\nDone. ${written} metafields written, ${failures.length} errors.`);
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error("Backfill failed:", e);
  process.exit(1);
});
