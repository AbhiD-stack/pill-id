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
| `frontend/` | Next.js app: landing page at `/`, original UI at `/v1`, new UI at `/v2` — both call the same backend |
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
