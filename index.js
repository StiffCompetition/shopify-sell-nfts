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
