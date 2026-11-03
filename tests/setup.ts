// Runs before every test file. Points DATABASE_URL at the test database and refuses to run otherwise,
// because tests/db.ts truncates every table.
import { config } from "dotenv";

config({ path: ".env.test", override: true });

const url = process.env.DATABASE_URL ?? "";
if (!/_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run tests: DATABASE_URL does not end in "_test" (got "${url}")`);
}
