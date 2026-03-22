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

function getRequestDelay() {
  try {
    const config = JSON.parse(require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'config.json'), 'utf-8'
    ));
    return (config.request_delay ?? 2) * 1000;
  } catch { return 2000; }
}

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

  let added = 0;
  for (const key of keys) {
    if (isQueued(key) || isActive(key)) continue;
    const track = db.getTrack(key);
    if (!track) continue;

    // Determine which stage to enter based on mode and track status
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

    const continueFullPipeline = mode === 'full';
    db.updateTrackStatus(key, 'queued', {
      queue_stage: targetStage,
      queue_mode: continueFullPipeline ? 'full' : targetStage,
    });
    stages[targetStage].queue.push({ key, track, continueFullPipeline });
    added++;
  }

  logFn(`Queued ${added} tracks (mode: ${mode})`);
  broadcastProgress();
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
    restored++;
  }
  if (restored > 0) {
    paused = true;
    logFn(`Restored ${restored} queued track(s) from previous session — press Resume to continue`);
    broadcastProgress();
  }
  return restored;
}

function isQueued(key) {
  return Object.values(stages).some(s => s.queue.some(q => q.key === key));
}

function isActive(key) {
  return Object.values(stages).some(s => s.workers.some(w => w.busy && w.key === key));
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
    worker.busy = true;
    worker.key = item.key;
    worker.track = item.track;
    worker.detail = '';

    runStageWorker(stageName, worker, item);
  }

  broadcastProgress();
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
        db.updateTrackStatus(key, 'queued', { queue_stage: 'download', queue_mode: 'full' });
        stages.download.queue.push({ key, track: updatedTrack, continueFullPipeline: true });
      } else if (stageName === 'download' && updatedTrack && (updatedTrack.status === 'downloaded' || updatedTrack.status === 'complete')) {
        db.updateTrackStatus(key, 'queued', { queue_stage: 'analyse', queue_mode: 'full' });
        stages.analyse.queue.push({ key, track: updatedTrack, continueFullPipeline: true });
      }
    }
  } catch (err) {
    db.updateTrackStatus(key, 'failed', { error: err.message, queue_stage: '', queue_mode: '' });
    logFn(`Pipeline error [${stageName}] "${track.artist} - ${track.title}": ${err.message}`, 'error');
  }

  // Release worker
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

  broadcastProgress();
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
  // Reset all queued tracks in DB back to their pre-queue state
  db.resetQueuedTracks();
  logFn('Pipeline stopped — queue cleared');
  broadcastProgress();
}

function pause() {
  paused = true;
  logFn('Pipeline paused — current threads will finish, queue is held');
  broadcastProgress();
}

function resume() {
  if (!paused) return;
  paused = false;
  // Run cleanup before resuming
  cleanup();
  logFn('Pipeline resumed');
  broadcastProgress();
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
      `SELECT key, file_path, status FROM tracks WHERE status IN ('downloaded', 'complete') AND file_path != ''`
    ).all();
    let orphaned = 0;
    for (const t of tracks) {
      if (!fs.existsSync(t.file_path)) {
        db.updateTrackStatus(t.key, 'failed', {
          error: 'Downloaded file missing',
          file_path: '',
          queue_stage: '',
          queue_mode: '',
        });
        orphaned++;
      }
    }
    if (orphaned > 0) {
      logFn(`Found ${orphaned} track(s) with missing files — marked as failed`);
    }
  }
}

// ── Stage implementations ──

async function runSearch(worker, key, track) {
  worker.detail = 'Starting search...';
  db.updateTrackStatus(key, 'searching', { queue_stage: '', queue_mode: '' });
  broadcastProgress();

  const result = await searchTrack(track, workspacePath, (msg) => {
    worker.detail = msg.replace(/^\s+/, '');
    broadcastProgress();
    logFn(msg);
  }, { delayMs: getRequestDelay() });

  if (result.candidates.length > 0) {
    db.insertCandidates(key, result.candidates);
    db.updateTrackStatus(key, 'searched', {
      selected_url: result.best.url,
      searched_at: new Date().toISOString(),
    });
    logFn(`Search complete: "${track.artist} - ${track.title}" → ${result.candidates.length} candidates`);
  } else {
    db.updateTrackStatus(key, 'failed', { error: 'No search results found' });
    logFn(`Search failed: "${track.artist} - ${track.title}" — no results`, 'warn');
  }
}

async function runDownload(worker, key, track) {
  const currentTrack = db.getTrack(key);
  const url = currentTrack?.selected_url || track.selected_url;

  if (!url) {
    db.updateTrackStatus(key, 'failed', { error: 'No URL selected for download' });
    logFn(`Download failed: "${track.artist} - ${track.title}" — no URL selected`, 'error');
    return;
  }

  worker.detail = 'Starting download...';
  db.updateTrackStatus(key, 'downloading', { queue_stage: '', queue_mode: '' });
  broadcastProgress();

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
    db.updateTrackStatus(key, 'downloaded', {
      file_path: result.filePath,
      downloaded_at: new Date().toISOString(),
    });
    logFn(`Download complete: "${track.artist} - ${track.title}" → ${result.filePath}`);
  } else {
    db.updateTrackStatus(key, 'failed', { error: result.error || 'Download failed' });
    logFn(`Download failed: "${track.artist} - ${track.title}" — ${result.error}`, 'error');
  }
}

async function runAnalyse(worker, key, track) {
  const currentTrack = db.getTrack(key);
  const filePath = currentTrack?.file_path || track.file_path;

  if (!filePath || !fs.existsSync(filePath)) {
    db.updateTrackStatus(key, 'failed', { error: 'No downloaded file found for analysis' });
    logFn(`Analyse failed: "${track.artist} - ${track.title}" — no file`, 'error');
    return;
  }

  worker.detail = 'Starting analysis...';
  db.updateTrackStatus(key, 'checking', { queue_stage: '', queue_mode: '' });
  broadcastProgress();

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

  logFn(`Analysis complete: "${track.artist} - ${track.title}" — ` +
    `quality=${updates.quality || '?'} lossless=${updates.lossless || '?'} ` +
    `match=${updates.match_confidence ? (updates.match_confidence * 100).toFixed(1) + '%' : 'n/a'}`);
}

// ── Helpers ──

function broadcastProgress() {
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

  const allTracks = db.getAllTracks();
  const totalPending = Object.values(stages).reduce((n, s) => n + s.queue.length, 0);
  const totalActive = Object.values(stages).reduce((n, s) => n + s.workers.filter(w => w.busy).length, 0);
  const stats = {
    pending: totalPending,
    active: totalActive,
    done: allTracks.filter(t => t.status === 'searched' || t.status === 'complete' || t.status === 'downloaded').length,
    failed: allTracks.filter(t => t.status === 'failed').length,
    paused,
  };

  const pending = [];
  for (const [stageName, stage] of Object.entries(stages)) {
    for (let i = 0; i < stage.queue.length; i++) {
      const q = stage.queue[i];
      pending.push({
        position: pending.length + 1,
        track: `${q.track.artist} - ${q.track.title}`,
        stage: stageName,
      });
    }
  }

  // Track status updates (include analysis fields so frontend updates live)
  const updates = allTracks
    .filter(t => t.status !== 'ready')
    .map(t => ({
      key: t.key,
      status: t.status,
      quality: t.quality,
      sample_rate: t.sample_rate,
      peak_freq: t.peak_freq,
      lossless: t.lossless,
      match_confidence: t.match_confidence,
      match_artist: t.match_artist,
      match_title: t.match_title,
      error: t.error,
    }));

  broadcastFn({ type: 'downloadProgress', threads: threadData, stats, pending, updates });
}

function setThreads(config) {
  if (config.search) stages.search.numThreads = config.search;
  if (config.download) stages.download.numThreads = config.download;
  if (config.analyse) stages.analyse.numThreads = config.analyse;
  broadcastProgress();
  if (!paused) fillAllStages();
}

function shutdown() {
  for (const stage of Object.values(stages)) {
    stage.queue = [];
  }
}

module.exports = {
  init, setWorkspace, enqueue, restoreQueue, cleanup,
  stop, pause, resume, isPaused,
  setThreads, shutdown, broadcastProgress,
};
