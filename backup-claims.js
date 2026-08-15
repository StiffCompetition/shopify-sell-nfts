/**
 * SC — claims table backup.
 *
 * Reads the whole claims table, writes it to CSV, and emails it to you as an
 * attachment via Resend. Read-only against the database.
 *
 * Run from the Railway shell:  node backup-claims.js
 *
 * Send somewhere other than the default:
 *   BACKUP_EMAIL_TO=you@example.com node backup-claims.js
 */

const { Pool } = require("pg");
const fetch = require("node-fetch");
require("dotenv").config();

const { DATABASE_URL, RESEND_API_KEY } = process.env;
const TO = process.env.BACKUP_EMAIL_TO || "hq@stiffcompetition.shop";

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function toCsv(rows) {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);

  const cell = (v) => {
    if (v === null || v === undefined) return "";
    const s = v instanceof Date ? v.toISOString() : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  return [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => cell(r[h])).join(",")),
  ].join("\n");
}

async function main() {
  if (!RESEND_API_KEY) {
    console.error("RESEND_API_KEY is not set — cannot send the backup.");
    process.exit(1);
  }

  const result = await pool.query("SELECT * FROM claims ORDER BY id ASC");
  const rows = result.rows;
  console.log(`Read ${rows.length} rows from claims.`);

  if (rows.length === 0) {
    console.log("Table is empty — nothing to back up.");
    return;
  }

  const csv = toCsv(rows);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const filename = `sc-claims-backup-${stamp}.csv`;

  const claimed = rows.filter((r) => r.claimed).length;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Stiff Competition <hq@stiffcompetition.shop>",
      to: [TO],
      subject: `SC claims backup — ${rows.length} rows — ${stamp.slice(0, 10)}`,
      html: `
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#111;">
          <p><strong>Claims table backup</strong></p>
          <p>
            Rows: ${rows.length}<br>
            Claimed: ${claimed}<br>
            Unclaimed: ${rows.length - claimed}<br>
            Taken: ${new Date().toISOString()}
          </p>
          <p>The CSV is attached. Save it to Google Drive.</p>
        </div>`,
      attachments: [
        {
          filename,
          content: Buffer.from(csv, "utf8").toString("base64"),
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Resend responded ${res.status}: ${await res.text()}`);
  }

  console.log(`Backup emailed to ${TO} as ${filename}`);
}

main()
  .catch((e) => {
    console.error("Backup failed:", e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
