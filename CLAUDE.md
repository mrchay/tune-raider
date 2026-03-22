# Tune Raider

Music download manager with NW.js GUI and Node.js backend, communicating via WebSocket.

## Architecture

```
tune-raider/
├── src/
│   ├── frontend/           # NW.js GUI (HTML/CSS/JS)
│   │   ├── index.html      # Main layout: titlebar, sidebar, track table, dock
│   │   ├── styles.css      # Dark theme (black base, amber accent #c0873c)
│   │   ├── app.js          # All frontend logic, WebSocket client
│   │   ├── raider.png      # Sidebar artwork
│   │   └── ShareTech-Regular.ttf  # Bundled font
│   └── backend/
│       ├── server.js       # WebSocket server (port 9600), message router, config/workspace management
│       ├── db.js           # SQLite via better-sqlite3, schema, queries (tracks + candidates tables)
│       ├── pipeline.js     # Multi-stage pipeline with per-stage thread pools, queue persistence, stop/pause/resume
│       ├── search.js       # YouTube Music search via yt-dlp, candidate scoring algorithm
│       ├── downloader.js   # Audio download via yt-dlp (FLAC with embedded metadata)
│       ├── analyser.js     # Quality analysis (whatsmybitrate) + fingerprint (AcoustID)
│       ├── utils.js        # Shared utilities (safeFilename)
│       └── tools/          # Bundled binaries and Python scripts
│           ├── yt-dlp.exe        # Committed to git
│           ├── fpcalc.exe        # Committed to git
│           ├── ffmpeg.exe        # Gitignored — downloaded by install.bat
│           ├── ffprobe.exe       # Gitignored — downloaded by install.bat
│           ├── identify.py
│           ├── whatsmybitrate.py
│           └── wmb_core.py
├── dev.js                  # Dev launcher (starts backend + NW.js frontend)
├── build.js                # Release build script (bundles Python, Node, NW.js, all deps)
├── install.bat             # Dev setup: npm install + pip install + downloads ffmpeg/ffprobe
├── run.bat                 # Launches dev mode
├── build.bat               # Runs release build
├── config.json             # User config (workspace path, acoustid key) — gitignored
└── workspace/              # Runtime data (DB, playlists, downloads) — gitignored
```

## Key Design Decisions

- **WebSocket communication**: Frontend and backend are separate processes connected via WS on port 9600. All messages are JSON with a `type` field.
- **SQLite database**: `tuneraider.db` in workspace. Two tables: `tracks` (state machine per track) and `candidates` (search results). Uses WAL mode.
- **Per-stage thread pools**: Search, download, and analyse each have independent queues and configurable thread counts. Thread counts can be changed live while pipeline is running.
- **Queue persistence**: Queued tracks store `queue_stage` and `queue_mode` in DB. On restart, the queue is restored from DB and processing resumes.
- **Pipeline controls**: Stop (cancel all, reset queued tracks), Pause (finish current threads, hold queue), Resume (cleanup + restart processing). Buttons in dock header.
- **Safe filenames**: `safeFilename()` in utils.js: NFD normalize → strip diacritics → replace non-ASCII with `_` → remove illegal chars → max 200 chars. Stored as `safe_filename` in DB. Original Unicode preserved in FLAC metadata via `--embed-metadata`. The `file_path` DB column holds the absolute path written by the downloader; analysis reads this directly.
- **Startup cleanup**: On workspace init, pipeline runs `cleanup()` which: recovers stuck intermediate statuses, deletes partial downloads from temp/, verifies file_path entries exist on disk (marks orphans as failed). Same cleanup runs before resume.

## Track Status Flow

```
ready → queued → searching → searched → downloading → downloaded → checking → complete
                                                                              → failed (at any stage)
```

## Pipeline Stages

1. **Search**: Runs 3 YouTube searches per track via yt-dlp, scores candidates using weighted algorithm (duration, channel type, metadata match, keyword penalties). Async (non-blocking).
2. **Download**: Downloads best-scored candidate as FLAC via yt-dlp with `--embed-metadata --embed-thumbnail`. Files go to `workspace/downloads/{playlist}/{safe_filename}.flac`. Downloads to `workspace/temp/` first, then moves to final location (partial downloads are cleaned up on startup).
3. **Analyse**: Runs whatsmybitrate (spectrum analysis for quality estimation) and AcoustID fingerprinting (identity verification). Both use Python scripts in tools/.

## WebSocket Message Types (frontend → backend)

`getWorkspace`, `setWorkspace`, `getTracks`, `getCandidates`, `selectCandidate`, `resetTrack`, `resetTracks`, `deleteTracks`, `importCSV`, `deletePlaylist`, `startPipeline`, `stopPipeline`, `pausePipeline`, `resumePipeline`, `setThreads`, `watchDownloads`, `importCookies`, `checkYtStatus`, `getConfig`, `setConfig`

## Commands

- `npm start` or `run.bat` — launch dev mode
- `npm run build` or `build.bat` — create release build
- `install.bat` — install all dependencies (npm + pip + ffmpeg download)

## Dependencies

- **Node**: nw (NW.js SDK), ws, better-sqlite3, nw-builder (dev)
- **Python** (on PATH for dev): pyacoustid, numpy, soundfile, librosa, scipy, matplotlib, tqdm
- **Bundled binaries**: yt-dlp, fpcalc (committed); ffmpeg, ffprobe (gitignored, downloaded by install.bat from gyan.dev)

## Build & Release

- `build.js` creates a fully offline release in `release/tune-raider/` containing embedded Python (3.12), Node.js (just node.exe), NW.js, all pip packages (librosa installed --no-deps to skip numba/llvmlite ~130MB), and npm production deps.
- Launcher: `TuneRaider.bat` (with console) or `TuneRaider.vbs` (silent). Both set PATH to bundled runtimes.
- Build cache in `.build-cache/` avoids re-downloading runtimes.
- Step 7 strips pip/setuptools/wheel, __pycache__, tests, and .dist-info from the release.

## Style Notes

- Dark/black theme, not blue. Amber/gold accent (#c0873c / #d4a04a).
- Font: Share Tech (bundled TTF, retro computer feel).
- Sidebar artwork: raider.png, positioned absolute resting on the drop zone, full width, muted (opacity: 0.25). Exportify button overlays on top.
- Glitch effect on sidebar artwork: one-shot CSS animation triggered by button actions (search, download, analyse, pipeline, reset, delete). Uses hue-shifted pseudo-elements with clip-path keyframes. Not a constant loop.
- Score breakdown tags in candidate view: green for positive, red for negative.
- Settings panel auto-opens on startup if workspace is missing or invalid.
