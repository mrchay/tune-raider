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
│       ├── pipeline.js     # Multi-stage pipeline with per-stage thread pools (search/download/analyse)
│       ├── search.js       # YouTube Music search via yt-dlp, candidate scoring algorithm
│       ├── downloader.js   # Audio download via yt-dlp (FLAC with embedded metadata)
│       ├── analyser.js     # Quality analysis (whatsmybitrate) + fingerprint (AcoustID)
│       ├── utils.js        # Shared utilities (safeFilename)
│       └── tools/          # Bundled binaries and Python scripts
│           ├── yt-dlp.exe
│           ├── fpcalc.exe
│           ├── ffmpeg.exe
│           ├── ffprobe.exe
│           ├── identify.py
│           ├── whatsmybitrate.py
│           └── wmb_core.py
├── dev.js                  # Dev launcher (starts backend + NW.js frontend)
├── build.js                # Release build script (nw-builder)
├── install.bat             # Runs npm install + pip install
├── run.bat                 # Launches dev mode
├── build.bat               # Runs release build
├── config.json             # User config (workspace path, acoustid key) — gitignored
└── workspace/              # Runtime data (DB, playlists, downloads) — gitignored
```

## Key Design Decisions

- **WebSocket communication**: Frontend and backend are separate processes connected via WS on port 9600. All messages are JSON with a `type` field.
- **SQLite database**: `tuneraider.db` in workspace. Two tables: `tracks` (state machine per track) and `candidates` (search results). Uses WAL mode.
- **Per-stage thread pools**: Search, download, and analyse each have independent queues and configurable thread counts. Thread counts can be changed live while pipeline is running.
- **Safe filenames**: All file operations use `safe_filename` field (ASCII-only, stored in DB). Original names with Unicode are preserved in FLAC metadata by yt-dlp's `--embed-metadata`.
- **Graceful recovery**: On startup, stuck intermediate statuses (searching/downloading/checking) are reset to their previous logical state.

## Track Status Flow

```
ready → queued → searching → searched → downloading → downloaded → checking → complete
                                                                              → failed (at any stage)
```

## Pipeline Stages

1. **Search**: Runs 3 YouTube searches per track via yt-dlp, scores candidates using weighted algorithm (duration, channel type, metadata match, keyword penalties). Async (non-blocking).
2. **Download**: Downloads best-scored candidate as FLAC via yt-dlp with `--embed-metadata --embed-thumbnail`. Files go to `workspace/downloads/{playlist}/{safe_filename}.flac`.
3. **Analyse**: Runs whatsmybitrate (spectrum analysis for quality estimation) and AcoustID fingerprinting (identity verification). Both use Python scripts in tools/.

## WebSocket Message Types (frontend → backend)

`getWorkspace`, `setWorkspace`, `getTracks`, `getCandidates`, `selectCandidate`, `resetTrack`, `resetTracks`, `deleteTracks`, `importCSV`, `deletePlaylist`, `startPipeline`, `setThreads`, `watchDownloads`, `importCookies`, `checkYtStatus`, `getConfig`, `setConfig`

## Commands

- `npm start` or `run.bat` — launch dev mode
- `npm run build` or `build.bat` — create release build
- `install.bat` — install all dependencies (npm + pip)

## Dependencies

- **Node**: nw (NW.js SDK), ws, better-sqlite3, nw-builder (dev)
- **Python** (on PATH): acoustid, numpy, soundfile, librosa, scipy, matplotlib
- **Bundled binaries**: yt-dlp, fpcalc, ffmpeg, ffprobe

## Style Notes

- Dark/black theme, not blue. Amber/gold accent (#c0873c / #d4a04a).
- Font: Share Tech (bundled TTF, retro computer feel).
- Sidebar has raider.png artwork anchored bottom-left, muted with opacity+brightness.
- Score breakdown tags in candidate view: green for positive, red for negative.
