/**
 * Seed the inventory database from the sample fleet in lib/data.ts.
 * Run with: npm run db:seed
 */

import "dotenv/config";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { ASSETS } from "../lib/data";
import { assetAssignments, assets, people } from "./schema";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see web/.env).");

  const client = postgres(url, {
    ssl: process.env.DB_SSL_REQUIRE === "true" ? "require" : false,
    max: 1,
  });
  const db = drizzle(client, { schema: { assets, people, assetAssignments } });

  // Reset (assignments first, then assets, then people, due to FKs), then reseed.
  await db.delete(assetAssignments);
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

  const insertedAssets = await db
    .insert(assets)
    .values(
      ASSETS.map((a) => ({
        tag: a.id,
        name: a.name,
        type: a.type,
        serial: a.serial,
        model: a.model,
        assigneeId: a.assignee ? idByName.get(a.assignee.name) ?? null : null,
        // Locations are now a managed tree (spec 09); seeded assets start with no
        // location and are assigned on /locations + the asset form.
        status: a.status,
        lastSync: new Date(a.lastSync),
        vendor: a.vendor,
        purchaseDate: a.purchaseDate,
        warrantyUntil: a.warrantyUntil,
        costCenter: a.costCenter,
        spec: a.spec,
      })),
    )
    .returning({ id: assets.id, tag: assets.tag });

  // Open an assignment row for each seeded assignee, so `assigneeId` matches an
  // open custody record (spec 16, AC-11) rather than drifting for demo data.
  const assetIdByTag = new Map(insertedAssets.map((a) => [a.tag, a.id]));
  const assignmentRows = ASSETS.filter((a) => a.assignee).map((a) => ({
    assetId: assetIdByTag.get(a.id)!,
    personId: idByName.get(a.assignee!.name)!,
    assignedAt: new Date(a.lastSync),
    assignedBy: "seed@opus.local",
  }));
  if (assignmentRows.length) {
    await db.insert(assetAssignments).values(assignmentRows);
  }

  console.log(
    `Seeded ${ASSETS.length} assets, ${uniquePeople.size} people, and ${assignmentRows.length} open assignments.`,
  );
  await client.end();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
