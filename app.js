/* ──────────────────────────────────────────────────────────────
   Piton de la Fournaise — Real-time tremor dashboard
   Data source: RESIF FDSN Web Services (ws.resif.fr)
   Network: PF (OVPF-IPGP)
────────────────────────────────────────────────────────────── */

const FDSN_BASE    = 'https://ws.resif.fr/fdsnws';
const NETWORK      = 'PF';
const REFRESH_MS   = 60_000;   // auto-refresh every 60 s
const DEFAULT_WIN  = 30;       // minutes

// Stations to display (PF network priority stations)
// These are the main broadband/short-period stations of OVPF
const PRIORITY_STATIONS = [
  'RER', 'BOR', 'FER', 'NSR', 'FOR',
  'PER', 'CSS', 'BEB', 'HDL', 'SNE',
];

// Preferred channel codes (in priority order)
const CHANNEL_PRIO = ['HHZ', 'BHZ', 'EHZ', 'SHZ', 'HNZ'];

/* ─── State ──────────────────────────────────────────────── */
let windowMinutes   = DEFAULT_WIN;
let activeStations  = new Set(PRIORITY_STATIONS.slice(0, 5));
let allStations     = [];
let refreshTimer    = null;
let isLoading       = false;

/* ─── DOM refs ───────────────────────────────────────────── */
const $panels       = document.getElementById('panels');
const $specPanels   = document.getElementById('spectro-panels');
const $overlay      = document.getElementById('loading-overlay');
const $chips        = document.getElementById('station-chips');
const $statusDot    = document.querySelector('.dot');
const $statusText   = document.getElementById('status-text');
const $lastUpdate   = document.getElementById('last-update');
const $stationCount = document.getElementById('station-count');
const $windowLabel  = document.getElementById('window-label');

/* ─── Helpers ────────────────────────────────────────────── */
function fmtTime(d) {
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function isoNow(offsetSec = 0) {
  return new Date(Date.now() + offsetSec * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
}

function setStatus(state, text) {
  $statusDot.className  = 'dot ' + state;
  $statusText.textContent = text;
}

/* ─── Fetch station list from FDSN StationXML ────────────── */
async function fetchStations() {
  const url = `${FDSN_BASE}/station/1/query?network=${NETWORK}&level=station&format=xml&nodata=404`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'application/xml');
    const nodes = doc.querySelectorAll('Station');
    const stations = Array.from(nodes).map(n => n.getAttribute('code')).filter(Boolean);
    // Deduplicate and sort
    return [...new Set(stations)].sort();
  } catch (e) {
    console.warn('Station list fetch failed:', e);
    return PRIORITY_STATIONS;
  }
}

/* ─── Fetch waveform via RESIF timeseries/availability ───── */
async function fetchWaveformData(station, startISO, endISO) {
  // Try channels in priority order
  for (const channel of CHANNEL_PRIO) {
    const url = `${FDSN_BASE}/dataselect/1/query?network=${NETWORK}&station=${station}&location=*&channel=${channel}&starttime=${startISO}&endtime=${endISO}&nodata=404`;
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        const buffer = await resp.arrayBuffer();
        if (buffer.byteLength > 0) {
          return { buffer, channel };
        }
      }
    } catch (_) {}
  }
  return null;
}

/* ─── Parse miniSEED and draw on canvas ──────────────────── */
function drawWaveform(canvas, buffer, channel, label) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width  = canvas.offsetWidth  || 900;
  const H = canvas.height = canvas.offsetHeight || 140;

  ctx.clearRect(0, 0, W, H);

  // Background grid
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  const gridLines = 4;
  for (let i = 1; i < gridLines; i++) {
    const y = (H / gridLines) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  // Parse miniSEED with seisplotjs
  let seismograms;
  try {
    seismograms = seisplotjs.miniseed.parseDataRecords(buffer);
  } catch (e) {
    console.warn('miniSEED parse error:', e);
    drawError(ctx, W, H, 'Données illisibles');
    return;
  }

  if (!seismograms || seismograms.length === 0) {
    drawError(ctx, W, H, 'Aucune donnée');
    return;
  }

  // Gather all samples
  const allData = [];
  for (const rec of seismograms) {
    try {
      const y = rec.asEncodedDataSegment().decode();
      allData.push(...Array.from(y));
    } catch (_) {}
  }

  if (allData.length === 0) {
    drawError(ctx, W, H, 'Buffer vide');
    return;
  }

  // Normalize
  const min = Math.min(...allData);
  const max = Math.max(...allData);
  const range = max - min || 1;
  const pad = H * 0.1;

  // Color by channel type
  const isHF = channel.startsWith('H') || channel.startsWith('E');
  ctx.strokeStyle = isHF ? '#ff8c42' : '#5b9bd5';
  ctx.lineWidth = 1.2;
  ctx.beginPath();

  const step = allData.length / W;
  for (let px = 0; px < W; px++) {
    const idx = Math.min(Math.floor(px * step), allData.length - 1);
    const val = allData[idx];
    const y = pad + ((max - val) / range) * (H - 2 * pad);
    if (px === 0) ctx.moveTo(px, y);
    else ctx.lineTo(px, y);
  }
  ctx.stroke();

  // Zero line
  const zeroY = pad + (max / range) * (H - 2 * pad);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(W, zeroY); ctx.stroke();
}

function drawError(ctx, W, H, msg) {
  ctx.fillStyle = 'rgba(255, 78, 26, 0.15)';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#7a7a90';
  ctx.font = '13px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(msg, W / 2, H / 2 + 5);
}

/* ─── Build panel DOM ────────────────────────────────────── */
function buildPanel(id, station, channel, startLabel, endLabel) {
  const div = document.createElement('div');
  div.className = 'panel';
  div.id = 'panel-' + id;
  div.innerHTML = `
    <div class="panel-header">
      <span class="panel-title">${NETWORK}.${station} · ${channel || '…'}</span>
      <span class="panel-meta">${startLabel} → ${endLabel}</span>
    </div>
    <div class="panel-body">
      <canvas class="panel-canvas" id="canvas-${id}"></canvas>
    </div>
  `;
  return div;
}

/* ─── Main load routine ──────────────────────────────────── */
async function loadData() {
  if (isLoading) return;
  isLoading = true;
  setStatus('', 'Chargement…');
  $overlay.classList.remove('hidden');
  $panels.querySelectorAll('.panel').forEach(p => p.remove());
  $specPanels.innerHTML = '';

  const endTime   = new Date();
  const startTime = new Date(endTime - windowMinutes * 60 * 1000);
  const startISO  = startTime.toISOString().replace(/\.\d+Z$/, 'Z');
  const endISO    = endTime.toISOString().replace(/\.\d+Z$/, 'Z');

  const startLabel = fmtTime(startTime);
  const endLabel   = fmtTime(endTime);

  const stations = [...activeStations];
  let loaded = 0;

  const tasks = stations.map(async (station) => {
    const result = await fetchWaveformData(station, startISO, endISO);

    const id = station;
    const channel = result ? result.channel : '—';
    const panel = buildPanel(id, station, channel, startLabel, endLabel);
    $panels.appendChild(panel);

    if (result) {
      const canvas = document.getElementById('canvas-' + id);
      if (canvas) {
        requestAnimationFrame(() => drawWaveform(canvas, result.buffer, result.channel, station));
      }
      loaded++;
    } else {
      const body = panel.querySelector('.panel-body');
      body.innerHTML = `<div class="panel-error">Pas de données disponibles pour cette station sur la période</div>`;
    }
  });

  await Promise.allSettled(tasks);

  $overlay.classList.add('hidden');
  $lastUpdate.textContent = fmtTime(new Date());
  $stationCount.textContent = `${loaded} / ${stations.length}`;
  isLoading = false;

  if (loaded > 0) {
    setStatus('live', `En direct · ${loaded} station${loaded > 1 ? 's' : ''}`);
  } else {
    setStatus('error', 'Aucune donnée reçue');
  }
}

/* ─── Station chips ──────────────────────────────────────── */
function renderChips() {
  $chips.innerHTML = '';
  const displayed = allStations.length ? allStations : PRIORITY_STATIONS;
  for (const code of displayed) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (activeStations.has(code) ? ' active' : '');
    chip.textContent = code;
    chip.addEventListener('click', () => {
      if (activeStations.has(code)) {
        if (activeStations.size > 1) activeStations.delete(code);
      } else {
        activeStations.add(code);
      }
      renderChips();
      loadData();
    });
    $chips.appendChild(chip);
  }
}

/* ─── Window buttons ─────────────────────────────────────── */
function setWindow(min, btnId) {
  windowMinutes = min;
  $windowLabel.textContent = min >= 60 ? `${min / 60} h` : `${min} min`;
  document.querySelectorAll('.controls .btn').forEach(b => b.classList.remove('active'));
  document.getElementById(btnId)?.classList.add('active');
  loadData();
}

document.getElementById('btn-15').addEventListener('click', () => setWindow(15, 'btn-15'));
document.getElementById('btn-30').addEventListener('click', () => setWindow(30, 'btn-30'));
document.getElementById('btn-60').addEventListener('click', () => setWindow(60, 'btn-60'));
document.getElementById('btn-refresh').addEventListener('click', loadData);

/* ─── Auto-refresh ───────────────────────────────────────── */
function startAutoRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(loadData, REFRESH_MS);
}

/* ─── Init ───────────────────────────────────────────────── */
async function init() {
  setStatus('', 'Connexion…');

  // Load station list
  const stations = await fetchStations();
  allStations = stations.filter(s => s.length <= 5);

  // Default active = priority stations that exist in the list
  const available = new Set(allStations);
  activeStations = new Set(
    PRIORITY_STATIONS.filter(s => available.has(s)).slice(0, 6)
  );
  if (activeStations.size === 0) {
    // Fallback: first 5
    allStations.slice(0, 5).forEach(s => activeStations.add(s));
  }

  renderChips();
  await loadData();
  startAutoRefresh();
}

init();
