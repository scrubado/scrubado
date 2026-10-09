require("dotenv").config();

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function setupDatabase() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT,
        role VARCHAR(50) NOT NULL CHECK (role IN ('customer', 'cleaner', 'admin')),
        first_name VARCHAR(100),
        last_name VARCHAR(100),
        phone VARCHAR(50),
        status VARCHAR(50) NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'inactive', 'suspended')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        address_line1 VARCHAR(255),
        address_line2 VARCHAR(255),
        city VARCHAR(120),
        state VARCHAR(120),
        postal_code VARCHAR(30),
        country VARCHAR(80) DEFAULT 'US',
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS cleaner_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        bio TEXT,
        service_radius_miles INTEGER,
        hourly_rate NUMERIC(10,2),
        years_experience INTEGER,
        is_verified BOOLEAN NOT NULL DEFAULT FALSE,
        accepts_new_jobs BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS services (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(120) UNIQUE NOT NULL,
        description TEXT,
        base_price NUMERIC(10,2),
        estimated_minutes INTEGER,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS cleaner_availability (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        cleaner_id UUID NOT NULL REFERENCES cleaner_profiles(id) ON DELETE CASCADE,
        available_date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        is_available BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT valid_availability_window CHECK (end_time > start_time),
        CONSTRAINT unique_cleaner_availability
          UNIQUE (cleaner_id, available_date, start_time, end_time)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id UUID NOT NULL REFERENCES customer_profiles(id) ON DELETE RESTRICT,
        cleaner_id UUID REFERENCES cleaner_profiles(id) ON DELETE SET NULL,
        service_id UUID NOT NULL REFERENCES services(id) ON DELETE RESTRICT,

        scheduled_date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME,

        address_line1 VARCHAR(255) NOT NULL,
        address_line2 VARCHAR(255),
        city VARCHAR(120) NOT NULL,
        state VARCHAR(120) NOT NULL,
        postal_code VARCHAR(30) NOT NULL,
        country VARCHAR(80) DEFAULT 'US',

        status VARCHAR(50) NOT NULL DEFAULT 'requested'
          CHECK (
            status IN (
              'requested',
              'accepted',
              'confirmed',
              'in_progress',
              'completed',
              'cancelled',
              'declined'
            )
          ),

        quoted_price NUMERIC(10,2),
        customer_notes TEXT,
        cleaner_notes TEXT,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_email
      ON users(email);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_role
      ON users(role);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cleaner_availability_cleaner_date
      ON cleaner_availability(cleaner_id, available_date);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bookings_customer
      ON bookings(customer_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bookings_cleaner
      ON bookings(cleaner_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bookings_status
      ON bookings(status);
    `);

    await client.query("COMMIT");

    console.log("Scrubado database setup complete.");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Database setup failed:", error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

setupDatabase();