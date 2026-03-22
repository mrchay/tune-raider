const Database = require('better-sqlite3');
const path = require('path');
const { safeFilename } = require('./utils');

let db = null;

function open(workspacePath) {
  close();
  const dbPath = path.join(workspacePath, 'tuneraider.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate();
  return db;
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

function get() {
  return db;
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracks (
      key             TEXT PRIMARY KEY,
      playlist        TEXT NOT NULL,
      title           TEXT NOT NULL,
      artist          TEXT NOT NULL,
      album           TEXT DEFAULT '',
      duration_ms     INTEGER DEFAULT 0,
      duration        TEXT DEFAULT '',
      uri             TEXT DEFAULT '',
      csv_row         INTEGER DEFAULT 0,
      safe_filename   TEXT DEFAULT '',
      status          TEXT DEFAULT 'ready',
      selected_url    TEXT DEFAULT '',
      file_path       TEXT DEFAULT '',
      quality         TEXT DEFAULT '',
      sample_rate     TEXT DEFAULT '',
      peak_freq       TEXT DEFAULT '',
      lossless        TEXT DEFAULT '',
      match_confidence REAL DEFAULT 0,
      match_artist    TEXT DEFAULT '',
      match_title     TEXT DEFAULT '',
      spectrogram     TEXT DEFAULT '',
      error           TEXT DEFAULT '',
      searched_at     TEXT DEFAULT '',
      downloaded_at   TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS candidates (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      track_key       TEXT NOT NULL,
      url             TEXT NOT NULL,
      video_title     TEXT NOT NULL,
      channel         TEXT DEFAULT '',
      channel_type    TEXT DEFAULT '',
      duration        INTEGER DEFAULT 0,
      duration_text   TEXT DEFAULT '',
      score           INTEGER DEFAULT 0,
      score_breakdown TEXT DEFAULT '',
      thumbnail_url   TEXT DEFAULT '',
      selected        INTEGER DEFAULT 0,
      FOREIGN KEY (track_key) REFERENCES tracks(key) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_candidates_track ON candidates(track_key);
    CREATE INDEX IF NOT EXISTS idx_tracks_status ON tracks(status);
    CREATE INDEX IF NOT EXISTS idx_tracks_playlist ON tracks(playlist);
  `);

  // Add columns that may not exist in older DBs
  const cols = db.prepare("PRAGMA table_info(tracks)").all().map(c => c.name);
  if (!cols.includes('spectrogram')) {
    db.exec("ALTER TABLE tracks ADD COLUMN spectrogram TEXT DEFAULT ''");
  }
  if (!cols.includes('safe_filename')) {
    db.exec("ALTER TABLE tracks ADD COLUMN safe_filename TEXT DEFAULT ''");
    // Backfill existing tracks
    const tracks = db.prepare('SELECT key, artist, title FROM tracks WHERE safe_filename = ""').all();
    const update = db.prepare('UPDATE tracks SET safe_filename = ? WHERE key = ?');
    for (const t of tracks) {
      update.run(safeFilename(`${t.artist} - ${t.title}`), t.key);
    }
  }
}

// ── Track queries ──

function upsertTrack(track) {
  const stmt = db.prepare(`
    INSERT INTO tracks (key, playlist, title, artist, album, duration_ms, duration, uri, csv_row, safe_filename)
    VALUES (@key, @playlist, @title, @artist, @album, @duration_ms, @duration, @uri, @csv_row, @safe_filename)
    ON CONFLICT(key) DO UPDATE SET
      playlist = @playlist,
      title = @title,
      artist = @artist,
      album = @album,
      duration_ms = @duration_ms,
      duration = @duration,
      uri = @uri,
      csv_row = @csv_row,
      safe_filename = @safe_filename
  `);
  stmt.run(track);
}

function upsertTracksFromCSV(playlist, tracks) {
  const upsertMany = db.transaction((playlist, tracks) => {
    for (const t of tracks) {
      const key = `${playlist}::${t.uri || t.artist + '::' + t.title}`;
      upsertTrack({
        key,
        playlist,
        title: t.title,
        artist: t.artist,
        album: t.album,
        duration_ms: t.durationMs,
        duration: t.duration,
        uri: t.uri,
        csv_row: t.csvRow,
        safe_filename: safeFilename(`${t.artist} - ${t.title}`),
      });
    }
  });
  upsertMany(playlist, tracks);
}

function getAllTracks() {
  return db.prepare('SELECT * FROM tracks ORDER BY playlist, csv_row').all();
}

function getTrack(key) {
  return db.prepare('SELECT * FROM tracks WHERE key = ?').get(key);
}

function updateTrackStatus(key, status, extra = {}) {
  const sets = ['status = @status'];
  const params = { key, status };
  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = @${k}`);
    params[k] = v;
  }
  db.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE key = @key`).run(params);
}

function resetTrackForRedownload(key) {
  db.prepare(`
    UPDATE tracks SET
      status = 'ready',
      selected_url = '',
      file_path = '',
      quality = '',
      sample_rate = '',
      peak_freq = '',
      lossless = '',
      match_confidence = 0,
      match_artist = '',
      match_title = '',
      spectrogram = '',
      error = '',
      searched_at = '',
      downloaded_at = ''
    WHERE key = ?
  `).run(key);
  db.prepare('DELETE FROM candidates WHERE track_key = ?').run(key);
}

function deletePlaylist(name) {
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM candidates WHERE track_key IN (SELECT key FROM tracks WHERE playlist = ?)').run(name);
    db.prepare('DELETE FROM tracks WHERE playlist = ?').run(name);
  });
  txn();
}

function getPlaylists() {
  return db.prepare(`
    SELECT playlist AS name, COUNT(*) AS count,
      SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS done
    FROM tracks GROUP BY playlist ORDER BY playlist
  `).all();
}

// ── Candidate queries ──

function insertCandidates(trackKey, candidates) {
  const clear = db.prepare('DELETE FROM candidates WHERE track_key = ?');
  const insert = db.prepare(`
    INSERT INTO candidates (track_key, url, video_title, channel, channel_type, duration, duration_text, score, score_breakdown, thumbnail_url, selected)
    VALUES (@track_key, @url, @video_title, @channel, @channel_type, @duration, @duration_text, @score, @score_breakdown, @thumbnail_url, @selected)
  `);

  const run = db.transaction((trackKey, candidates) => {
    clear.run(trackKey);
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      insert.run({
        track_key: trackKey,
        url: c.url,
        video_title: c.videoTitle,
        channel: c.channel || '',
        channel_type: c.channelType || '',
        duration: c.duration || 0,
        duration_text: c.durationText || '',
        score: c.score || 0,
        score_breakdown: JSON.stringify(c.breakdown || {}),
        thumbnail_url: c.thumbnailUrl || '',
        selected: i === 0 ? 1 : 0
      });
    }
  });
  run(trackKey, candidates);
}

function getCandidates(trackKey) {
  return db.prepare('SELECT * FROM candidates WHERE track_key = ? ORDER BY score DESC').all(trackKey);
}

function selectCandidate(trackKey, candidateId) {
  const txn = db.transaction(() => {
    db.prepare('UPDATE candidates SET selected = 0 WHERE track_key = ?').run(trackKey);
    db.prepare('UPDATE candidates SET selected = 1 WHERE id = ?').run(candidateId);
    const c = db.prepare('SELECT url FROM candidates WHERE id = ?').get(candidateId);
    if (c) {
      db.prepare('UPDATE tracks SET selected_url = ? WHERE key = ?').run(c.url, trackKey);
    }
  });
  txn();
}

// Reset tracks stuck in intermediate states (from interrupted runs)
function recoverStuckTracks() {
  const stuck = db.prepare(`
    SELECT key, status FROM tracks
    WHERE status IN ('queued', 'searching', 'downloading', 'checking', 'fingerprinting')
  `).all();

  if (stuck.length === 0) return 0;

  const txn = db.transaction(() => {
    // searching → ready (search didn't complete, need to redo)
    db.prepare(`UPDATE tracks SET status = 'ready' WHERE status IN ('queued', 'searching')`).run();
    // downloading → searched (download didn't complete, can retry)
    db.prepare(`UPDATE tracks SET status = 'searched' WHERE status = 'downloading'`).run();
    // checking/fingerprinting → downloaded (analysis didn't complete, can retry)
    db.prepare(`UPDATE tracks SET status = 'downloaded' WHERE status IN ('checking', 'fingerprinting')`).run();
  });
  txn();

  return stuck.length;
}

module.exports = {
  open, close, get,
  upsertTrack, upsertTracksFromCSV, getAllTracks, getTrack,
  updateTrackStatus, resetTrackForRedownload, deletePlaylist, getPlaylists,
  insertCandidates, getCandidates, selectCandidate, recoverStuckTracks
};
