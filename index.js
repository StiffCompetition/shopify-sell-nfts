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
      claimed BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log("Database ready!");
}
initDB();

async function getShopifyToken() {
  const shopUrl = SHOPIFY_SITE_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const response = await fetch(`https://${shopUrl}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body:
