
require("dotenv").config();

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const SCRIPTS_DIR = __dirname;
const MIGRATION_PATTERN = /^\d{3}[-_].+\.sql$/;

async function migrate() {
  const client = await pool.connect();

  try {
    // Keep one migration runner active at a time.
    await client.query(
      "SELECT pg_advisory_lock($1, $2)",
      [2026, 1009]
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        checksum VARCHAR(64),
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const files = (await fs.readdir(SCRIPTS_DIR))
      .filter((file) => MIGRATION_PATTERN.test(file))
      .sort();

    if (files.length === 0) {
      console.log("No migration files found.");
      return;
    }

    const versions = files.map((file) => file.slice(0, 3));

    if (new Set(versions).size !== versions.length) {
      throw new Error("Duplicate migration version detected.");
    }

    for (const file of files) {
      const filePath = path.join(SCRIPTS_DIR, file);
      const sql = await fs.readFile(filePath, "utf8");

      const checksum = crypto
        .createHash("sha256")
        .update(sql)
        .digest("hex");

      const version = file.slice(0, 3);

      await client.query("BEGIN");

      try {
        const result = await client.query(
          `SELECT checksum
           FROM schema_migrations
           WHERE version = $1`,
          [version]
        );

        if (result.rows.length > 0) {
          const previousChecksum = result.rows[0].checksum;

          if (previousChecksum !== checksum) {
            throw new Error(
              `Migration ${version} has changed since it was applied.`
            );
          }

          await client.query("COMMIT");
          console.log(`Skipped: ${file}`);
          continue;
        }

        console.log(`Applying: ${file}`);

        await client.query(sql);

        await client.query(
          `INSERT INTO schema_migrations (version, checksum)
           VALUES ($1, $2)`,
          [version, checksum]
        );

        await client.query("COMMIT");
        console.log(`Applied: ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    console.log("Scrubado migrations complete.");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exitCode = 1;
  } finally {
    try {
      await client.query(
        "SELECT pg_advisory_unlock($1, $2)",
        [2026, 1009]
      );
    } finally {
      client.release();
      await pool.end();
    }
  }
}

migrate().catch((error) => {
  console.error("Unexpected migration error:", error);
  process.exitCode = 1;
  pool.end().catch(console.error);
});