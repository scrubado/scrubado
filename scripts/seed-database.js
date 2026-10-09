
require("dotenv").config();

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function seedDatabase() {
  // Safety: never run destructive seeding accidentally.
  if (process.env.NODE_ENV !== "development") {
    throw new Error(
      "Database seeding is restricted to development."
    );
  }

  if (process.env.ALLOW_DESTRUCTIVE_SEED !== "true") {
    throw new Error(
      "Set ALLOW_DESTRUCTIVE_SEED=true to allow database reset."
    );
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    console.log("Seeding Scrubado database...");

    // Clear seedable data in dependency-safe order.
    await client.query("DELETE FROM bookings");
    await client.query("DELETE FROM cleaner_availability");
    await client.query("DELETE FROM customer_profiles");
    await client.query("DELETE FROM cleaner_profiles");
    await client.query("DELETE FROM services");
    await client.query("DELETE FROM users");

    // Customer user
    const customerUserResult = await client.query(
      `
      INSERT INTO users (
        email,
        password_hash,
        role,
        first_name,
        last_name,
        phone
      )
      VALUES ($1, $2, 'CUSTOMER', $3, $4, $5)
      RETURNING id;
      `,
      [
        "customer@scrubado.local",
        "seed-only-no-login",
        "Test",
        "Customer",
        "4015550101"
      ]
    );

    const customerUserId = customerUserResult.rows[0].id;

    // Cleaner user
    const cleanerUserResult = await client.query(
      `
      INSERT INTO users (
        email,
        password_hash,
        role,
        first_name,
        last_name,
        phone
      )
      VALUES ($1, $2, 'CLEANER', $3, $4, $5)
      RETURNING id;
      `,
      [
        "cleaner@scrubado.local",
        "seed-only-no-login",
        "Jamie",
        "Cleaner",
        "4015550102"
      ]
    );

    const cleanerUserId = cleanerUserResult.rows[0].id;

    // Customer profile
    const customerProfileResult = await client.query(
      `
      INSERT INTO customer_profiles (
        user_id,
        address_line1,
        city,
        state,
        postal_code,
        country,
        notes
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id;
      `,
      [
        customerUserId,
        "123 Sample St",
        "Pawtucket",
        "RI",
        "02860",
        "US",
        "Seed customer profile"
      ]
    );

    const customerProfileId = customerProfileResult.rows[0].id;

    // Cleaner profile
    const cleanerProfileResult = await client.query(
      `
      INSERT INTO cleaner_profiles (
        user_id,
        bio,
        service_radius_miles,
        hourly_rate,
        years_experience,
        is_verified,
        accepts_new_jobs
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id;
      `,
      [
        cleanerUserId,
        "Reliable residential cleaner for Scrubado seed testing.",
        20,
        35.00,
        4,
        true,
        true
      ]
    );

    const cleanerProfileId = cleanerProfileResult.rows[0].id;

    // Services
    const servicesResult = await client.query(
      `
      INSERT INTO services (
        name,
        description,
        base_price,
        estimated_minutes
      )
      VALUES
        ($1, $2, $3, $4),
        ($5, $6, $7, $8),
        ($9, $10, $11, $12)
      RETURNING id, name;
      `,
      [
        "Standard Cleaning",
        "General residential cleaning for kitchens, bathrooms, bedrooms, and common areas.",
        95.00,
        120,

        "Deep Cleaning",
        "Detailed top-to-bottom cleaning for homes that need extra attention.",
        165.00,
        240,

        "Move-Out Cleaning",
        "Cleaning service designed for empty homes and apartments before turnover.",
        220.00,
        300
      ]
    );

    const standardCleaning = servicesResult.rows.find(
      (service) => service.name === "Standard Cleaning"
    );

    // Cleaner availability
    await client.query(
      `
      INSERT INTO cleaner_availability (
        cleaner_id,
        available_date,
        start_time,
        end_time,
        is_available
      )
      VALUES
        ($1, CURRENT_DATE + 1, '09:00', '12:00', TRUE),
        ($1, CURRENT_DATE + 1, '13:00', '17:00', TRUE),
        ($1, CURRENT_DATE + 2, '10:00', '15:00', TRUE);
      `,
      [cleanerProfileId]
    );

    // Sample booking
    await client.query(
      `
      INSERT INTO bookings (
        customer_id,
        cleaner_id,
        service_id,
        scheduled_date,
        start_time,
        end_time,
        address_line1,
        city,
        state,
        postal_code,
        country,
        status,
        quoted_price,
        customer_notes
      )
      VALUES (
        $1,
        $2,
        $3,
        CURRENT_DATE + 1,
        '09:00',
        '11:00',
        $4,
        $5,
        $6,
        $7,
        $8,
        'accepted',
        $9,
        $10
      );
      `,
      [
        customerProfileId,
        cleanerProfileId,
        standardCleaning.id,
        "123 Sample St",
        "Pawtucket",
        "RI",
        "02860",
        "US",
        95.00,
        "Please focus on kitchen and bathroom."
      ]
    );

    await client.query("COMMIT");

    console.log("Scrubado database seed complete.");
    console.log("Created:");
    console.log("- 1 customer");
    console.log("- 1 cleaner");
    console.log("- 3 services");
    console.log("- 3 availability windows");
    console.log("- 1 sample booking");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Database seed failed:", error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

seedDatabase().catch((error) => {
  console.error("Database seed aborted:", error.message);
  process.exitCode = 1;
  pool.end().catch(console.error);
});