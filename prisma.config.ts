// Prisma 7 CLI config: where the schema and migrations live, how to reach the DB, and how to seed.
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: { url: process.env["DATABASE_URL"] },
});
