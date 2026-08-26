/**
 * Seed the inventory database from the sample fleet in lib/data.ts.
 * Run with: npm run db:seed
 */

import "dotenv/config";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { ASSETS } from "../lib/data";
import { assets, people } from "./schema";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see web/.env).");

  const client = postgres(url, {
    ssl: process.env.DB_SSL_REQUIRE === "true" ? "require" : false,
    max: 1,
  });
  const db = drizzle(client, { schema: { assets, people } });

  // Reset (assets first due to FK), then reseed.
  await db.delete(assets);
  await db.delete(people);

  // Unique assignees -> people.
  const uniquePeople = new Map<string, { name: string; initials: string }>();
  for (const a of ASSETS) {
    if (a.assignee) uniquePeople.set(a.assignee.name, a.assignee);
  }
  const insertedPeople = uniquePeople.size
    ? await db
        .insert(people)
        .values([...uniquePeople.values()])
        .returning()
    : [];
  const idByName = new Map(insertedPeople.map((p) => [p.name, p.id]));

  await db.insert(assets).values(
    ASSETS.map((a) => ({
      tag: a.id,
      name: a.name,
      type: a.type,
      serial: a.serial,
      model: a.model,
      assigneeId: a.assignee ? idByName.get(a.assignee.name) ?? null : null,
      location: a.location,
      status: a.status,
      lastSync: new Date(a.lastSync),
      vendor: a.vendor,
      purchaseDate: a.purchaseDate,
      warrantyUntil: a.warrantyUntil,
      costCenter: a.costCenter,
      spec: a.spec,
    })),
  );

  console.log(
    `Seeded ${ASSETS.length} assets and ${uniquePeople.size} people.`,
  );
  await client.end();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
