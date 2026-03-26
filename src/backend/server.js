const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const db = require('./db');
const pipeline = require('./pipeline');

const PORT = 9600;
const TOOLS_DIR = path.join(__dirname, 'tools');
const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');
const DEFAULT_WORKSPACE = path.join(__dirname, '..', '..', 'workspace');

// ── Config ──

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    if (fs.existsSync(CONFIG_PATH)) {
      console.error(`[backend] Failed to parse config.json: ${err.message}`);
    }
    return {};
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function getWorkspacePath() {
  const config = loadConfig();
  return config.workspace || '';
}

// ── Workspace ──

function ensureWorkspaceDirs(wsPath) {
  const dirs = ['playlists', 'downloads'];
  let created = false;
  if (!fs.existsSync(wsPath)) {
    fs.mkdirSync(wsPath, { recursive: true });
    created = true;
  }
  for (const dir of dirs) {
    const p = path.join(wsPath, dir);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
      created = true;
    }
  }
  return created;
}

function initWorkspace(wsPath) {
  ensureWorkspaceDirs(wsPath);
  db.open(wsPath);
  pipeline.setWorkspace(wsPath);
  pipeline.cleanup();
  syncPlaylistsFromDisk(wsPath);
  pipeline.restoreQueue();
}

// ── CSV parsing ──

function parseCSV(content) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.length < 2) return [];

  const header = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());

  const colMap = {};
  for (let i = 0; i < header.length; i++) {
    const h = header[i];
    if (h.includes('track name') || h === 'track') colMap.title = i;
    else if (h.includes('artist name') || h === 'artist' || h === 'artists') colMap.artist = i;
    else if (h.includes('album name') || h === 'album') colMap.album = i;
    else if (h.includes('duration') || h === 'duration (ms)') colMap.duration = i;
    else if (h.includes('track uri') || h === 'uri' || h === 'spotify uri') colMap.uri = i;
  }

  const tracks = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = parseCSVLine(lines[i]);
    const title = cols[colMap.title] || '';
    const artist = cols[colMap.artist] || '';
    if (!title && !artist) continue;

    const durationMs = parseInt(cols[colMap.duration]) || 0;
    const mins = Math.floor(durationMs / 60000);
    const secs = Math.floor((durationMs % 60000) / 1000);

    tracks.push({
      title: title.trim(),
      artist: artist.trim(),
      album: (cols[colMap.album] || '').trim(),
      durationMs,
      duration: durationMs ? `${mins}:${secs.toString().padStart(2, '0')}` : '',
      uri: (cols[colMap.uri] || '').trim(),
      csvRow: i
    });
  }
  return tracks;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { result.push(current); current = ''; }
      else current += ch;
    }
  }
  result.push(current);
  return result;
}

// ── Sync CSVs from playlists folder into DB ──

function syncPlaylistsFromDisk(wsPath) {
  const playlistsDir = path.join(wsPath, 'playlists');
  if (!fs.existsSync(playlistsDir)) return;

  const csvFiles = fs.readdirSync(playlistsDir).filter(f => f.endsWith('.csv'));
  for (const file of csvFiles) {
    const playlistName = path.basename(file, '.csv');
    const content = fs.readFileSync(path.join(playlistsDir, file), 'utf-8');
    const tracks = parseCSV(content);
    db.upsertTracksFromCSV(playlistName, tracks);
  }
}

function importCSVFile(wsPath, filename, content) {
  ensureWorkspaceDirs(wsPath);
  const dest = path.join(wsPath, 'playlists', filename);
  fs.writeFileSync(dest, content);

  const playlistName = path.basename(filename, '.csv');
  const tracks = parseCSV(content);
  db.upsertTracksFromCSV(playlistName, tracks);
  return tracks.length;
}

// ── Downloads folder watcher ──

let downloadWatcher = null;

function getDownloadsFolder() {
  return path.join(os.homedir(), 'Downloads');
}

function startWatchingDownloads() {
  if (downloadWatcher) return;

  const downloadsDir = getDownloadsFolder();
  if (!fs.existsSync(downloadsDir)) {
    console.log('[backend] Downloads folder not found:', downloadsDir);
    return;
  }

  const knownFiles = new Set(fs.readdirSync(downloadsDir));
  log(`Watching for CSVs in: ${downloadsDir}`);

  downloadWatcher = fs.watch(downloadsDir, (eventType, filename) => {
    if (!filename || !filename.endsWith('.csv')) return;
    if (knownFiles.has(filename)) return;

    knownFiles.add(filename);

    const filePath = path.join(downloadsDir, filename);
    setTimeout(() => {
      try {
        if (!fs.existsSync(filePath)) return;

        const wsPath = getWorkspacePath();
        if (!wsPath) return;

        const content = fs.readFileSync(filePath, 'utf-8');
        const count = importCSVFile(wsPath, filename, content);
        log(`Auto-imported: ${filename} (${count} tracks)`);

        broadcast({ type: 'playlistAutoImported', filename, count });
      } catch (err) {
        log(`Auto-import failed for ${filename}: ${err.message}`, 'error');
      }
    }, 1500);
  });
}

function stopWatchingDownloads() {
  if (downloadWatcher) {
    downloadWatcher.close();
    downloadWatcher = null;
    log('Stopped watching Downloads folder');
  }
}

// ── WebSocket server ──

let workspaceError = '';

const wss = new WebSocketServer({ port: PORT });

wss.on('listening', () => {
  console.log(`[backend] WebSocket server listening on ws://localhost:${PORT}`);

  // Auto-init workspace if previously configured
  const wsPath = getWorkspacePath();
  if (wsPath) {
    try {
      initWorkspace(wsPath);
      workspaceError = '';
      console.log(`[backend] Workspace loaded: ${wsPath}`);
    } catch (err) {
      workspaceError = err.message;
      console.error(`[backend] Failed to load workspace: ${err.message}`);
    }
  }
});

wss.on('connection', (ws) => {
  log('Client connected');

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }
    try {
      handleMessage(ws, msg);
    } catch (err) {
      console.error(`[backend] Error handling "${msg.type}":`, err);
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  ws.on('close', () => {
    log('Client disconnected');
  });

  ws.send(JSON.stringify({ type: 'welcome', version: '1.0.0' }));

  // Send current pipeline state so the client sees queue/paused status immediately
  if (db.get()) {
    const pipeline = require('./pipeline');
    // Trigger a broadcast so this client gets the current state
    setImmediate(() => pipeline.broadcastProgress());
  }
});

function handleMessage(ws, msg) {
  switch (msg.type) {

    case 'getWorkspace': {
      const config = loadConfig();
      const resp = { type: 'workspace', path: config.workspace || '' };
      if (workspaceError) resp.error = workspaceError;
      ws.send(JSON.stringify(resp));
      break;
    }

    case 'setWorkspace': {
      const config = loadConfig();
      const wsPath = msg.useDefault ? DEFAULT_WORKSPACE : msg.path;

      try {
        initWorkspace(wsPath);
        config.workspace = wsPath;
        saveConfig(config);
        workspaceError = '';
        log(`Workspace set: ${wsPath}`);
        ws.send(JSON.stringify({ type: 'workspaceSet', path: wsPath, created: true }));
        checkYtStatus(ws);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: `Failed to set workspace: ${err.message}` }));
      }
      break;
    }

    case 'getTracks': {
      if (!db.get()) {
        ws.send(JSON.stringify({ type: 'tracks', tracks: [], playlists: [] }));
        break;
      }
      try {
        const tracks = db.getAllTracks();
        const playlists = db.getPlaylists();
        ws.send(JSON.stringify({ type: 'tracks', tracks, playlists }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: `Failed to load tracks: ${err.message}` }));
      }
      break;
    }

    case 'getCandidates': {
      if (!db.get()) break;
      const candidates = db.getCandidates(msg.trackKey);
      ws.send(JSON.stringify({ type: 'candidates', trackKey: msg.trackKey, candidates }));
      break;
    }

    case 'selectCandidate': {
      if (!db.get()) break;
      db.selectCandidate(msg.trackKey, msg.candidateId);
      ws.send(JSON.stringify({ type: 'candidateSelected', trackKey: msg.trackKey, candidateId: msg.candidateId }));
      break;
    }

    case 'resetTrack': {
      if (!db.get()) break;
      db.resetTrackForRedownload(msg.trackKey);
      ws.send(JSON.stringify({ type: 'trackReset', trackKey: msg.trackKey }));
      break;
    }

    case 'resetTracks': {
      if (!db.get()) break;
      db.batchResetTracks(msg.keys);
      log(`Reset ${msg.keys.length} track(s)`);
      pipeline.markAllDirty();
      ws.send(JSON.stringify({ type: 'tracksReset', count: msg.keys.length }));
      break;
    }

    case 'deleteTracks': {
      if (!db.get()) break;
      let deleted = 0;
      // Delete files first (needs track data before reset)
      for (const key of msg.keys) {
        const track = db.getTrack(key);
        if (track?.file_path) {
          try {
            if (fs.existsSync(track.file_path)) { fs.unlinkSync(track.file_path); deleted++; }
          } catch (err) {
            log(`Failed to delete file for "${key}": ${err.message}`, 'error');
          }
        }
      }
      // Batch reset all tracks in single transaction
      db.batchResetTracks(msg.keys);
      log(`Deleted ${deleted} file(s), reset ${msg.keys.length} track(s)`);
      pipeline.markAllDirty();
      ws.send(JSON.stringify({ type: 'tracksDeleted', deleted, count: msg.keys.length }));
      break;
    }

    case 'importCSV': {
      const wsPath = getWorkspacePath();
      if (!wsPath) {
        ws.send(JSON.stringify({ type: 'error', message: 'No workspace set' }));
        break;
      }
      try {
        const count = importCSVFile(wsPath, msg.filename, msg.content);
        pipeline.markAllDirty();
        log(`Imported playlist: ${msg.filename} (${count} tracks)`);
        ws.send(JSON.stringify({ type: 'importResult', filename: msg.filename, count }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'importResult', error: err.message }));
      }
      break;
    }

    case 'deletePlaylist': {
      const wsPath = getWorkspacePath();
      if (!wsPath || !db.get()) break;
      try {
        db.deletePlaylist(msg.name);
        // Remove the CSV file
        const csvPath = path.join(wsPath, 'playlists', msg.name + '.csv');
        if (fs.existsSync(csvPath)) fs.unlinkSync(csvPath);
        pipeline.markAllDirty();
        log(`Deleted playlist: ${msg.name}`);
        ws.send(JSON.stringify({ type: 'playlistDeleted', name: msg.name }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: `Failed to delete playlist: ${err.message}` }));
      }
      break;
    }

    case 'getConfig': {
      const config = loadConfig();
      ws.send(JSON.stringify({
        type: 'config',
        acoustid_api_key: config.acoustid_api_key || '',
        request_delay: config.request_delay ?? 2,
      }));
      break;
    }

    case 'setConfig': {
      const config = loadConfig();
      if (msg.acoustid_api_key !== undefined) config.acoustid_api_key = msg.acoustid_api_key;
      if (msg.request_delay !== undefined) config.request_delay = Number(msg.request_delay);
      saveConfig(config);
      pipeline.invalidateDelayCache();
      log('Config updated');
      ws.send(JSON.stringify({
        type: 'config',
        acoustid_api_key: config.acoustid_api_key || '',
        request_delay: config.request_delay ?? 2,
      }));
      break;
    }

    case 'importCookies': {
      const wsPath = getWorkspacePath();
      if (!wsPath) {
        ws.send(JSON.stringify({ type: 'error', message: 'No workspace set' }));
        break;
      }
      try {
        const dest = path.join(wsPath, 'cookies.txt');
        if (msg.path) {
          // Copy file directly (preserves encoding)
          fs.copyFileSync(msg.path, dest);
          log(`Cookies file copied from: ${msg.path}`);
        } else {
          fs.writeFileSync(dest, msg.content);
          log('Cookies file imported from content');
        }
        ws.send(JSON.stringify({ type: 'cookiesImported', message: 'Cookies imported successfully' }));
        checkYtStatus(ws);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: `Failed to import cookies: ${err.message}` }));
      }
      break;
    }

    case 'checkYtStatus': {
      checkYtStatus(ws);
      break;
    }

    case 'watchDownloads': {
      if (msg.enable) startWatchingDownloads();
      else stopWatchingDownloads();
      break;
    }

    case 'setThreads': {
      pipeline.setThreads(msg);
      break;
    }

    case 'startPipeline': {
      if (!db.get()) {
        ws.send(JSON.stringify({ type: 'error', message: 'No workspace set' }));
        break;
      }
      // mode: 'search', 'download', or 'full'
      pipeline.enqueue(msg.keys, msg.threads, msg.mode || 'full');
      break;
    }

    case 'stopPipeline':
      pipeline.stop();
      break;

    case 'pausePipeline':
      pipeline.pause();
      break;

    case 'resumePipeline':
      pipeline.resume();
      break;

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;

    default:
      ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
  }
}

function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const client of wss.clients) {
    // Skip clients that are not open or have >1MB buffered (backpressure)
    if (client.readyState === 1 && client.bufferedAmount < 1024 * 1024) {
      client.send(payload);
    }
  }
}

function log(message, level = 'log') {
  const prefix = level === 'error' ? '[backend:error]' : level === 'warn' ? '[backend:warn]' : '[backend]';
  // Strip null bytes — yt-dlp/ffmpeg can leak them on Windows
  const clean = String(message).replace(/\0/g, '');
  console.log(`${prefix} ${clean}`);
  broadcast({ type: 'log', message: clean, level });
}

// ── YouTube status check ──

function getYtdlpPath() {
  const toolsPath = path.join(__dirname, 'tools', 'yt-dlp.exe');
  if (fs.existsSync(toolsPath)) return toolsPath;
  return 'yt-dlp';
}

function checkYtStatus(ws) {
  const wsPath = getWorkspacePath();
  const cookiesPath = wsPath ? path.join(wsPath, 'cookies.txt') : '';

  if (!cookiesPath || !fs.existsSync(cookiesPath)) {
    ws.send(JSON.stringify({ type: 'ytStatus', status: 'no-cookies', label: 'No cookies' }));
    return;
  }

  ws.send(JSON.stringify({ type: 'ytStatus', status: 'checking', label: 'Checking...' }));

  // List all available formats for a known track
  // Premium users get format 141 (256kbps AAC) or high-bitrate opus (≥256kbps)
  const ytdlp = getYtdlpPath();
  const testUrl = 'https://music.youtube.com/watch?v=dQw4w9WgXcQ';
  execFile(ytdlp, [
    '--cookies', cookiesPath,
    '-F',
    '--no-download',
    '--no-warnings',
    '--geo-bypass',
    '--js-runtimes', 'node',
    testUrl,
  ], { timeout: 45000, windowsHide: true }, (err, stdout, stderr) => {
    const output = (stdout || '').toString('utf-8');

    // Find audio-only lines
    const audioLines = output.split('\n').filter(l => l.includes('audio only'));
    if (audioLines.length > 0) {
      log('YT audio formats:\n' + audioLines.join('\n'));
    } else {
      log('YT format check: no audio formats found\n' + output.trim(), 'warn');
    }

    if (err && !output) {
      ws.send(JSON.stringify({ type: 'ytStatus', status: 'no-cookies', label: 'Auth failed' }));
      log('YouTube status: auth failed', 'warn');
      return;
    }

    if (audioLines.length === 0) {
      ws.send(JSON.stringify({ type: 'ytStatus', status: 'no-cookies', label: 'Auth failed' }));
      log('YouTube status: no audio formats available', 'warn');
      return;
    }

    // Premium indicators:
    // - format 141 (256kbps AAC, premium-only)
    // - any audio with ABR >= 256k
    // - "premium" in format description
    const hasFormat141 = audioLines.some(l => /^\s*141\s/.test(l));
    const hasHighBitrate = audioLines.some(l => {
      const m = l.match(/(\d+)k\b/g);
      return m && m.some(k => parseInt(k) >= 256);
    });
    const hasPremiumLabel = output.toLowerCase().includes('premium');

    if (hasFormat141 || hasHighBitrate || hasPremiumLabel) {
      ws.send(JSON.stringify({ type: 'ytStatus', status: 'premium', label: 'Premium' }));
      log('YouTube status: Premium');
    } else {
      ws.send(JSON.stringify({ type: 'ytStatus', status: 'standard', label: 'Standard' }));
      log('YouTube status: Standard (max audio: ' +
        audioLines.map(l => l.match(/(\d+)k/)?.[0] || '?').join(', ') + ')');
    }
  });
}

// Graceful shutdown
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
process.on('exit', () => shutdown());

function shutdown() {
  pipeline.shutdown();
  db.close();
  stopWatchingDownloads();
  wss.close();
}

// Init pipeline with broadcast and log functions
pipeline.init({ broadcast, log, workspacePath: getWorkspacePath() });

module.exports = { wss, broadcast, log };
