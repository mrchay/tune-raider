/**
 * pipeline.js — Multi-stage pipeline with per-stage thread pools.
 * Stages: search → download → analyse (quality check + fingerprint)
 * Each stage has its own queue and configurable thread count.
 */
const { searchTrack } = require('./search');
const { downloadTrack } = require('./downloader');
const { analyseTrack } = require('./analyser');
const db = require('./db');

let broadcastFn = null;
let logFn = null;
let workspacePath = '';

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
  // Update thread counts from config
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
    // Explicit mode requests always allow re-running that stage
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

    db.updateTrackStatus(key, 'queued');
    stages[targetStage].queue.push({ key, track, continueFullPipeline: mode === 'full' });
    added++;
  }

  logFn(`Queued ${added} tracks (mode: ${mode})`);
  broadcastProgress();
  fillAllStages();
}

function isQueued(key) {
  return Object.values(stages).some(s => s.queue.some(q => q.key === key));
}

function isActive(key) {
  return Object.values(stages).some(s => s.workers.some(w => w.busy && w.key === key));
}

// ── Worker management ──

function fillAllStages() {
  for (const stageName of ['search', 'download', 'analyse']) {
    fillStage(stageName);
  }
}

function fillStage(stageName) {
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
    if (continueFullPipeline) {
      const updatedTrack = db.getTrack(key);
      if (stageName === 'search' && updatedTrack && updatedTrack.status === 'searched') {
        stages.download.queue.push({ key, track: updatedTrack, continueFullPipeline: true });
      } else if (stageName === 'download' && updatedTrack && (updatedTrack.status === 'downloaded' || updatedTrack.status === 'complete')) {
        stages.analyse.queue.push({ key, track: updatedTrack, continueFullPipeline: true });
      }
    }
  } catch (err) {
    db.updateTrackStatus(key, 'failed', { error: err.message });
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
  setImmediate(() => fillAllStages());
}

// ── Stage implementations ──

async function runSearch(worker, key, track) {
  worker.detail = 'Starting search...';
  db.updateTrackStatus(key, 'searching');
  broadcastProgress();

  const result = await searchTrack(track, workspacePath, (msg) => {
    worker.detail = msg.replace(/^\s+/, '');
    broadcastProgress();
    logFn(msg);
  });

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
  db.updateTrackStatus(key, 'downloading');
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

  if (!filePath || !require('fs').existsSync(filePath)) {
    db.updateTrackStatus(key, 'failed', { error: 'No downloaded file found for analysis' });
    logFn(`Analyse failed: "${track.artist} - ${track.title}" — no file`, 'error');
    return;
  }

  worker.detail = 'Starting analysis...';
  db.updateTrackStatus(key, 'checking');
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

  // Build thread data grouped by stage
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

  // Stats
  const allTracks = db.getAllTracks();
  const totalPending = Object.values(stages).reduce((n, s) => n + s.queue.length, 0);
  const totalActive = Object.values(stages).reduce((n, s) => n + s.workers.filter(w => w.busy).length, 0);
  const stats = {
    pending: totalPending,
    active: totalActive,
    done: allTracks.filter(t => t.status === 'searched' || t.status === 'complete' || t.status === 'downloaded').length,
    failed: allTracks.filter(t => t.status === 'failed').length,
  };

  // Pending queue items
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

  // Track status updates
  const updates = allTracks
    .filter(t => t.status !== 'ready')
    .map(t => ({ key: t.key, status: t.status }));

  broadcastFn({ type: 'downloadProgress', threads: threadData, stats, pending, updates });
}

function setThreads(config) {
  if (config.search) stages.search.numThreads = config.search;
  if (config.download) stages.download.numThreads = config.download;
  if (config.analyse) stages.analyse.numThreads = config.analyse;
  broadcastProgress();
  // If increased, fill any newly available slots
  fillAllStages();
}

function shutdown() {
  // Clear all queues
  for (const stage of Object.values(stages)) {
    stage.queue = [];
  }
}

module.exports = { init, setWorkspace, enqueue, setThreads, shutdown };
