const WS_URL = 'ws://localhost:9600';

let ws;
let reconnectTimer;

// ── State ──

let allTracks = [];
let playlists = [];
let selectedKeys = new Set();
let activePlaylist = '';
let expandedKey = null;     // currently expanded track
let candidateCache = {};    // trackKey → candidates[]
let threads = [];
let activeTrackKeys = new Set();  // keys currently being processed by a worker

// ── WebSocket ──

function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setStatus(true);
    clearTimeout(reconnectTimer);
    appendConsole('Connected to backend', 'info');
    send('getWorkspace');
    send('getTracks');
    send('checkYtStatus');
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleMessage(msg);
  };

  ws.onclose = () => {
    setStatus(false);
    appendConsole('Disconnected from backend', 'warn');
    reconnectTimer = setTimeout(connect, 2000);
  };

  ws.onerror = () => ws.close();
}

function send(type, payload = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function setStatus(connected) {
  const el = document.getElementById('conn');
  el.textContent = connected ? 'Connected' : 'Disconnected';
  el.className = 'status' + (connected ? ' connected' : '');
}

// ── Message handler ──

function handleMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      break;

    case 'workspace':
      document.getElementById('workspace-path').value = msg.path || '';
      if (msg.error) {
        setWorkspaceStatus('Workspace failed to load: ' + msg.error, 'error');
        openSettings();
      } else if (msg.path) {
        setWorkspaceStatus('Workspace: ' + msg.path, 'ok');
      } else {
        setWorkspaceStatus('No workspace configured', 'error');
        openSettings();
      }
      break;

    case 'workspaceSet':
      document.getElementById('workspace-path').value = msg.path;
      setWorkspaceStatus(msg.created ? 'Workspace created' : 'Workspace set', 'ok');
      send('getTracks');
      break;

    case 'tracks':
      allTracks = msg.tracks || [];
      playlists = msg.playlists || [];
      rebuildPlaylistSidebar();
      rebuildFilterPlaylist();
      renderTracks();
      updateActionButton();
      break;

    case 'importResult':
      if (msg.error) {
        console.error('Import failed:', msg.error);
      } else {
        showToast(`Imported: ${msg.filename} (${msg.count} tracks)`);
        send('getTracks');
      }
      break;

    case 'playlistAutoImported':
      showToast(`Auto-imported: ${msg.filename} (${msg.count} tracks)`);
      send('getTracks');
      break;

    case 'candidates':
      candidateCache[msg.trackKey] = msg.candidates;
      renderExpandedRow(msg.trackKey);
      break;

    case 'candidateSelected':
      if (candidateCache[msg.trackKey]) {
        for (const c of candidateCache[msg.trackKey]) {
          c.selected = c.id === msg.candidateId ? 1 : 0;
        }
        renderExpandedRow(msg.trackKey);
      }
      break;

    case 'trackReset':
    case 'tracksReset':
    case 'tracksDeleted':
      send('getTracks');
      break;

    case 'playlistDeleted':
      showToast(`Deleted: ${msg.name}`);
      if (activePlaylist === msg.name) activePlaylist = '';
      send('getTracks');
      break;

    case 'downloadProgress':
      // Track which keys have active workers
      activeTrackKeys = new Set();
      if (msg.threads) {
        for (const t of msg.threads) {
          if (!t.idle && t.trackKey) activeTrackKeys.add(t.trackKey);
        }
      }
      updateThreads(msg.threads);
      updatePendingQueue(msg.pending);
      updateDockStats(msg.stats);
      if (msg.updates) {
        for (const u of msg.updates) {
          const t = allTracks.find(t => t.key === u.key);
          if (t) {
            if (t.status !== u.status) {
              delete candidateCache[u.key];
            }
            Object.assign(t, u);
          }
        }
        renderTracks();
        updateActionButton();
      }
      break;

    case 'log':
      appendConsole(msg.message, msg.level || 'log');
      break;

    case 'ytStatus':
      setYtStatus(msg.status, msg.label);
      break;

    case 'cookiesImported':
      document.getElementById('cookie-status').textContent = msg.message;
      document.getElementById('cookie-status').className = 'cookie-status ok';
      break;

    case 'config':
      if (msg.acoustid_api_key) {
        document.getElementById('acoustid-key').value = msg.acoustid_api_key;
      }
      document.getElementById('request-delay').value = msg.request_delay ?? 2;
      break;

    case 'error':
      console.error('Server error:', msg.message);
      appendConsole(msg.message, 'error');
      break;
  }
}

// ── Playlist sidebar ──

function rebuildPlaylistSidebar() {
  const ul = document.getElementById('playlist-list');
  ul.innerHTML = '';

  const exportBtn = document.getElementById('btn-exportify');
  if (playlists.length === 0) {
    exportBtn.classList.add('pulse');
  } else {
    exportBtn.classList.remove('pulse');
  }

  const liAll = document.createElement('li');
  liAll.dataset.playlist = '';
  if (!activePlaylist) liAll.classList.add('active');
  liAll.innerHTML = `All Tracks <span class="count">${allTracks.length}</span>`;
  ul.appendChild(liAll);

  for (const pl of playlists) {
    const li = document.createElement('li');
    li.dataset.playlist = pl.name;
    if (activePlaylist === pl.name) li.classList.add('active');
    li.innerHTML = `
      <span class="playlist-name">${esc(pl.name)}</span>
      <span class="playlist-right">
        <span class="count">${pl.count}</span>
        <button class="delete-playlist-btn" data-playlist="${esc(pl.name)}" title="Delete playlist">&#128465;</button>
      </span>
    `;
    ul.appendChild(li);
  }
}

document.getElementById('playlist-list').addEventListener('click', (e) => {
  // Delete button
  const delBtn = e.target.closest('.delete-playlist-btn');
  if (delBtn) {
    e.stopPropagation();
    const name = delBtn.dataset.playlist;
    if (confirm(`Delete playlist "${name}"?\n\nThis will remove the CSV file and all tracks from the database.`)) {
      send('deletePlaylist', { name });
    }
    return;
  }

  const li = e.target.closest('li');
  if (!li) return;
  activePlaylist = li.dataset.playlist;
  document.querySelectorAll('#playlist-list li').forEach(l => l.classList.remove('active'));
  li.classList.add('active');
  document.getElementById('filter-playlist').value = activePlaylist;
  renderTracks();
});

function rebuildFilterPlaylist() {
  const sel = document.getElementById('filter-playlist');
  sel.innerHTML = '<option value="">All playlists</option>';
  for (const pl of playlists) {
    const opt = document.createElement('option');
    opt.value = pl.name;
    opt.textContent = pl.name;
    sel.appendChild(opt);
  }
}

// ── Track table ──

function getVisibleTracks() {
  const textFilter = document.getElementById('filter-text').value.toLowerCase();
  const statusFilter = document.getElementById('filter-status').value;
  const playlistFilter = document.getElementById('filter-playlist').value || activePlaylist;
  const qualityFilter = document.getElementById('filter-quality').value;
  const matchFilter = document.getElementById('filter-match').value;

  return allTracks.filter(t => {
    if (playlistFilter && t.playlist !== playlistFilter) return false;
    if (statusFilter) {
      const activeStates = ['searching', 'downloading', 'checking', 'fingerprinting'];
      if (statusFilter === 'active' && !activeStates.includes(t.status)) return false;
      else if (statusFilter === 'downloaded' && t.status !== 'complete') return false;
      else if (statusFilter === 'ready' && t.status !== 'ready') return false;
      else if (statusFilter === 'failed' && t.status !== 'failed') return false;
      else if (statusFilter === 'queued' && t.status !== 'queued') return false;
      else if (statusFilter === 'searched' && t.status !== 'searched') return false;
    }
    if (qualityFilter) {
      const q = parseInt(t.quality) || 0;
      if (qualityFilter === 'lossless' && t.lossless !== 'Yes') return false;
      else if (qualityFilter === '320' && q < 320) return false;
      else if (qualityFilter === '256' && q < 256) return false;
      else if (qualityFilter === '192' && q < 192) return false;
      else if (qualityFilter === 'low' && (q >= 192 || !t.quality)) return false;
      else if (qualityFilter === 'none' && t.quality) return false;
    }
    if (matchFilter) {
      const m = t.match_confidence || 0;
      if (matchFilter === 'verified' && m < 0.8) return false;
      else if (matchFilter === 'partial' && (m < 0.5 || m >= 0.8)) return false;
      else if (matchFilter === 'poor' && (m >= 0.5 || m === 0)) return false;
      else if (matchFilter === 'none' && m > 0) return false;
    }
    if (textFilter) {
      const hay = (t.title + ' ' + t.artist + ' ' + t.album).toLowerCase();
      if (!hay.includes(textFilter)) return false;
    }
    return true;
  });
}

function renderTracks() {
  const tbody = document.getElementById('track-body');
  const empty = document.getElementById('track-empty');
  const visible = getVisibleTracks();

  empty.style.display = visible.length ? 'none' : 'block';

  tbody.innerHTML = '';
  for (const t of visible) {
    const tr = document.createElement('tr');
    if (selectedKeys.has(t.key)) tr.classList.add('selected');
    tr.dataset.key = t.key;
    tr.className = 'track-row' + (selectedKeys.has(t.key) ? ' selected' : '');
    const isExpanded = expandedKey === t.key;
    tr.innerHTML = `
      <td class="col-expand"><span class="expand-arrow ${isExpanded ? 'expanded' : ''}"></span></td>
      <td class="col-check"><input type="checkbox" ${selectedKeys.has(t.key) ? 'checked' : ''} data-key="${esc(t.key)}"></td>
      <td class="col-title" title="${esc(t.title)}">${esc(t.title)}</td>
      <td class="col-artist" title="${esc(t.artist)}">${esc(t.artist)}</td>
      <td class="col-album" title="${esc(t.album)}">${esc(t.album)}</td>
      <td class="col-duration">${t.duration || ''}</td>
      <td class="col-status">${statusBadge(t.status, t.key)}</td>
      <td class="col-quality">${qualityBadge(t)}</td>
      <td class="col-fingerprint">${matchBadge(t.match_confidence)}</td>
    `;
    tbody.appendChild(tr);

    // Expanded detail row
    if (expandedKey === t.key) {
      const detailRow = document.createElement('tr');
      detailRow.className = 'detail-row';
      detailRow.innerHTML = `<td colspan="9"><div class="detail-panel" id="detail-${CSS.escape(t.key)}">Loading candidates...</div></td>`;
      tbody.appendChild(detailRow);

      // Always fetch fresh from server
      send('getCandidates', { trackKey: t.key });

      // Render cached data immediately if available (server response will update)
      if (candidateCache[t.key]) {
        requestAnimationFrame(() => renderExpandedRow(t.key));
      }
    }
  }

  updateSelectionCount();
  updateCheckAll();
}

function renderExpandedRow(trackKey) {
  const panel = document.getElementById('detail-' + CSS.escape(trackKey));
  if (!panel) return;

  const candidates = candidateCache[trackKey] || [];
  const track = allTracks.find(t => t.key === trackKey);
  if (candidates.length === 0) {
    panel.innerHTML = `
      <div class="detail-empty">
        ${track && track.status === 'ready' ? 'No search performed yet.' : 'No candidates found.'}
      </div>
      <div class="detail-actions">
        <button class="primary-btn detail-search-btn" data-track="${esc(trackKey)}">Search</button>
        ${track && track.status !== 'ready' ? `<button class="secondary-btn detail-reset-btn" data-track="${esc(trackKey)}">Reset</button>` : ''}
      </div>
    `;
    return;
  }

  let html = '<div class="candidate-list">';
  for (const c of candidates) {
    const breakdown = c.score_breakdown ? JSON.parse(c.score_breakdown) : {};
    const tags = Object.entries(breakdown).map(([k, v]) => {
      const numVal = typeof v === 'number' ? v : parseInt(String(v).match(/-?\d+/)?.[0] || '0');
      const cls = numVal > 0 ? 'score-pos' : numVal < 0 ? 'score-neg' : 'score-zero';
      const label = k.replace(/^(soft_|extraQual_)/, '');
      return `<span class="score-tag ${cls}">${esc(label)} ${numVal > 0 ? '+' : ''}${numVal}</span>`;
    }).join('');

    const scoreClass = c.score >= 300 ? 'score-high' : c.score >= 100 ? 'score-mid' : 'score-low';

    html += `
      <label class="candidate ${c.selected ? 'candidate-selected' : ''}" data-id="${c.id}" data-track="${esc(trackKey)}">
        <input type="radio" name="cand-${CSS.escape(trackKey)}" ${c.selected ? 'checked' : ''}>
        <div class="candidate-score ${scoreClass}">${c.score}pts</div>
        <div class="candidate-info">
          <div class="candidate-title">${esc(c.video_title)}</div>
          <div class="candidate-meta">
            ${esc(c.channel)}${c.channel_type ? ' (' + esc(c.channel_type) + ')' : ''} · ${c.duration_text || c.duration + 's'}
          </div>
          <div class="candidate-tags">${tags}</div>
        </div>
      </label>
    `;
  }
  html += '</div>';

  const hasFile = track && track.file_path;
  html += `
    <div class="detail-actions">
      <button class="primary-btn detail-download-btn" data-track="${esc(trackKey)}">Download Selected</button>
      <button class="secondary-btn detail-reset-btn" data-track="${esc(trackKey)}">Reset</button>
      ${hasFile ? `<button class="action-btn delete-btn detail-delete-btn" data-track="${esc(trackKey)}">Delete File</button>` : ''}
    </div>
  `;

  panel.innerHTML = html;
}

function statusBadge(status, trackKey) {
  const labels = {
    ready: 'Ready',
    searching: 'Searching',
    searched: 'Searched',
    queued: 'Queued',
    downloading: 'Downloading',
    downloaded: 'Downloaded',
    checking: 'Checking',
    fingerprinting: 'Verifying',
    complete: 'Done',
    failed: 'Failed'
  };
  const s = status || 'ready';
  const isActive = trackKey && activeTrackKeys.has(trackKey);
  const spinner = isActive ? '<span class="spinner"></span>' : '';
  return `<span class="badge badge-${s}">${spinner}${labels[s] || s}</span>`;
}

function qualityBadge(t) {
  if (!t.quality) return '';
  const q = t.quality;
  const lossless = t.lossless === 'Yes';
  const cls = lossless ? 'match-good' : parseInt(q) >= 256 ? 'match-ok' : 'match-bad';
  return `<span class="${cls}">${q}k${lossless ? ' LL' : ''}</span>`;
}

function matchBadge(confidence) {
  if (confidence === null || confidence === undefined || confidence === 0) return '';
  const pct = Math.round(confidence * 100);
  if (confidence >= 0.8) return `<span class="match-good">${pct}%</span>`;
  if (confidence >= 0.5) return `<span class="match-ok">${pct}%</span>`;
  return `<span class="match-bad">${pct}%</span>`;
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Row click to expand ──

document.getElementById('track-body').addEventListener('click', (e) => {
  // Ignore checkbox clicks
  if (e.target.type === 'checkbox') return;

  // Candidate radio button
  const candidateLabel = e.target.closest('.candidate');
  if (candidateLabel) {
    const trackKey = candidateLabel.dataset.track;
    const candidateId = parseInt(candidateLabel.dataset.id);
    send('selectCandidate', { trackKey, candidateId });
    return;
  }

  // Detail action buttons
  if (e.target.classList.contains('detail-download-btn')) {
    const key = e.target.dataset.track;
    send('startPipeline', { keys: [key], threads: getThreadConfig(), mode: 'download' });
    return;
  }
  if (e.target.classList.contains('detail-search-btn')) {
    const key = e.target.dataset.track;
    send('startPipeline', { keys: [key], threads: getThreadConfig(), mode: 'search' });
    return;
  }
  if (e.target.classList.contains('detail-reset-btn')) {
    const key = e.target.dataset.track;
    send('resetTracks', { keys: [key] });
    return;
  }
  if (e.target.classList.contains('detail-delete-btn')) {
    const key = e.target.dataset.track;
    if (!confirm('Delete the downloaded file and reset this track?')) return;
    send('deleteTracks', { keys: [key] });
    return;
  }

  // Row click to expand/collapse
  const row = e.target.closest('.track-row');
  if (row) {
    const key = row.dataset.key;
    expandedKey = expandedKey === key ? null : key;
    renderTracks();
  }
});

// ── Selection ──

document.getElementById('track-body').addEventListener('change', (e) => {
  if (e.target.type !== 'checkbox') return;
  const key = e.target.dataset.key;
  if (!key) return;
  if (e.target.checked) selectedKeys.add(key);
  else selectedKeys.delete(key);
  e.target.closest('tr').classList.toggle('selected', e.target.checked);
  updateSelectionCount();
  updateCheckAll();
  updateActionButton();
});

document.getElementById('check-all').addEventListener('change', (e) => {
  const visible = getVisibleTracks();
  for (const t of visible) {
    if (e.target.checked) selectedKeys.add(t.key);
    else selectedKeys.delete(t.key);
  }
  renderTracks();
  updateActionButton();
});

function updateCheckAll() {
  const visible = getVisibleTracks();
  const allChecked = visible.length > 0 && visible.every(t => selectedKeys.has(t.key));
  document.getElementById('check-all').checked = allChecked;
}

function updateSelectionCount() {
  const count = selectedKeys.size;
  document.getElementById('selection-count').textContent = count ? `${count} selected` : '';
}

// ── Action buttons ──

function updateActionButton() {
  const btnSearch = document.getElementById('btn-search');
  const btnDownload = document.getElementById('btn-download');
  const btnAnalyse = document.getElementById('btn-analyse');
  const btnFull = document.getElementById('btn-full');
  const btnReset = document.getElementById('btn-reset');
  const btnDelete = document.getElementById('btn-delete');

  if (selectedKeys.size === 0) {
    btnSearch.disabled = true;
    btnDownload.disabled = true;
    btnAnalyse.disabled = true;
    btnFull.disabled = true;
    btnReset.disabled = true;
    btnDelete.disabled = true;
    return;
  }

  const selectedTracks = allTracks.filter(t => selectedKeys.has(t.key));
  const hasSearchable = selectedTracks.some(t => t.status === 'ready' || t.status === 'failed');
  const hasDownloadable = selectedTracks.some(t => t.status === 'searched');
  const hasAnalysable = selectedTracks.some(t => t.status === 'complete' || t.status === 'downloaded');
  const hasNonReady = selectedTracks.some(t => t.status !== 'ready');
  const hasFiles = selectedTracks.some(t => t.file_path);

  btnSearch.disabled = !hasSearchable;
  btnDownload.disabled = !hasDownloadable;
  btnAnalyse.disabled = !hasAnalysable;
  btnFull.disabled = !hasSearchable;
  btnReset.disabled = !hasNonReady;
  btnDelete.disabled = !hasFiles;
}

// ── Filters ──

document.getElementById('filter-text').addEventListener('input', renderTracks);
document.getElementById('filter-status').addEventListener('change', renderTracks);
document.getElementById('filter-quality').addEventListener('change', renderTracks);
document.getElementById('filter-match').addEventListener('change', renderTracks);
document.getElementById('filter-playlist').addEventListener('change', (e) => {
  activePlaylist = e.target.value;
  document.querySelectorAll('#playlist-list li').forEach(li => {
    li.classList.toggle('active', li.dataset.playlist === activePlaylist);
  });
  renderTracks();
});

// ── Action buttons ──

function getThreadConfig() {
  return {
    search: parseInt(document.getElementById('threads-search').value),
    download: parseInt(document.getElementById('threads-download').value),
    analyse: parseInt(document.getElementById('threads-analyse').value),
  };
}

// Live thread count updates
document.getElementById('threads-search').addEventListener('change', () => send('setThreads', getThreadConfig()));
document.getElementById('threads-download').addEventListener('change', () => send('setThreads', getThreadConfig()));
document.getElementById('threads-analyse').addEventListener('change', () => send('setThreads', getThreadConfig()));

document.getElementById('btn-search').addEventListener('click', () => {
  const keys = [...selectedKeys];
  if (keys.length === 0) return;
  const auto = document.getElementById('chk-auto-download').checked;
  send('startPipeline', { keys, threads: getThreadConfig(), mode: auto ? 'full' : 'search' });
  triggerGlitch();
});

document.getElementById('btn-download').addEventListener('click', () => {
  const keys = [...selectedKeys];
  if (keys.length === 0) return;
  send('startPipeline', { keys, threads: getThreadConfig(), mode: 'download' });
  triggerGlitch();
});

document.getElementById('btn-analyse').addEventListener('click', () => {
  const keys = [...selectedKeys];
  if (keys.length === 0) return;
  send('startPipeline', { keys, threads: getThreadConfig(), mode: 'analyse' });
  triggerGlitch();
});

document.getElementById('btn-full').addEventListener('click', () => {
  const keys = [...selectedKeys];
  if (keys.length === 0) return;
  send('startPipeline', { keys, threads: getThreadConfig(), mode: 'full' });
  triggerGlitch();
});

document.getElementById('btn-reset').addEventListener('click', () => {
  const keys = [...selectedKeys];
  if (keys.length === 0) return;
  send('resetTracks', { keys });
  triggerGlitch();
});

document.getElementById('btn-delete').addEventListener('click', () => {
  const keys = [...selectedKeys];
  if (keys.length === 0) return;
  const count = allTracks.filter(t => keys.includes(t.key) && t.file_path).length;
  if (!confirm(`Delete downloaded files for ${count} track(s)?\n\nThis will remove the files from disk and reset the pipeline state.`)) return;
  send('deleteTracks', { keys });
  triggerGlitch();
});

// ── CSV Import (drag & drop + click) ──

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const files = [...e.dataTransfer.files].filter(f => f.name.endsWith('.csv'));
  if (files.length) importFiles(files);
});

fileInput.addEventListener('change', () => {
  const files = [...fileInput.files];
  if (files.length) importFiles(files);
  fileInput.value = '';
});

function importFiles(files) {
  for (const file of files) {
    const reader = new FileReader();
    reader.onload = () => {
      send('importCSV', { filename: file.name, content: reader.result });
    };
    reader.readAsText(file);
  }
}

// ── Exportify ──

document.getElementById('btn-exportify').addEventListener('click', () => {
  nw.Shell.openExternal('https://exportify.net/');
  send('watchDownloads', { enable: true });
  const el = document.getElementById('watch-status');
  el.textContent = 'Watching for downloaded CSVs...';
  el.classList.remove('hidden');
});

// ── Dock tabs ──

document.querySelector('.dock-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.dock-tab');
  if (!tab) return;
  document.querySelectorAll('.dock-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.dock-panel').forEach(p => p.classList.remove('active'));
  tab.classList.add('active');
  document.getElementById('dock-' + tab.dataset.dock).classList.add('active');
  // Show/hide clear button for console tab
  document.getElementById('btn-clear-console').style.display = tab.dataset.dock === 'console' ? '' : 'none';
});

// ── Console ──

const MAX_CONSOLE_LINES = 500;

function appendConsole(text, level = 'log') {
  const output = document.getElementById('console-output');
  const line = document.createElement('div');
  line.className = 'console-line ' + level;
  const ts = new Date().toLocaleTimeString();
  line.innerHTML = `<span class="console-ts">${ts}</span><span class="console-msg">${esc(text)}</span>`;
  output.appendChild(line);

  // Trim old lines
  while (output.children.length > MAX_CONSOLE_LINES) {
    output.removeChild(output.firstChild);
  }

  // Auto-scroll if near bottom
  const parent = output.parentElement;
  if (parent.scrollHeight - parent.scrollTop - parent.clientHeight < 60) {
    parent.scrollTop = parent.scrollHeight;
  }
}

document.getElementById('btn-clear-console').addEventListener('click', () => {
  document.getElementById('console-output').innerHTML = '';
});

// ── Download dock ──

function updateThreads(threadData) {
  if (!threadData) return;
  threads = threadData;
  const container = document.getElementById('thread-lanes');
  container.innerHTML = '';

  // Group by stage, maintain order
  const stageOrder = ['search', 'download', 'analyse'];
  const grouped = {};
  for (const t of threads) {
    if (!grouped[t.stage]) grouped[t.stage] = [];
    grouped[t.stage].push(t);
  }

  // Show all stages whenever any pipeline activity exists
  const anyActive = threads.some(t => !t.idle);
  const anyPending = document.getElementById('queue-list').children.length > 0;
  const showAll = anyActive || anyPending;

  for (const stageName of stageOrder) {
    const workers = grouped[stageName];
    if (!workers) continue;
    if (!showAll && workers.every(w => w.idle)) continue;

    for (const t of workers) {
      const lane = document.createElement('div');
      lane.className = 'thread-lane';
      if (t.idle) {
        lane.innerHTML = `
          <span class="thread-id thread-${stageName}">${t.id}</span>
          <span class="thread-idle">Idle</span>
        `;
      } else {
        lane.innerHTML = `
          <span class="thread-id thread-${stageName}">${t.id}</span>
          <span class="spinner thread-spinner-${stageName}"></span>
          <span class="thread-track">${esc(t.track)}</span>
          ${t.detail ? '<span class="thread-detail">' + esc(t.detail) + '</span>' : ''}
        `;
      }
      container.appendChild(lane);
    }
  }
}

function updatePendingQueue(pending) {
  const container = document.getElementById('queue-list');
  if (!pending || pending.length === 0) {
    container.innerHTML = '';
    return;
  }

  let html = '<div class="queue-header">Pending (' + pending.length + ')</div>';
  for (const item of pending) {
    html += `<div class="queue-item">
      <span class="qi-pos">${item.position}</span>
      <span class="qi-stage badge badge-stage-${item.stage}">${item.stage}</span>
      <span class="qi-name">${esc(item.track)}</span>
    </div>`;
  }
  container.innerHTML = html;
}

function updateDockStats(stats) {
  if (!stats) return;
  const el = document.getElementById('dock-stats');
  const parts = [];
  if (stats.paused) parts.push('PAUSED');
  if (stats.active) parts.push(`${stats.active} active`);
  if (stats.pending) parts.push(`${stats.pending} pending`);
  if (stats.done) parts.push(`${stats.done} done`);
  if (stats.failed) parts.push(`${stats.failed} failed`);
  el.textContent = parts.length ? '(' + parts.join(', ') + ')' : '';

  // Toggle pause/resume button visibility
  const btnPause = document.getElementById('btn-pipeline-pause');
  const btnResume = document.getElementById('btn-pipeline-resume');
  if (stats.paused) {
    btnPause.style.display = 'none';
    btnResume.style.display = '';
    btnResume.classList.add('active');
  } else {
    btnPause.style.display = '';
    btnResume.style.display = 'none';
    btnResume.classList.remove('active');
  }
}

// ── Dock toggle & resize ──

document.getElementById('btn-toggle-dock').addEventListener('click', () => {
  document.getElementById('dock').classList.toggle('collapsed');
});

document.getElementById('btn-pipeline-stop').addEventListener('click', () => {
  send('stopPipeline');
});
document.getElementById('btn-pipeline-pause').addEventListener('click', () => {
  send('pausePipeline');
});
document.getElementById('btn-pipeline-resume').addEventListener('click', () => {
  send('resumePipeline');
});

const dockHandle = document.getElementById('dock-handle');
let resizing = false;

dockHandle.addEventListener('mousedown', (e) => {
  resizing = true;
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!resizing) return;
  const dock = document.getElementById('dock');
  const appRect = document.getElementById('main').getBoundingClientRect();
  const newHeight = appRect.bottom - e.clientY;
  dock.style.height = Math.max(40, Math.min(newHeight, appRect.height - 100)) + 'px';
});

document.addEventListener('mouseup', () => { resizing = false; });

// ── YouTube status ──

function setYtStatus(status, label) {
  const el = document.getElementById('yt-status');
  el.className = 'yt-status ' + status;
  el.querySelector('.yt-label').textContent = label;
}

// Click yt-status to open settings
document.getElementById('yt-status').addEventListener('click', () => {
  document.getElementById('modal-overlay').classList.remove('hidden');
  send('getWorkspace');
});

// ── Cookie import ──

const cookieDropZone = document.getElementById('cookie-drop-zone');
const cookieFileInput = document.getElementById('cookie-file-input');

cookieDropZone.addEventListener('click', () => cookieFileInput.click());

cookieDropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  cookieDropZone.classList.add('drag-over');
});
cookieDropZone.addEventListener('dragleave', () => cookieDropZone.classList.remove('drag-over'));

// Prevent default drag behaviour on modal so drops work
document.getElementById('modal-overlay').addEventListener('dragover', (e) => e.preventDefault());
document.getElementById('modal-overlay').addEventListener('drop', (e) => e.preventDefault());

cookieDropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  cookieDropZone.classList.remove('drag-over');
  const file = [...e.dataTransfer.files].find(f => f.name.endsWith('.txt'));
  if (file) {
    // For drag-and-drop in NW.js, get path from dataTransfer
    const filePath = file.path || e.dataTransfer.files[0]?.path;
    if (filePath) {
      appendConsole(`Cookie file dropped: ${filePath}`, 'info');
      send('importCookies', { path: filePath });
    } else {
      appendConsole('Cookie file dropped (reading content)', 'info');
      importCookieFile(file);
    }
  } else {
    appendConsole('Dropped file is not a .txt file', 'warn');
  }
});

cookieFileInput.addEventListener('change', () => {
  if (cookieFileInput.files[0]) importCookieFile(cookieFileInput.files[0]);
  cookieFileInput.value = '';
});

function importCookieFile(file) {
  // NW.js gives us the real path — send it so backend can copy the file directly
  if (file.path) {
    send('importCookies', { path: file.path });
  } else {
    const reader = new FileReader();
    reader.onload = () => {
      send('importCookies', { content: reader.result });
    };
    reader.readAsText(file);
  }
}

let selectedBrowser = 'chrome';

const cookieExtUrls = {
  chrome: 'https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc',
  firefox: 'https://addons.mozilla.org/en-US/firefox/addon/cookies-txt/',
};

document.querySelectorAll('.browser-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    selectedBrowser = btn.dataset.browser;
    document.querySelectorAll('.browser-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

document.getElementById('btn-launch-ytm').addEventListener('click', () => {
  nw.Shell.openExternal('https://music.youtube.com/');
});

document.getElementById('btn-launch-cookie-ext').addEventListener('click', () => {
  nw.Shell.openExternal(cookieExtUrls[selectedBrowser]);
});

// ── AcoustID settings ──

document.getElementById('btn-acoustid-register').addEventListener('click', () => {
  nw.Shell.openExternal('https://acoustid.org/login');
});

document.getElementById('btn-acoustid-newapp').addEventListener('click', () => {
  nw.Shell.openExternal('https://acoustid.org/new-application');
});

document.getElementById('btn-save-acoustid').addEventListener('click', () => {
  const key = document.getElementById('acoustid-key').value.trim();
  if (!key) return;
  send('setConfig', { acoustid_api_key: key });
  const el = document.getElementById('acoustid-status');
  el.textContent = 'API key saved';
  el.className = 'acoustid-status ok';
});

document.getElementById('btn-save-delay').addEventListener('click', () => {
  const delay = Number(document.getElementById('request-delay').value) || 0;
  send('setConfig', { request_delay: delay });
});

// ── Settings modal ──

document.getElementById('btn-settings').addEventListener('click', () => {
  document.getElementById('modal-overlay').classList.remove('hidden');
  send('getWorkspace');
  send('getConfig');
});

document.getElementById('btn-close-settings').addEventListener('click', () => {
  document.getElementById('modal-overlay').classList.add('hidden');
});

document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal-overlay')) {
    document.getElementById('modal-overlay').classList.add('hidden');
  }
});

const wsPicker = document.getElementById('workspace-picker');

document.getElementById('btn-choose-workspace').addEventListener('click', () => {
  wsPicker.click();
});

wsPicker.addEventListener('change', () => {
  if (wsPicker.value) {
    send('setWorkspace', { path: wsPicker.value });
    wsPicker.value = '';
  }
});

document.getElementById('btn-default-workspace').addEventListener('click', () => {
  send('setWorkspace', { useDefault: true });
});

function setWorkspaceStatus(text, cls) {
  const el = document.getElementById('workspace-status');
  el.textContent = text;
  el.className = 'workspace-status' + (cls ? ' ' + cls : '');
}

function openSettings() {
  document.getElementById('modal-overlay').classList.remove('hidden');
}

// ── One-shot glitch ──

function triggerGlitch() {
  const el = document.getElementById('sidebar-art');
  el.classList.remove('glitch-once');
  void el.offsetWidth; // force reflow to restart animation
  el.classList.add('glitch-once');
}

// ── Toast notifications ──

function showToast(message) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:200;display:flex;flex-direction:column;gap:8px;';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.style.cssText = 'background:#2d5a3e;color:#a5d6b8;padding:10px 16px;border-radius:6px;font-size:0.85rem;box-shadow:0 4px 16px #00000066;opacity:0;transition:opacity 0.3s;';
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.style.opacity = '1');
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ── Init ──

connect();
