import { Pool } from "pg";
import bcrypt from "bcryptjs";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function seed() {
  console.log("🌱 Seeding database...");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Create demo organization
    await client.query(`
      INSERT INTO organizations (id, name, slug, owner_id, description)
      VALUES (
        '00000000-0000-0000-0000-000000000001',
        'REVAMP Demo',
        'revamp-demo',
        '00000000-0000-0000-0000-000000000010',
        'Demo organization for testing'
      ) ON CONFLICT (slug) DO NOTHING;
    `);

    // Create demo users
    const demoUsers = [
      {
        id: "00000000-0000-0000-0000-000000000010",
        email: "demo@revamp.ai",
        password: "demo1234",
        firstName: "Demo",
        lastName: "Admin",
        role: "admin",
      },
      {
        id: "00000000-0000-0000-0000-000000000011",
        email: "architect@revamp.ai",
        password: "demo1234",
        firstName: "Alex",
        lastName: "Architect",
        role: "architect",
      },
      {
        id: "00000000-0000-0000-0000-000000000012",
        email: "developer@revamp.ai",
        password: "demo1234",
        firstName: "Dev",
        lastName: "Engineer",
        role: "developer",
      },
    ];

    for (const user of demoUsers) {
      const hashedPassword = await bcrypt.hash(user.password, 12);
      await client.query(
        `INSERT INTO users (id, email, password_hash, first_name, last_name, role, organization_id, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, '00000000-0000-0000-0000-000000000001', true)
         ON CONFLICT (email) DO UPDATE SET
           password_hash = $3,
           first_name = $4,
           last_name = $5,
           role = $6,
           is_active = true`,
        [user.id, user.email, hashedPassword, user.firstName, user.lastName, user.role]
      );
    }

    // Create a sample project
    await client.query(`
      INSERT INTO projects (id, organization_id, name, description, status, current_stage, created_by)
      VALUES (
        '00000000-0000-0000-0000-000000000100',
        '00000000-0000-0000-0000-000000000001',
        'Legacy Banking System',
        'Modernize the core banking COBOL application to Java Spring Boot microservices',
        'active',
        'analysis',
        '00000000-0000-0000-0000-000000000010'
      ) ON CONFLICT (id) DO NOTHING;
    `);

    // Add all demo users as project members
    for (const user of demoUsers) {
      const memberRole = user.role === "admin" ? "owner" : "editor";
      await client.query(
        `INSERT INTO project_members (project_id, user_id, role)
         VALUES ('00000000-0000-0000-0000-000000000100', $1, $2)
         ON CONFLICT (project_id, user_id) DO NOTHING`,
        [user.id, memberRole]
      );
    }

    await client.query("COMMIT");
    console.log("✅ Seed completed successfully!");
    console.log("");
    console.log("Demo accounts:");
    console.log("  admin:     demo@revamp.ai / demo1234");
    console.log("  architect: architect@revamp.ai / demo1234");
    console.log("  developer: developer@revamp.ai / demo1234");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Seed failed:", error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
