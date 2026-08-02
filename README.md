# Pill ID

An experimental **pilot/MVP** web app that suggests possible matches for a pill
image. A frozen **DINOv2-large** backbone extracts image features, a trained
projection head maps them to a 512-d embedding, and the embedding is compared
(cosine similarity) against a gallery of **9,804 reference embeddings across
4,902 pill classes**. The top matches (NDC label codes) are returned with the
best-matching reference image.

> ⚠️ **Not for medical use.** Results are suggested possible matches only and may
> be wrong. Never rely on this tool to identify medication. Always confirm with a
> pharmacist, physician, or official packaging.

## Version 3 UI (`/v3`)

A third frontend UI, separate from `/v1` and `/v2` (same backend, own routes
under `frontend/src/app/v3/` and `frontend/src/components/v3/`), focused on
day-to-day usability rather than the pilot/research instrumentation in `/v1`
and `/v2`. Carries forward every v2 feature (schedule, Beers/interaction
safety checks, QR passport, survey export) plus the additions below, grouped
into five tabs instead of growing the nav 1:1 — v2's own shell (`MainApp.tsx`)
never actually wired `Scheduler.tsx`/`SafetyReport.tsx`/`QRPassport.tsx` into
its Schedule/Safety/Passport tabs (those showed hardcoded mock content
instead); v3 is the first place they run against real data.

- **Scan** — a single "Take or Upload Photo" button (a plain file input with
  no `capture` attribute, so mobile browsers show their native Camera/Photo
  Library/Files picker) followed by the same crop-and-rotate flow as `/v1`
  (`react-image-crop`'s draggable/resizable rectangle, no pinch/zoom). An
  earlier version used a live camera preview plus pinch-to-zoom on a canvas
  redrawn every pointer move, which crashed on some mobile browsers under
  that load — replaced outright with `/v1`'s lighter, already-proven
  mechanism rather than patched. A brightness default from Settings is
  applied once at crop time, not live. Shows your scanned photo next to the
  top match for a visual sanity check, and defaults to 10 matches
  (configurable down to 6 in Settings). If the right pill isn't in the
  results, an inline "Search by appearance" panel with illustrated
  dropdowns (color swatches, drawn shape icons, score-line diagrams) lets
  you filter by color/shape/imprint/score marks instead — a backup, not the
  primary flow. Shape and score-mark data isn't populated in
  `ndc_names.json` yet (0 of 4,100 entries as of this writing — see below),
  so those two filters will come back empty until `build_ndc_names.py` is
  rerun; color and imprint are populated for ~94% of entries and work now.
- **My Pills** — save a photo of your own pill under a medication name (found
  either by typing the name or by photographing the bottle label, which is
  OCR'd server-side via `POST /api/ocr-label` and matched against the same
  drug-name catalog). Later, the tab re-fetches what that medication
  currently looks like on file and flags any changed imprint/color/shape —
  e.g. after a manufacturer or supplier change — with a one-tap message you
  can copy to send a pharmacist. All of this (personal photos, settings) is
  stored only in the browser's IndexedDB; nothing is uploaded to an account
  or persisted server-side, and there's no login. This app has no IRB review
  and isn't a HIPAA-covered entity's system — see the in-app Settings privacy
  note before pointing it at real patient data.
- **Care** — Schedule (morning/noon/night, via `Scheduler.tsx`) and Safety
  (Beers Criteria + drug-interaction flags against your schedule, via
  `SafetyReport.tsx`) as two views in one tab. Each Scan result also gets
  one-tap "add to schedule" buttons, and the top match is safety-checked
  immediately after a scan.
- **Share** — QR Health Passport (`QRPassport.tsx`, scan-off-the-screen +
  PDF summary) and an Export view (per-session scan token + the clinician/
  usability survey links) as two views in one tab.
- **Settings** — default capture brightness, number of scan results (6–10,
  defaults to 10), text size, and a "replay tutorial" control for the
  first-run onboarding overlay.

New backend endpoints backing this (`backend/app/main.py`): `GET /api/search`
(name lookup), `GET /api/search-by-attributes` (shape/color/imprint/score
filter), `POST /api/ocr-label` (bottle-label OCR via `pytesseract` +
`tesseract-ocr`, see `backend/app/ocr.py` and the Dockerfile). None of these
persist an uploaded image; each request is processed in memory and discarded.
`backend/app/catalog.py` builds the name/attribute index once at startup from
the same reference-image labels + `ndc_names.json` the classifier already
loads — no new data source. Shape/score-mark fields are best-effort (see the
comment in `backend/scripts/build_ndc_names.py`); older `ndc_names.json`
entries just won't match those two filters.

**If `/api/search`, `/api/search-by-attributes`, or `/api/ocr-label` return
literally "Not Found":** that's FastAPI's default body for a URL that
matches no route at all, not this app's own empty-result message (which
says "No matches found"/"No matches for those filters"). It means the
running backend predates these endpoints — redeploy it from the latest
commit on this branch. The frontend now detects this specific case and
shows an actionable message instead of the raw "Not Found" text.

## Multi-database expansion (OTC pills, many manufacturers)

`notebooks/Backup_New_phase_2_model_2_multi_database.ipynb` extends the
retrieval gallery beyond the 4,902 ePillID classes with over-the-counter
products harvested live from DailyMed (NIH/FDA's structured product labeling
database), covering many different manufacturers of the same generic drug
(e.g. store-brand vs. brand-name ibuprofen).

### Why one data swap covers every feature, not just image scanning

Every backend feature reads from the *same four in-memory objects*, built
once at startup in `main.py`'s `lifespan()` and never duplicated or
special-cased per feature:

| Object | Built from | Used by |
|---|---|---|
| `classifier` (embeddings + `label_strings`) | `best_projection_head.pt` + `deployed_ref_embeddings.pt` | `POST /api/predict` (photo scan) |
| `ref_store` | `ePillID_data.zip` + `otc_reference_images.zip` | thumbnails for all of the above |
| `drug_names` | `backend/app/data/ndc_names.json` | name/imprint/color/shape lookups |
| `catalog` (built from the three above) | — | `GET /api/search` (manual/"add a medication" name search), `GET /api/search-by-attributes` (appearance filters), `POST /api/ocr-label` (bottle-label OCR matching) |

There's no per-feature ePillID-only code path to find and fix — `catalog.py`
just iterates whatever is in `label_strings` (see `classifier.py`), and the
frontend never filters by source. **So the only thing standing between you
and "everything" including DailyMed OTC pills is whether these four files on
disk actually contain the merged data.** Once they do, pill scanning, manual
drug search, "add a medication" in My Pills, the appearance-filter backup,
and bottle-label OCR all pick it up automatically, with no code changes.

### Steps to actually do it

1. **Run the notebook in Google Colab** (needs a GPU and live internet
   access to `dailymed.nlm.nih.gov` — this sandbox's network policy blocks
   both, so this step can't be done from here; it has to run in your own
   Colab). Run cells 0–13 first (the existing ePillID pipeline — this
   populates `head_aug`, `ref_feat_448`, `N_CLASSES`, `ref_df`, etc. that
   the V3 cells depend on), then run the whole "V3: MULTI-DATABASE
   EXPANSION" section (cells V3.0–V3.11) in order. Expect this to take a
   while — it's making real HTTP requests to DailyMed for each seed drug
   name, downloading images, and running CLIP + DINOv2 over all of them.
2. **Check cell V3.8's printed accuracy** before trusting the result — it
   reports ePillID top-k (should be roughly unchanged, a regression check)
   and OTC top-k (the actual new-capability number) separately.
3. **Download the four files** cell V3.9/V3.10 writes to
   `RUN_DIR_MAIN/merged_multi_db_export/`:
   `best_projection_head.pt`, `deployed_ref_embeddings.pt`,
   `otc_reference_images.zip`, `ndc_names.json`.
4. **Replace the corresponding files in this repo:**
   - `dinov2_projection_head/best_projection_head.pt`
   - `dinov2_projection_head/deployed_ref_embeddings.pt`
   - `otc_reference_images.zip` at the repo root, next to `ePillID_data.zip`
   - `backend/app/data/ndc_names.json`
5. **Commit and push.** `.gitattributes` routes `*.pt` and `*.zip` through
   Git LFS (needs `git lfs install` once locally if you don't have it) —
   `deployed_ref_embeddings.pt` grows roughly with the number of reference
   images, so a large OTC harvest can push it well past ePillID's ~21 MB.
6. **Redeploy the backend** (rebuild/restart wherever it's hosted — the
   Docker image, EC2 service, etc.). It only loads these files at process
   startup; pushing to git alone doesn't reload a running server.
7. **Verify with `GET /api/health`** — `num_reference_pills` and
   `num_catalog_entries` should both be higher than the ePillID-only
   baseline (9,804 reference images / 4,902 classes; 4,100 catalog
   entries). If they're unchanged, the redeploy didn't pick up the new
   files — check `MODEL_ARTIFACTS_DIR`/`DATASET_ZIP_PATH` in `.env` point
   at this repo checkout and that the deploy actually restarted the
   process (not just redeployed old container layers).

The OTC zip and `ndc_names.json` are optional at boot (see
`OTC_DATASET_ZIP_PATH` in `.env.example`) — the app still runs fine without
them, it just serves ePillID-only results everywhere until step 6 is done.
Actual OTC accuracy (this repo targets 90%+ top-5 / near-100% top-10 on the
combined gallery) can only be measured by actually running the notebook,
since it depends on how many manufacturer photos DailyMed returns at
harvest time — see step 2.

## Architecture

```
┌──────────────────────┐         HTTPS          ┌────────────────────────────┐
│  frontend/ (Next.js) │  ───── /api/* ───────▶ │  backend/ (FastAPI)        │
│  → deploys to Vercel │                        │  DINOv2 + projection head  │
│  upload UI + results │ ◀──── JSON + images ── │  → deploys to EC2 (Spot)   │
└──────────────────────┘                        └────────────────────────────┘
```

The model can't run on Vercel (serverless size/memory/time limits vs. a >1 GB
PyTorch model), so inference lives on a persistent backend that keeps the model
warm in memory. The frontend is a thin client that can be hosted anywhere.

## Repo layout

| Path | What |
|------|------|
| `backend/` | FastAPI inference service (model, reference-image serving, drug-name lookup) |
| `backend/app/data/ndc_names.json` | Precomputed NDC → drug name/imprint/color table (from NIH RxNav) |
| `frontend/` | Next.js app: landing page at `/`, original UI at `/v1`, new UI at `/v2`, usability-focused UI at `/v3` — all call the same backend |
| `deploy/` | Docker Compose + Caddy (auto-HTTPS) + systemd for EC2 |
| `dinov2_projection_head/`, `config.json` | Trained model artifacts |
| `ePillID_data.zip` | Reference image dataset (Git LFS) |
| `deploy_model.py`, `gui_app.py`, `my_app.py` | Original scripts (kept for reference) |

## Run locally

**1. Backend** (loads the model; first run downloads the DINOv2 backbone ~1.2 GB):

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Health check: <http://localhost:8000/api/health> → `{"status":"ok",...}`.
On Apple Silicon it auto-selects the `mps` GPU; otherwise CPU (~1–3 s/image).

**2. Frontend:**

```bash
cd frontend
npm install
cp .env.local.example .env.local   # NEXT_PUBLIC_API_URL=http://localhost:8000
npm run dev
```

Open <http://localhost:3000> for the landing page, which links to **`/v1`**
(original UI) and **`/v2`** (new UI). Both call the same backend via
`NEXT_PUBLIC_API_URL`.

### Configuration

- **Backend** (`backend/.env`, see `.env.example`): `DEVICE` (`auto`/`cpu`/`mps`/`cuda`),
  `TOP_K`, `CORS_ORIGINS`, `MODEL_ARTIFACTS_DIR`, `DATASET_ZIP_PATH`.
- **Frontend** (`frontend/.env.local`): `NEXT_PUBLIC_API_URL` — the backend's base URL
  (e.g. a Cloudflare Tunnel URL), shared by both `/v1` and `/v2`.

### Drug names

Predictions are enriched with a human-readable drug name (plus imprint code and
color) resolved from the NDC in each matched reference image's filename. These
are **precomputed offline** into `backend/app/data/ndc_names.json` (committed), so
lookups are instant with no runtime network dependency. Currently **4,100 of
4,830** reference NDCs resolve (~85%); the rest are obsolete/unlisted and fall
back to showing the NDC code. To (re)generate or extend the table:

```bash
cd backend
PYTHONPATH=. .venv/bin/python -u scripts/build_ndc_names.py   # resumable; rerun to retry misses
```

## Deploy (pilot)

### Frontend → Vercel

Import the repo in Vercel, set **Root Directory = `frontend`**, and add env var
`NEXT_PUBLIC_API_URL=https://api.your-domain.com` (your backend's HTTPS URL,
e.g. a Cloudflare Tunnel URL).

### Backend → EC2 Spot

Built for a warm-in-memory service on a persistent VM (Spot + auto-recovery).

1. Launch a Spot instance with ≥ 8 GB RAM (e.g. `t4g.large`), install Docker,
   open ports 80/443.
2. Point a DNS record (`api.your-domain.com`) at the instance and set that
   hostname in `deploy/Caddyfile`; set your Vercel origin in
   `CORS_ORIGINS` in `deploy/docker-compose.yml`.
3. Copy the repo to `/opt/pill-id` (include the LFS dataset zip), then:
   ```bash
   sudo cp deploy/pill-id.service /etc/systemd/system/
   sudo systemctl enable --now pill-id
   ```

**Auto-recovery:** containers use `restart: unless-stopped`; the systemd unit
brings the stack up on boot, so a replacement Spot instance self-heals. The
Dockerfile bakes in the model artifacts **and** pre-downloads the DINOv2 backbone
so restarts don't wait on HuggingFace. (For faster recovery still, bake the built
image into a custom AMI.)

Spot instances can be reclaimed with a 2-minute warning — acceptable for a pilot
with the disclaimers above; switch to an on-demand instance for steadier uptime.
