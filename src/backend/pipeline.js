/**
 * pipeline.js — Multi-stage pipeline with per-stage thread pools.
 * Stages: search → download → analyse (quality check + fingerprint)
 * Each stage has its own queue and configurable thread count.
 * Queue is persisted to DB so it survives restarts.
 */
const fs = require('fs');
const path = require('path');
const { searchTrack } = require('./search');
const { downloadTrack } = require('./downloader');
const { analyseTrack } = require('./analyser');
const db = require('./db');

let broadcastFn = null;
let logFn = null;
let workspacePath = '';
let paused = false;

let cachedDelay = null;
function getRequestDelay() {
  if (cachedDelay !== null) return cachedDelay;
  try {
    const config = JSON.parse(require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'config.json'), 'utf-8'
    ));
    cachedDelay = (config.request_delay ?? 2) * 1000;
  } catch { cachedDelay = 2000; }
  return cachedDelay;
}
function invalidateDelayCache() { cachedDelay = null; }

function sleep(ms) {
  return ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();
}

// Per-stage state
const stages = {
  search: { queue: [], workers: [], numThreads: 3 },
  download: { queue: [], workers: [], numThreads: 1 },
  analyse: { queue: [], workers: [], numThreads: 2 },
};

function init(opts) {
  broadcastFn = opts.broadcast;
  logFn = opts.log;
  workspacePath = opts.workspacePath;
}

function setWorkspace(wsPath) {
  workspacePath = wsPath;
}

// ── Enqueue ──

function enqueue(keys, threadConfig, mode) {
  if (threadConfig) {
    if (threadConfig.search) stages.search.numThreads = threadConfig.search;
    if (threadConfig.download) stages.download.numThreads = threadConfig.download;
    if (threadConfig.analyse) stages.analyse.numThreads = threadConfig.analyse;
  }

  // Collect all enqueue operations first, then batch the DB writes in one transaction
  const toEnqueue = [];
  for (const key of keys) {
    if (isQueued(key) || isActive(key)) continue;
    const track = db.getTrack(key);
    if (!track) continue;

    let targetStage = null;
    if (mode === 'search') {
      targetStage = 'search';
    } else if (mode === 'download') {
      if (track.status === 'searched' || track.selected_url) targetStage = 'download';
    } else if (mode === 'analyse') {
      if (track.status === 'complete' || track.status === 'downloaded' || track.file_path) targetStage = 'analyse';
    } else if (mode === 'full') {
      if (track.status === 'searched' && track.selected_url) {
        targetStage = 'download';
      } else {
        targetStage = 'search';
      }
    }

    if (!targetStage) continue;
    toEnqueue.push({ key, track, targetStage, continueFullPipeline: mode === 'full' });
  }

  // Single transaction for all DB updates
  if (toEnqueue.length > 0) {
    batchUpdateStatus(toEnqueue.map(item => ({
      key: item.key,
      status: 'queued',
      extra: {
        queue_stage: item.targetStage,
        queue_mode: item.continueFullPipeline ? 'full' : item.targetStage,
      },
    })));
  }

  // Now push to in-memory queues
  for (const item of toEnqueue) {
    stages[item.targetStage].queue.push({
      key: item.key,
      track: item.track,
      continueFullPipeline: item.continueFullPipeline,
    });
    queuedKeys.add(item.key);
  }

  const added = toEnqueue.length;

  logFn(`Queued ${added} tracks (mode: ${mode})`);
  broadcastProgress(true);
  if (!paused) fillAllStages();
}

/** Restore queued tracks from DB after restart */
function restoreQueue() {
  if (!db.get()) return 0;
  const queued = db.getQueuedTracks();
  let restored = 0;
  for (const t of queued) {
    const stage = t.queue_stage || 'search';
    if (!stages[stage]) continue;
    if (isQueued(t.key) || isActive(t.key)) continue;
    stages[stage].queue.push({
      key: t.key,
      track: t,
      continueFullPipeline: t.queue_mode === 'full',
    });
    queuedKeys.add(t.key);
    restored++;
  }
  if (restored > 0) {
    paused = true;
    markAllDirty();
    logFn(`Restored ${restored} queued track(s) from previous session — press Resume to continue`);
    broadcastProgress(true);
  }
  return restored;
}

// Fast lookup sets — maintained alongside the queues/workers
const queuedKeys = new Set();
const activeKeys = new Set();

function isQueued(key) {
  return queuedKeys.has(key);
}

function isActive(key) {
  return activeKeys.has(key);
}

// ── Worker management ──

function fillAllStages() {
  if (paused) return;
  for (const stageName of ['search', 'download', 'analyse']) {
    fillStage(stageName);
  }
}

function fillStage(stageName) {
  if (paused) return;
  const stage = stages[stageName];

  // Ensure enough worker slots
  while (stage.workers.length < stage.numThreads) {
    stage.workers.push({
      id: stage.workers.length + 1,
      busy: false,
      key: null,
      track: null,
      detail: '',
    });
  }

  for (const worker of stage.workers.slice(0, stage.numThreads)) {
    if (worker.busy || stage.queue.length === 0) continue;

    const item = stage.queue.shift();
    queuedKeys.delete(item.key);
    activeKeys.add(item.key);
    worker.busy = true;
    worker.key = item.key;
    worker.track = item.track;
    worker.detail = '';

    runStageWorker(stageName, worker, item);
  }

  broadcastProgress(true);
}

async function runStageWorker(stageName, worker, item) {
  const { key, track, continueFullPipeline } = item;

  try {
    if (stageName === 'search') {
      await runSearch(worker, key, track);
    } else if (stageName === 'download') {
      await runDownload(worker, key, track);
    } else if (stageName === 'analyse') {
      await runAnalyse(worker, key, track);
    }

    // In full pipeline mode, advance to the next stage
    if (continueFullPipeline && !paused) {
      const updatedTrack = db.getTrack(key);
      if (stageName === 'search' && updatedTrack && updatedTrack.status === 'searched') {
        updateStatus(key, 'queued', { queue_stage: 'download', queue_mode: 'full' });
        stages.download.queue.push({ key, track: updatedTrack, continueFullPipeline: true });
        queuedKeys.add(key);
      } else if (stageName === 'download' && updatedTrack && (updatedTrack.status === 'downloaded' || updatedTrack.status === 'complete')) {
        updateStatus(key, 'queued', { queue_stage: 'analyse', queue_mode: 'full' });
        stages.analyse.queue.push({ key, track: updatedTrack, continueFullPipeline: true });
        queuedKeys.add(key);
      }
    }
  } catch (err) {
    updateStatus(key, 'failed', { error: err.message, queue_stage: '', queue_mode: '' });
    logFn(`Pipeline error [${stageName}] "${track.artist} - ${track.title}": ${err.message}`, 'error');
  }

  // Release worker
  activeKeys.delete(key);
  worker.busy = false;
  worker.key = null;
  worker.track = null;
  worker.detail = '';

  // Check if everything is done
  const anyBusy = Object.values(stages).some(s => s.workers.some(w => w.busy));
  const anyQueued = Object.values(stages).some(s => s.queue.length > 0);
  if (!anyBusy && !anyQueued) {
    logFn('Pipeline complete');
  }

  broadcastProgress(true);
  if (!paused) {
    // Delay between YouTube requests to avoid rate limiting
    if (stageName === 'search' || stageName === 'download') {
      const delay = getRequestDelay();
      if (delay > 0) {
        worker.detail = `Waiting ${delay / 1000}s (rate limit)...`;
        broadcastProgress();
        await sleep(delay);
      }
    }
    setImmediate(() => fillAllStages());
  }
}

// ── Stop / Pause / Resume ──

function stop() {
  paused = false;
  // Clear all in-memory queues
  for (const stage of Object.values(stages)) {
    stage.queue = [];
  }
  queuedKeys.clear();
  // Reset all queued tracks in DB back to their pre-queue state
  db.resetQueuedTracks();
  markAllDirty();
  logFn('Pipeline stopped — queue cleared');
  broadcastProgress(true);
}

function pause() {
  paused = true;
  logFn('Pipeline paused — current threads will finish, queue is held');
  broadcastProgress(true);
}

function resume() {
  if (!paused) return;
  paused = false;
  cleanup();
  logFn('Pipeline resumed');
  broadcastProgress(true);
  fillAllStages();
}

function isPaused() {
  return paused;
}

// ── Cleanup ──

/** Run on startup and before resume to ensure consistent state */
function cleanup() {
  if (!db.get()) return;

  // 1. Recover tracks stuck in intermediate statuses (searching/downloading/checking)
  const recovered = db.recoverStuckTracks();
  if (recovered > 0) {
    logFn(`Recovered ${recovered} track(s) from interrupted state`);
  }

  // 2. Delete partial downloads in temp folder
  if (workspacePath) {
    const tempDir = path.join(workspacePath, 'temp');
    if (fs.existsSync(tempDir)) {
      const tempFiles = fs.readdirSync(tempDir);
      if (tempFiles.length > 0) {
        for (const f of tempFiles) {
          try { fs.unlinkSync(path.join(tempDir, f)); } catch {}
        }
        logFn(`Cleaned up ${tempFiles.length} partial file(s) from temp`);
      }
    }
  }

  // 3. Verify file_path entries exist for downloaded/complete tracks
  if (db.get()) {
    const tracks = db.get().prepare(
      `SELECT key, file_path FROM tracks WHERE status IN ('downloaded', 'complete') AND file_path != ''`
    ).all();
    const orphanedKeys = tracks
      .filter(t => !fs.existsSync(t.file_path))
      .map(t => t.key);
    if (orphanedKeys.length > 0) {
      batchUpdateStatus(orphanedKeys.map(key => ({
        key,
        status: 'failed',
        extra: { error: 'Downloaded file missing', file_path: '', queue_stage: '', queue_mode: '' },
      })));
      logFn(`Found ${orphanedKeys.length} track(s) with missing files — marked as failed`);
    }
  }
}

// ── Stage implementations ──

async function runSearch(worker, key, track) {
  worker.detail = 'Starting search...';
  updateStatus(key, 'searching', { queue_stage: '', queue_mode: '' });
  broadcastProgress(true);

  const result = await searchTrack(track, workspacePath, (msg) => {
    worker.detail = msg.replace(/^\s+/, '');
    broadcastProgress();
    logFn(msg);
  }, { delayMs: getRequestDelay() });

  if (result.candidates.length > 0) {
    db.insertCandidates(key, result.candidates);
    updateStatus(key, 'searched', {
      selected_url: result.best.url,
      searched_at: new Date().toISOString(),
    });
    logFn(`Search complete: "${track.artist} - ${track.title}" → ${result.candidates.length} candidates`);
  } else {
    updateStatus(key, 'failed', { error: 'No search results found' });
    logFn(`Search failed: "${track.artist} - ${track.title}" — no results`, 'warn');
  }
}

async function runDownload(worker, key, track) {
  const currentTrack = db.getTrack(key);
  const url = currentTrack?.selected_url || track.selected_url;

  if (!url) {
    updateStatus(key, 'failed', { error: 'No URL selected for download' });
    logFn(`Download failed: "${track.artist} - ${track.title}" — no URL selected`, 'error');
    return;
  }

  worker.detail = 'Starting download...';
  updateStatus(key, 'downloading', { queue_stage: '', queue_mode: '' });
  broadcastProgress(true);

  const result = await downloadTrack({
    url,
    track,
    workspacePath,
    onProgress: (msg) => {
      worker.detail = msg.replace(/^\s+/, '');
      broadcastProgress();
      logFn(msg);
    },
  });

  if (result.success) {
    updateStatus(key, 'downloaded', {
      file_path: result.filePath,
      downloaded_at: new Date().toISOString(),
    });
    logFn(`Download complete: "${track.artist} - ${track.title}" → ${result.filePath}`);
  } else {
    updateStatus(key, 'failed', { error: result.error || 'Download failed' });
    logFn(`Download failed: "${track.artist} - ${track.title}" — ${result.error}`, 'error');
  }
}

async function runAnalyse(worker, key, track) {
  const currentTrack = db.getTrack(key);
  const filePath = currentTrack?.file_path || track.file_path;

  if (!filePath || !fs.existsSync(filePath)) {
    updateStatus(key, 'failed', { error: 'No downloaded file found for analysis' });
    logFn(`Analyse failed: "${track.artist} - ${track.title}" — no file`, 'error');
    return;
  }

  worker.detail = 'Starting analysis...';
  updateStatus(key, 'checking', { queue_stage: '', queue_mode: '' });
  broadcastProgress(true);

  const result = await analyseTrack({
    filePath,
    track,
    workspacePath,
    onProgress: (msg) => {
      worker.detail = msg.replace(/^\s+/, '');
      broadcastProgress();
      logFn(msg);
    },
  });

  // Store quality data
  const updates = {};
  if (result.quality) {
    updates.quality = result.quality['Estimated Quality'] || '';
    updates.sample_rate = result.quality['Sample Rate (Hz)'] || '';
    updates.peak_freq = result.quality['Peak Frequency (Hz)'] || '';
    updates.lossless = result.quality['Lossless'] || '';
  }

  // Store fingerprint data
  if (result.fingerprint) {
    if (result.fingerprint.topMatch) {
      updates.match_confidence = result.fingerprint.topMatch.confidence || 0;
      updates.match_artist = result.fingerprint.topMatch.artist || '';
      updates.match_title = result.fingerprint.topMatch.title || '';
    }
  }

  updates.status = 'complete';
  const sets = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  updates.key = key;
  db.get().prepare(`UPDATE tracks SET ${sets} WHERE key = @key`).run(updates);
  markDirty(key);

  logFn(`Analysis complete: "${track.artist} - ${track.title}" — ` +
    `quality=${updates.quality || '?'} lossless=${updates.lossless || '?'} ` +
    `match=${updates.match_confidence ? (updates.match_confidence * 100).toFixed(1) + '%' : 'n/a'}`);
}

// ── Helpers ──

// Dirty tracking: only fetch changed tracks instead of the full table
const dirtyKeys = new Set();
let broadcastTimer = null;
let fullBroadcastNeeded = false;
let needsFullSync = true; // First broadcast after connect should be full

function markDirty(key) { dirtyKeys.add(key); }
function markAllDirty() { needsFullSync = true; }

// Wrapped DB helpers that auto-mark dirty
function updateStatus(key, status, extra) {
  db.updateTrackStatus(key, status, extra);
  markDirty(key);
}
function batchUpdateStatus(items) {
  db.batchUpdateStatus(items);
  markAllDirty();
}

function broadcastProgress(statusChanged = false) {
  if (!broadcastFn) return;

  if (statusChanged) {
    fullBroadcastNeeded = true;
  }

  if (broadcastTimer) return;

  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    doBroadcast(fullBroadcastNeeded);
    fullBroadcastNeeded = false;
  }, fullBroadcastNeeded ? 0 : 500);
}

function doBroadcast(includeTrackUpdates) {
  if (!broadcastFn) return;

  const threadData = [];
  for (const [stageName, stage] of Object.entries(stages)) {
    for (const w of stage.workers.slice(0, stage.numThreads)) {
      threadData.push({
        id: `${stageName[0].toUpperCase()}${w.id}`,
        stage: stageName,
        idle: !w.busy,
        trackKey: w.key || null,
        track: w.track ? `${w.track.artist} - ${w.track.title}` : null,
        detail: w.detail || null,
      });
    }
  }

  const totalPending = Object.values(stages).reduce((n, s) => n + s.queue.length, 0);
  const totalActive = Object.values(stages).reduce((n, s) => n + s.workers.filter(w => w.busy).length, 0);

  const msg = { type: 'downloadProgress', threads: threadData, paused };

  if (includeTrackUpdates) {
    // Build pending queue list from in-memory data (no DB hit)
    const pending = [];
    for (const [stageName, stage] of Object.entries(stages)) {
      for (const q of stage.queue) {
        pending.push({
          position: pending.length + 1,
          track: `${q.track.artist} - ${q.track.title}`,
          stage: stageName,
        });
      }
    }
    msg.pending = pending;

    if (needsFullSync) {
      // Full sync: read all tracks (only on first broadcast or after bulk ops)
      const allTracks = db.getAllTracks();
      msg.stats = {
        pending: totalPending,
        active: totalActive,
        done: allTracks.filter(t => t.status === 'searched' || t.status === 'complete' || t.status === 'downloaded').length,
        failed: allTracks.filter(t => t.status === 'failed').length,
        paused,
      };
      msg.updates = allTracks
        .filter(t => t.status !== 'ready')
        .map(t => ({
          key: t.key, status: t.status, quality: t.quality,
          sample_rate: t.sample_rate, peak_freq: t.peak_freq, lossless: t.lossless,
          match_confidence: t.match_confidence, match_artist: t.match_artist,
          match_title: t.match_title, error: t.error,
        }));
      needsFullSync = false;
      dirtyKeys.clear();
    } else if (dirtyKeys.size > 0) {
      // Incremental: only fetch tracks that changed
      const updates = [];
      for (const key of dirtyKeys) {
        const t = db.getTrack(key);
        if (t) {
          updates.push({
            key: t.key, status: t.status, quality: t.quality,
            sample_rate: t.sample_rate, peak_freq: t.peak_freq, lossless: t.lossless,
            match_confidence: t.match_confidence, match_artist: t.match_artist,
            match_title: t.match_title, error: t.error,
          });
        }
      }
      msg.updates = updates;
      // Stats from a lightweight count query instead of loading all tracks
      const counts = db.get().prepare(
        `SELECT status, COUNT(*) as cnt FROM tracks GROUP BY status`
      ).all();
      const statusMap = {};
      for (const r of counts) statusMap[r.status] = r.cnt;
      msg.stats = {
        pending: totalPending,
        active: totalActive,
        done: (statusMap.searched || 0) + (statusMap.complete || 0) + (statusMap.downloaded || 0),
        failed: statusMap.failed || 0,
        paused,
      };
      dirtyKeys.clear();
    } else {
      // No dirty keys but status change flag set (e.g. pause/resume)
      msg.stats = { pending: totalPending, active: totalActive, paused };
    }
  } else {
    msg.stats = { pending: totalPending, active: totalActive, paused };
  }

  broadcastFn(msg);
}

function setThreads(config) {
  if (config.search) stages.search.numThreads = config.search;
  if (config.download) stages.download.numThreads = config.download;
  if (config.analyse) stages.analyse.numThreads = config.analyse;
  broadcastProgress(true);
  if (!paused) fillAllStages();
}

function shutdown() {
  for (const stage of Object.values(stages)) {
    stage.queue = [];
  }
  queuedKeys.clear();
  activeKeys.clear();
}

module.exports = {
  init, setWorkspace, enqueue, restoreQueue, cleanup,
  stop, pause, resume, isPaused,
  setThreads, shutdown, broadcastProgress, markAllDirty, invalidateDelayCache,
};
