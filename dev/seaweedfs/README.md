# Local dev object store (OPUS asset images, spec 17.02)

A local, S3-compatible object store for developing the asset image upload feature
(child 02 of the spec 17 redesign). Uses **SeaweedFS** with static dev credentials,
so there is no init step: bring it up and the S3 API is live on `:8333`. The web
app's `ensureBucket()` creates the bucket on the first upload.

> **Dev only.** The credentials in `s3.json` are throwaway local keys. Never use
> this compose file or these keys for anything real. A real deployment gets its own
> S3-compatible store (SeaweedFS or Garage) and its own secrets.

## Run it

Requires Docker Desktop **running** (wait for "Engine running"; if `docker`
commands hang, the engine is not up yet).

```bash
cd dev/seaweedfs
docker compose up -d      # or: docker compose up   (first run, to watch the image pull)
```

Stop it with `docker compose down` (add `-v` to also wipe the stored images).

## Point OPUS at it

Add to `web/.env`:

```
S3_ENDPOINT=http://localhost:8333
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=opusdev
S3_SECRET_ACCESS_KEY=opusdevsecret123
S3_BUCKET=opus-assets
```

Then apply the DB column and restart the web dev server:

```bash
cd web
npm run db:push          # adds assets.image_key
npm run dev
```

Upload a photo on any asset's detail page to verify, or run
`/check verify opus ui redesign`.
