// Prisma 7 CLI config: where the schema and migrations live, how to reach the DB, and how to seed.
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  // Migrations need a direct connection. On Neon, DATABASE_URL is the pooled URL (fine for the app's short
  // queries, wrong for migrate's long transactions); DIRECT_DATABASE_URL is the unpooled one. Locally both are the same.
  datasource: { url: process.env["DIRECT_DATABASE_URL"] ?? process.env["DATABASE_URL"] },
});
