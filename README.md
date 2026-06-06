# YT Studio v1.2.0

**Waz Clipper + Bulk YT Downloader — combined into a single tabbed UI.**

This project is the combination of two previously separate projects:

| Original                         | Version | Function                                              |
|----------------------------------|---------|-------------------------------------------------------|
| `waz-clipper`                    | v2.6.0  | Bengali Waz 9:16 video clipper with title rendering   |
| `bulk-yt-downloader`             | v3.0.0  | Line-by-line YouTube Shorts/videos bulk downloader    |

Both share **one config panel**, **one Cookies/Setup panel**, **one Google Drive integration**, **one VMess/proxy tunnel via Xray-core**, and the same persistent `/app/data` volume.

---

## What's new vs the originals

| Area                         | Change                                                                                                                  |
|------------------------------|-------------------------------------------------------------------------------------------------------------------------|
| **POT (BotGuard)**           | **100% removed** from the clipper side (same as bulk). No more POT URL config, no `bgutil-pot-provider` dependency.     |
| **Proxy "expired/dead" warn** | False-positives fixed. We now run **two independent probes** (ipify + youtube) with a **30 s** timeout. We only mark proxy as dead when BOTH probes fail. When a fresh VMess link is saved, the UI auto-waits 4 s for Xray warm-up before testing. A "WARMING" state is shown while Xray boots — no scary red warning during start-up. |
| **Clipper title input bug**  | The clip row was a flex layout where the timestamp `range` field grew and shrank the `title` field to almost zero width. Switched to a CSS grid with explicit columns (`160px 1fr 130px 36px`) and `min-width: 0` on the title cell. On screens narrower than 720 px the title moves to its own full-width row. Title is always visible while typing — no need to click anything. |
| **Bulk preview + local DL**  | The Bulk Downloader now matches the Clipper: every ready item has a **▶ Preview** button (opens a modal player — uses `<audio>` for `audio` mode and `<video>` for the other modes) and a **⬇ Download** button. No backend code touched — the files were already served via `/files/...`; only the UI was updated. |
| **Instant job kill**         | When you delete a running job (clipper or bulk), the server now **SIGKILLs** every yt-dlp / ffmpeg child process belonging to that job, marks the job as `aborted`, and stops the loop at the next checkpoint. The job is removed immediately along with any partially-written files. Previously the children would keep running in the background until they finished. |

---

## UI overview

Five top-level tabs:

1. **🎬 Waz Clipper** — exactly the old waz UI (URL → clips with ranges/titles/styles → 9:16 render → preview → Drive upload).
2. **📥 Bulk Downloader** — the old bulk UI (mode picker → paste URLs → start → per-item preview & download → Drive upload).
3. **🔑 Config** — VMess/VLESS/Trojan/SS/SOCKS5 tunnel link, residential proxy, Google Drive OAuth credentials.
4. **⚙️ Setup & Cookies** — system status, cookies.txt upload, test-download endpoint.
5. **📊 Stats** — strategy success rates, proxy type breakdown, recent downloads (powered by clipper-side stats).

Both Clipper and Bulk jobs share the same `/api/drive/upload` endpoint — the route auto-detects which type of job each ID belongs to.

---

## API map

| Method | Path                              | Use                                                  |
|--------|-----------------------------------|------------------------------------------------------|
| GET    | `/health`                         | Liveness check                                       |
| GET    | `/version`                        | Build info (ffmpeg / deno / xray / yt-dlp versions)  |
| GET    | `/auth/google`                    | Start Google Drive OAuth                             |
| GET    | `/auth/google/callback`           | OAuth callback                                       |
| GET    | `/auth/status`                    | `{authenticated}`                                    |
| POST   | `/api/jobs/clipper`               | Create a clipper job                                 |
| GET    | `/api/jobs/clipper`               | List clipper jobs                                    |
| GET    | `/api/jobs/clipper/:id`           | Get one clipper job                                  |
| DELETE | `/api/jobs/clipper/:id`           | Delete + kill running yt-dlp/ffmpeg processes        |
| GET    | `/api/jobs/clipper/:id/logs`      | SSE log stream                                       |
| POST   | `/api/jobs/bulk`                  | Create a bulk job                                    |
| GET    | `/api/jobs/bulk`                  | List bulk jobs                                       |
| GET    | `/api/jobs/bulk/:id`              | Get one bulk job                                     |
| DELETE | `/api/jobs/bulk/:id`              | Delete + kill running yt-dlp processes               |
| GET    | `/api/jobs/bulk/:id/logs`         | SSE log stream                                       |
| POST   | `/api/drive/upload`               | Upload selected items (auto-detects clipper or bulk) |
| GET    | `/api/setup/status`               | Cookies / proxy / xray / deno / oauth / ffmpeg state |
| GET    | `/api/setup/config`               | Read persisted config                                |
| POST   | `/api/setup/config`               | Save config (writes `/app/data/config.json`)         |
| POST   | `/api/setup/cookies`              | Upload cookies.txt (multipart)                       |
| DELETE | `/api/setup/cookies`              | Delete cookies.txt                                   |
| POST   | `/api/setup/proxy-test`           | 2-probe proxy health-check (30 s each)               |
| POST   | `/api/setup/vmess-decode`         | Show decoded VMess JSON (uuid masked)                |
| POST   | `/api/setup/test`                 | Simulate-only yt-dlp run                             |
| GET    | `/api/setup/stats`                | Strategy/proxy/cookie stats                          |
| POST   | `/api/setup/stats/reset`          | Wipe stats                                           |
| GET    | `/files/<name>`                   | Serve a downloaded/rendered file                     |

Legacy alias: `POST /api/jobs` → `POST /api/jobs/clipper` (kept for backward compatibility).

---

## Deploying

### Railway (recommended)

1. Push this repo to GitHub.
2. New Railway service → from GitHub repo → it picks up `railway.json` + `Dockerfile`.
3. Add a **persistent volume** mounted at `/app/data`.
4. Set env vars (optional — most are settable from the UI):
   - `SESSION_SECRET` — random 32 chars
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` — for Drive uploads
   - `VMESS_LINK` or `YTDLP_PROXY` — for bot bypass
5. After deploy: open the app → **Setup tab** → upload `cookies.txt` (Firefox + "Get cookies.txt LOCALLY" extension).

### Docker Compose

```bash
docker compose up -d --build
```

Visit http://localhost:3000 .

---

## Why POT was removed

The bgutil POT (BotGuard token) provider was a separate sidecar Railway service that often desynced from yt-dlp updates and added a single point of failure. The Bulk Downloader v3.0 replaced it with **Deno-based JS challenge solving** (yt-dlp's official path since 2025.11+). YT Studio v1.0 now applies the same approach to the Clipper side as well — Deno + cookies + VMess tunnel covers virtually every bot-detection case without POT.

If you previously had a `POT_PROVIDER_URL` config key, it's silently scrubbed from `config.json` at startup.

---

## File layout

```
yt-studio/
├── src/
│   ├── server.js                      # mounts both job routes + shared setup/drive/auth
│   ├── public/
│   │   ├── index.html                 # 5-tab UI (Clipper / Bulk / Config / Setup / Stats)
│   │   ├── mic.png                    # speaker bar mic icon
│   │   └── fonts/                     # Hind Siliguri + Noto Sans Bengali
│   ├── routes/
│   │   ├── auth.js                    # Google OAuth (shared, unchanged from waz)
│   │   ├── drive.js                   # NEW: unified — detects job type automatically
│   │   ├── jobs-clipper.js            # Mounted at /api/jobs/clipper and /api/jobs
│   │   ├── jobs-bulk.js               # Mounted at /api/jobs/bulk
│   │   └── setup.js                   # NEW: merged — robust 2-probe proxy check, POT-free
│   ├── services/
│   │   ├── drive.js                   # Google Drive API (shared, unchanged)
│   │   ├── xray.js                    # VMess/VLESS/Trojan/SS decoder + xray spawn (shared, unchanged)
│   │   ├── ffmpeg.js                  # Bengali 9:16 render (clipper); + killJob() hook
│   │   ├── titleRenderer.js           # Pillow+raqm title PNG (clipper, unchanged)
│   │   ├── stats.js                   # Stats persistence (clipper, unchanged)
│   │   ├── ytdlp-clipper.js           # waz v2.6 per-clip partial DL, POT lines REMOVED
│   │   ├── ytdlp-bulk.js              # bulk v3.0 download service (unchanged)
│   │   ├── jobManager-clipper.js      # waz job state machine + abort/kill on delete
│   │   └── jobManager-bulk.js         # bulk job state machine + abort/kill on delete
│   └── utils/
│       ├── logger.js                  # ring buffer + SSE log subscribe (shared, unchanged)
│       └── timestamp.js               # HH:MM:SS parsers (shared, unchanged)
├── Dockerfile                         # node + python venv + pillow+raqm + deno + xray + ffmpeg
├── docker-compose.yml                 # no more POT sidecar
├── railway.json
├── package.json
└── README.md
```

---

## Credits

- `waz-clipper` v2.6 core
- `bulk-yt-downloader` v3.0 core
- Merged + cleaned by YT Studio v1.0
