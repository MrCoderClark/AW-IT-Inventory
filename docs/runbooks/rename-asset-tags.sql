-- Rename existing asset tags OPUS-* -> H2TECS-* (one-off, part of the OPUS->H2Tecs
-- rebrand). Run ONCE against the inventory DB (aw_it_inventory), AFTER deploying the
-- renamed code (new assets already mint H2TECS- tags via web/src/lib/tags.ts).
--
-- Why a single UPDATE is enough: `assets.tag` is the ONLY durable column that stores
-- a tag string — every other table references assets by the UUID `assets.id`, not the
-- tag. The prefix swap is bijective (OPUS-X -> H2TECS-X), so the unique constraint on
-- `tag` is preserved and there are no collisions.
--
-- NOTE: this does NOT touch physical device labels — re-label hardware separately.
-- The collector still reconciles machines by serial, so scanning keeps working.
--
-- Back up the DB first, then run inside a transaction you can inspect before COMMIT:

BEGIN;

-- How many tags will change (expect your OPUS-era fleet count):
SELECT count(*) AS to_rename FROM assets WHERE tag LIKE 'OPUS-%';

-- Optional preview of the before -> after mapping:
-- SELECT tag AS old_tag, 'H2TECS' || substring(tag FROM 5) AS new_tag
--   FROM assets WHERE tag LIKE 'OPUS-%' ORDER BY tag;

-- The rename: replace the leading "OPUS" (4 chars), keep "-TYPE-SUFFIX".
UPDATE assets
   SET tag = 'H2TECS' || substring(tag FROM 5)
 WHERE tag LIKE 'OPUS-%';

-- Verify: should read still_opus = 0, now_h2tecs = <your fleet count>.
SELECT
  count(*) FILTER (WHERE tag LIKE 'OPUS-%')   AS still_opus,
  count(*) FILTER (WHERE tag LIKE 'H2TECS-%') AS now_h2tecs
FROM assets;

COMMIT;   -- or ROLLBACK if the verify numbers look wrong.
