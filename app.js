/* ──────────────────────────────────────────────────────────────
   Piton de la Fournaise — Real-time tremor dashboard
   Data source: RESIF FDSN Web Services (ws.resif.fr)
   Network: PF (OVPF-IPGP)
────────────────────────────────────────────────────────────── */

const FDSN_BASE   = 'https://ws.resif.fr/fdsnws';
const NETWORK     = 'PF';
const REFRESH_MS  = 60_000;
const DEFAULT_WIN = 30;

/* ─── Station metadata ───────────────────────────────────── */
const ZONE_ORDER = [
  'Sommet', 'Enclos Fouqué', 'Pentes N', 'Pentes S',
  'Pentes E', 'Grand Brûlé', 'Hors enclos', 'Autre',
];

const STATIONS_META = {
  // Enclos Fouqué
  BOR: { name: 'Bory',           zone: 'Enclos Fouqué' },
  FEU: { name: 'Feu',            zone: 'Enclos Fouqué' },
  CSS: { name: 'Cassé Sud',      zone: 'Enclos Fouqué' },
  FOR: { name: 'Formica Leo',    zone: 'Enclos Fouqué' },
  FER: { name: 'Ferret',         zone: 'Enclos Fouqué' },
  // Pentes S
  PER: { name: 'Pére',           zone: 'Pentes S' },
  RVP: { name: 'Ravine Plate',   zone: 'Pentes S' },
  RVL: { name: 'Ravine Langevin',zone: 'Pentes S' },
  // Pentes N
  NSR: { name: 'Nez Scie',       zone: 'Pentes N' },
  SNE: { name: 'Sainte-Neige',   zone: 'Pentes N' },
  // Grand Brûlé
  RER: { name: 'Rempart Est',    zone: 'Grand Brûlé' },
  BEB: { name: 'Basse Estelle B',zone: 'Grand Brûlé' },
  // Hors enclos
  HDL: { name: 'Hauts-de-Ligne', zone: 'Hors enclos' },
  MAT: { name: 'Matouta',        zone: 'Hors enclos' },
  PJR: { name: 'Piton Jacquot',  zone: 'Hors enclos' },
};

function getMeta(code) {
  return STATIONS_META[code] || { name: code, zone: 'Autre' };
}

// Priority stations for default display
const PRIORITY_STATIONS = [
  'RER', 'BOR', 'FER', 'NSR', 'FOR',
  'PER', 'CSS', 'BEB', 'HDL', 'SNE',
];

const CHANNEL_PRIO = ['HHZ', 'BHZ', 'EHZ', 'SHZ', 'HNZ'];

/* ─── State ──────────────────────────────────────────────── */
let windowMinutes  = DEFAULT_WIN;
let activeStations = new Set(PRIORITY_STATIONS.slice(0, 5));
let allStations    = [];
let refreshTimer   = null;
let isLoading      = false;

/* ─── DOM refs ───────────────────────────────────────────── */
const $panels       = document.getElementById('panels');
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

function setStatus(state, text) {
  $statusDot.className    = 'dot ' + state;
  $statusText.textContent = text;
}

/* ─── Fetch station list ─────────────────────────────────── */
async function fetchStations() {
  const url = `${FDSN_BASE}/station/1/query?network=${NETWORK}&level=station&format=xml&nodata=404`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const doc  = new DOMParser().parseFromString(text, 'application/xml');
    const codes = Array.from(doc.querySelectorAll('Station'))
      .map(n => n.getAttribute('code')).filter(Boolean);
    return [...new Set(codes)].sort();
  } catch (e) {
    console.warn('Station list fetch failed:', e);
    return PRIORITY_STATIONS;
  }
}

/* ─── Fetch waveform data ────────────────────────────────── */
async function fetchWaveformData(station, startISO, endISO) {
  for (const channel of CHANNEL_PRIO) {
    const url = `${FDSN_BASE}/dataselect/1/query?network=${NETWORK}&station=${station}&location=*&channel=${channel}&starttime=${startISO}&endtime=${endISO}&nodata=404`;
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        const buffer = await resp.arrayBuffer();
        if (buffer.byteLength > 0) return { buffer, channel };
      }
    } catch (_) {}
  }
  return null;
}

/* ─── Decode miniSEED samples ────────────────────────────── */
function decodeSamples(buffer) {
  let records;
  try {
    records = seisplotjs.miniseed.parseDataRecords(buffer);
  } catch (_) { return []; }
  const out = [];
  for (const rec of records) {
    try { out.push(...Array.from(rec.asEncodedDataSegment().decode())); } catch (_) {}
  }
  return out;
}

/* ─── Compute RSAM ───────────────────────────────────────── */
function computeRSAM(samples, sampleRate = 100, windowSec = 10) {
  const winSize = Math.max(1, Math.round(sampleRate * windowSec));
  const rsam = [];
  for (let i = 0; i < samples.length; i += winSize) {
    const slice = samples.slice(i, i + winSize);
    const mean  = slice.reduce((s, v) => s + Math.abs(v), 0) / slice.length;
    rsam.push(mean);
  }
  return rsam;
}

/* ─── Draw helpers ───────────────────────────────────────── */
function drawGrid(ctx, W, H) {
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth   = 1;
  for (let i = 1; i < 4; i++) {
    const y = (H / 4) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
}

function drawLine(ctx, data, W, H, color) {
  if (!data.length) return;
  const min   = Math.min(...data);
  const max   = Math.max(...data);
  const range = max - min || 1;
  const pad   = H * 0.1;

  ctx.strokeStyle = color;
  ctx.lineWidth   = 1.3;
  ctx.beginPath();
  const step = data.length / W;
  for (let px = 0; px < W; px++) {
    const idx = Math.min(Math.floor(px * step), data.length - 1);
    const y   = pad + ((max - data[idx]) / range) * (H - 2 * pad);
    px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
  }
  ctx.stroke();

  // zero / baseline
  const zeroY = pad + (max / range) * (H - 2 * pad);
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth   = 0.5;
  ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(W, zeroY); ctx.stroke();
}

function drawLabel(ctx, W, H, text, color) {
  ctx.fillStyle = color;
  ctx.font      = '11px Inter, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(text, 8, 16);
}

function drawError(ctx, W, H, msg) {
  ctx.fillStyle = 'rgba(255,78,26,0.12)';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle  = '#7a7a90';
  ctx.font       = '12px Inter, system-ui, sans-serif';
  ctx.textAlign  = 'center';
  ctx.fillText(msg, W / 2, H / 2 + 4);
}

function renderCanvas(canvas, samples, color, labelText) {
  const W = canvas.width  = canvas.offsetWidth  || 600;
  const H = canvas.height = canvas.offsetHeight || 140;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  drawGrid(ctx, W, H);
  if (samples.length) {
    drawLine(ctx, samples, W, H, color);
    drawLabel(ctx, W, H, labelText, color + 'cc');
  } else {
    drawError(ctx, W, H, 'Aucune donnée');
  }
}

/* ─── Build dual panel (waveform + RSAM) ─────────────────── */
function buildPanel(station, channel, startLabel, endLabel) {
  const meta = getMeta(station);
  const div  = document.createElement('div');
  div.className = 'panel';
  div.id        = 'panel-' + station;
  div.innerHTML = `
    <div class="panel-header">
      <div class="panel-title-group">
        <span class="panel-title">${NETWORK}.${station}</span>
        <span class="panel-station-name">${meta.name}</span>
        <span class="panel-zone-badge">${meta.zone}</span>
      </div>
      <span class="panel-meta">${channel || '—'} · ${startLabel} → ${endLabel}</span>
    </div>
    <div class="panel-dual">
      <div class="panel-half">
        <canvas class="panel-canvas" id="canvas-wf-${station}"></canvas>
      </div>
      <div class="panel-half">
        <canvas class="panel-canvas" id="canvas-rsam-${station}"></canvas>
      </div>
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

  const endTime   = new Date();
  const startTime = new Date(endTime - windowMinutes * 60 * 1000);
  const startISO  = startTime.toISOString().replace(/\.\d+Z$/, 'Z');
  const endISO    = endTime.toISOString().replace(/\.\d+Z$/, 'Z');
  const startLabel = fmtTime(startTime);
  const endLabel   = fmtTime(endTime);

  // Sort active stations by zone order
  const stations = [...activeStations].sort((a, b) => {
    const za = ZONE_ORDER.indexOf(getMeta(a).zone);
    const zb = ZONE_ORDER.indexOf(getMeta(b).zone);
    return (za === -1 ? 99 : za) - (zb === -1 ? 99 : zb) || a.localeCompare(b);
  });

  let loaded = 0;

  const tasks = stations.map(async (station) => {
    const result  = await fetchWaveformData(station, startISO, endISO);
    const channel = result ? result.channel : null;
    const panel   = buildPanel(station, channel, startLabel, endLabel);
    $panels.appendChild(panel);

    if (!result) {
      // Replace dual body with error
      panel.querySelector('.panel-dual').innerHTML =
        `<div class="panel-error">Pas de données disponibles pour cette station</div>`;
      return;
    }

    loaded++;
    const samples = decodeSamples(result.buffer);
    const rsam    = computeRSAM(samples);

    // Approximate sample rate from channel code
    const sps = channel?.startsWith('H') ? 100 : channel?.startsWith('B') ? 20 : 50;
    const rsamFull = computeRSAM(samples, sps, 10);

    requestAnimationFrame(() => {
      const cvWF   = document.getElementById('canvas-wf-'   + station);
      const cvRSAM = document.getElementById('canvas-rsam-' + station);
      if (cvWF)   renderCanvas(cvWF,   samples,  '#ff8c42', 'Signal brut');
      if (cvRSAM) renderCanvas(cvRSAM, rsamFull, '#30d158', 'RSAM');
    });
  });

  await Promise.allSettled(tasks);

  $overlay.classList.add('hidden');
  $lastUpdate.textContent  = fmtTime(new Date());
  $stationCount.textContent = `${loaded} / ${stations.length}`;
  isLoading = false;

  setStatus(loaded > 0 ? 'live' : 'error',
    loaded > 0 ? `En direct · ${loaded} station${loaded > 1 ? 's' : ''}` : 'Aucune donnée reçue');
}

/* ─── Station chips (grouped by zone) ───────────────────── */
function renderChips() {
  $chips.innerHTML = '';
  const displayed = allStations.length ? allStations : PRIORITY_STATIONS;

  // Group by zone
  const byZone = new Map(ZONE_ORDER.map(z => [z, []]));
  for (const code of displayed) {
    const zone = getMeta(code).zone;
    if (!byZone.has(zone)) byZone.set(zone, []);
    byZone.get(zone).push(code);
  }

  let first = true;
  for (const zone of ZONE_ORDER) {
    const codes = byZone.get(zone) || [];
    if (!codes.length) continue;

    const label = document.createElement('span');
    label.className = 'chip-group-label' + (first ? '' : ' chip-group-label--gap');
    label.textContent = zone;
    $chips.appendChild(label);
    first = false;

    for (const code of codes) {
      const chip = document.createElement('button');
      chip.className   = 'chip' + (activeStations.has(code) ? ' active' : '');
      chip.textContent = code;
      chip.title       = getMeta(code).name;
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

  const stations = await fetchStations();
  allStations    = stations.filter(s => s.length <= 5);

  const available = new Set(allStations);
  activeStations  = new Set(
    PRIORITY_STATIONS.filter(s => available.has(s)).slice(0, 6)
  );
  if (activeStations.size === 0) {
    allStations.slice(0, 5).forEach(s => activeStations.add(s));
  }

  renderChips();
  await loadData();
  startAutoRefresh();
}

init();
