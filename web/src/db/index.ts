import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set (see web/.env).");
}

// Reuse one client across hot reloads in dev to avoid exhausting connections.
const globalForDb = globalThis as unknown as {
  _pgClient?: ReturnType<typeof postgres>;
};

const client =
  globalForDb._pgClient ??
  postgres(url, {
    ssl: process.env.DB_SSL_REQUIRE === "true" ? "require" : false,
    max: 10,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb._pgClient = client;
}

export const db = drizzle(client, { schema });
