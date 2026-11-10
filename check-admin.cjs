const bcrypt = require("bcryptjs");
const pool = require("./src/db");

(async () => {
  const result = await pool.query(
    "SELECT password_hash, role, status FROM users WHERE email = $1",
    ["pawtucketcoder@gmail.com"]
  );

  const user = result.rows[0];

  if (!user) {
    console.log("ACCOUNT NOT FOUND");
    return;
  }

  console.log("Role:", user.role);
  console.log("Status:", user.status);
  console.log("Password hash valid:", /^\$2[aby]\$\d{2}\$/.test(user.password_hash));

  const password = process.env.ADMIN_TEST_PASSWORD;
  if (!password) {
    console.log("Password comparison not performed");
    return;
  }

  console.log("Password matches:", await bcrypt.compare(password, user.password_hash));
})()
.catch(error => {
  console.error("Database check failed:", error.code || error.message);
})
.finally(() => pool.end());
