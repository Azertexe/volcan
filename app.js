/* ──────────────────────────────────────────────────────────────
   Piton de la Fournaise — Real-time tremor dashboard
   Data source: RESIF FDSN Web Services (ws.resif.fr)
   Network: PF (OVPF-IPGP) · Backend Flask (séismes/bulletin/crise/webcams)
   MiniSEED 2.x parser: pure JS (Steim-1/2, Blockette 1000).
────────────────────────────────────────────────────────────── */

const API_BASE  = 'https://volcan-backend-gnem.onrender.com';
const FDSN_BASE  = 'https://ws.resif.fr/fdsnws';
const NETWORK    = 'PF';
const REFRESH_MS = 60_000;
const DEFAULT_WIN = 30;

const ZONE_ORDER = [
  'Sommet', 'Enclos Fouqué', 'Pentes N', 'Pentes S',
  'Pentes E', 'Grand Brûlé', 'Hors enclos', 'Autre',
];

const STATIONS_META = {
  BOR: { name: 'Bory', zone: 'Enclos Fouqué' },
  FEU: { name: 'Feu', zone: 'Enclos Fouqué' },
  CSS: { name: 'Cassé Sud', zone: 'Enclos Fouqué' },
  FOR: { name: 'Formica Leo', zone: 'Enclos Fouqué' },
  FER: { name: 'Ferret', zone: 'Enclos Fouqué' },
  PER: { name: 'Père', zone: 'Pentes S' },
  RVP: { name: 'Ravine Plate', zone: 'Pentes S' },
  RVL: { name: 'Ravine Langevin', zone: 'Pentes S' },
  NSR: { name: 'Nez Scie', zone: 'Pentes N' },
  SNE: { name: 'Sainte-Neige', zone: 'Pentes N' },
  RER: { name: 'Rempart Est', zone: 'Grand Brûlé' },
  BEB: { name: 'Basse Estelle B', zone: 'Grand Brûlé' },
  HDL: { name: 'Hauts-de-Ligne', zone: 'Hors enclos' },
  MAT: { name: 'Matouta', zone: 'Hors enclos' },
  PJR: { name: 'Piton Jacquot', zone: 'Hors enclos' },
};

function getMeta(code) { return STATIONS_META[code] || { name: code, zone: 'Autre' }; }

const PRIORITY_STATIONS = ['RER', 'BOR', 'FER', 'NSR', 'FOR', 'PER', 'CSS', 'BEB', 'HDL', 'SNE'];
const CHANNEL_PRIO = ['HHZ', 'BHZ', 'EHZ', 'SHZ', 'HNZ'];

/* ─── State ─────────────────────────────────────────────── */
let windowMinutes  = DEFAULT_WIN;
let activeStations = new Set(PRIORITY_STATIONS.slice(0, 5));
let allStations    = [];
let refreshTimer   = null;
let isLoading      = false;
let currentPage    = 'accueil';
let featuredStation = 'BOR';
let immersionOn    = false;
let immersionBg    = 'tremor';
let lastWaveform   = { samples: [], rsam: [], channel: null };

/* ─── Helpers ───────────────────────────────────────────── */
function fmtTime(d) {
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function setStatus(state, text) {
  const dot = document.getElementById('status-dot');
  const txt = document.getElementById('status-text');
  if (dot) dot.className = 'status-dot ' + state;
  if (txt) txt.textContent = text;
}

/* ═══════════════════════════════════════════════════════════
   MINISEED 2.x PARSER — pure JavaScript
   ═══════════════════════════════════════════════════════════ */
function signExtend(val, bits) {
  const sign = 1 << (bits - 1);
  return (val ^ sign) - sign;
}

function parseMiniSEED(buffer) {
  const allSamples = [];
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  while (offset + 64 <= buffer.byteLength) {
    let valid = true;
    for (let i = 0; i < 6; i++) {
      if (bytes[offset + i] < 48 || bytes[offset + i] > 57) { valid = false; break; }
    }
    if (!valid) { offset++; continue; }

    const view = new DataView(buffer, offset);
    const numSamples        = view.getUint16(30, false);
    const dataOffset        = view.getUint16(44, false);
    const firstBlocketteOff = view.getUint16(46, false);

    let encoding  = 11;
    let bigEndian = true;
    let recLenExp = 9;

    if (firstBlocketteOff >= 48 && offset + firstBlocketteOff + 8 <= buffer.byteLength) {
      let blkOff = firstBlocketteOff;
      for (let iter = 0; iter < 10; iter++) {
        const bType = view.getUint16(blkOff, false);
        const bNext = view.getUint16(blkOff + 2, false);
        if (bType === 1000) {
          encoding  = bytes[offset + blkOff + 4];
          bigEndian = bytes[offset + blkOff + 5] === 1;
          recLenExp = bytes[offset + blkOff + 6];
          break;
        }
        if (!bNext || bNext <= blkOff) break;
        blkOff = bNext;
      }
    }

    const recLen = Math.pow(2, recLenExp);
    const le = !bigEndian;

    if (offset + recLen > buffer.byteLength) break;
    if (numSamples === 0 || dataOffset < 48 || dataOffset >= recLen) { offset += recLen; continue; }

    const dataStart = offset + dataOffset;
    const dataLen   = recLen - dataOffset;

    try {
      const chunk = decodeData(buffer, dataStart, dataLen, numSamples, encoding, le);
      for (const s of chunk) allSamples.push(s);
    } catch (_) {}

    offset += recLen;
  }
  return allSamples;
}

function decodeData(buffer, start, dataLen, numSamples, encoding, le) {
  const view = new DataView(buffer, start, dataLen);
  const out = [];
  switch (encoding) {
    case 1:
      for (let i = 0; i < numSamples && (i + 1) * 2 <= dataLen; i++) out.push(view.getInt16(i * 2, le));
      break;
    case 3:
      for (let i = 0; i < numSamples && (i + 1) * 4 <= dataLen; i++) out.push(view.getInt32(i * 4, le));
      break;
    case 4:
      for (let i = 0; i < numSamples && (i + 1) * 4 <= dataLen; i++) out.push(view.getFloat32(i * 4, le));
      break;
    case 5:
      for (let i = 0; i < numSamples && (i + 1) * 8 <= dataLen; i++) out.push(view.getFloat64(i * 8, le));
      break;
    case 10: return decodeSteim1(buffer, start, dataLen, numSamples);
    case 11: return decodeSteim2(buffer, start, dataLen, numSamples);
    default: return [];
  }
  return out;
}

function decodeSteim1(buffer, start, dataLen, numSamples) {
  const view = new DataView(buffer, start, dataLen);
  const frames = Math.floor(dataLen / 64);
  const out = [];
  let last = 0;
  for (let f = 0; f < frames && out.length < numSamples; f++) {
    const fo = f * 64;
    const cn = view.getUint32(fo, false);
    for (let w = 0; w < 16 && out.length < numSamples; w++) {
      const nibble = (cn >>> (30 - w * 2)) & 0x3;
      const wo = fo + w * 4;
      if (f === 0 && w === 1) { last = view.getInt32(wo, false); continue; }
      if (f === 0 && w === 2) continue;
      if (nibble === 0) continue;
      const word = view.getUint32(wo, false);
      const deltas = [];
      if (nibble === 1) {
        deltas.push(view.getInt32(wo, false));
      } else if (nibble === 2) {
        deltas.push(signExtend((word >>> 16) & 0xFFFF, 16));
        deltas.push(signExtend(word & 0xFFFF, 16));
      } else if (nibble === 3) {
        deltas.push(signExtend((word >>> 24) & 0xFF, 8));
        deltas.push(signExtend((word >>> 16) & 0xFF, 8));
        deltas.push(signExtend((word >>> 8) & 0xFF, 8));
        deltas.push(signExtend(word & 0xFF, 8));
      }
      for (const d of deltas) { last += d; out.push(last); if (out.length >= numSamples) break; }
    }
  }
  return out;
}

function decodeSteim2(buffer, start, dataLen, numSamples) {
  const view = new DataView(buffer, start, dataLen);
  const frames = Math.floor(dataLen / 64);
  const out = [];
  let last = 0;
  for (let f = 0; f < frames && out.length < numSamples; f++) {
    const fo = f * 64;
    const cn = view.getUint32(fo, false);
    for (let w = 0; w < 16 && out.length < numSamples; w++) {
      const nibble = (cn >>> (30 - w * 2)) & 0x3;
      const wo = fo + w * 4;
      if (f === 0 && w === 1) { last = view.getInt32(wo, false); continue; }
      if (f === 0 && w === 2) continue;
      if (nibble === 0) continue;
      const word = view.getUint32(wo, false);
      const deltas = [];
      if (nibble === 1) { last = view.getInt32(wo, false); out.push(last); continue; }
      const dnib = (word >>> 30) & 0x3;
      if (nibble === 2) {
        if (dnib === 1) deltas.push(signExtend(word & 0x3FFFFFFF, 30));
        else if (dnib === 2) { deltas.push(signExtend((word >>> 15) & 0x7FFF, 15)); deltas.push(signExtend(word & 0x7FFF, 15)); }
        else if (dnib === 3) { deltas.push(signExtend((word >>> 20) & 0x3FF, 10)); deltas.push(signExtend((word >>> 10) & 0x3FF, 10)); deltas.push(signExtend(word & 0x3FF, 10)); }
      } else {
        if (dnib === 0) { for (let s = 24; s >= 0; s -= 6) deltas.push(signExtend((word >>> s) & 0x3F, 6)); }
        else if (dnib === 1) { for (let s = 25; s >= 0; s -= 5) deltas.push(signExtend((word >>> s) & 0x1F, 5)); }
        else if (dnib === 2) { for (let s = 24; s >= 0; s -= 4) deltas.push(signExtend((word >>> s) & 0xF, 4)); }
      }
      for (const d of deltas) { last += d; out.push(last); if (out.length >= numSamples) break; }
    }
  }
  return out;
}

/* ─── FDSN fetch ────────────────────────────────────────── */
async function fetchStations() {
  const url = `${FDSN_BASE}/station/1/query?network=${NETWORK}&level=station&format=xml&nodata=404`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const codes = Array.from(doc.querySelectorAll('Station')).map(n => n.getAttribute('code')).filter(Boolean);
    return [...new Set(codes)].sort();
  } catch (e) {
    console.warn('Station list fetch failed:', e);
    return PRIORITY_STATIONS;
  }
}

async function fetchWaveformData(station, startISO, endISO) {
  for (const channel of CHANNEL_PRIO) {
    const url = `${FDSN_BASE}/dataselect/1/query?network=${NETWORK}&station=${station}` +
                `&location=*&channel=${channel}&starttime=${startISO}&endtime=${endISO}&nodata=404`;
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

function computeRSAM(samples, sampleRate = 100, windowSec = 10) {
  const winSize = Math.max(1, Math.round(sampleRate * windowSec));
  const rsam = [];
  for (let i = 0; i < samples.length; i += winSize) {
    const slice = samples.slice(i, i + winSize);
    if (!slice.length) break;
    let sum = 0;
    for (const v of slice) sum += Math.abs(v);
    rsam.push(sum / slice.length);
  }
  return rsam;
}

/* ─── SVG rendering of real data ────────────────────────── */
function samplesToPolyline(samples, w = 600, h = 120) {
  if (!samples || !samples.length) return '';
  let min = Infinity, max = -Infinity;
  for (const v of samples) { if (v < min) min = v; if (v > max) max = v; }
  const range = (max - min) || 1;
  const pad = h * 0.12;
  const n = Math.min(samples.length, 600);
  const step = samples.length / n;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.min(Math.floor(i * step), samples.length - 1);
    const x = (i / (n - 1 || 1)) * w;
    const y = pad + ((max - samples[idx]) / range) * (h - 2 * pad);
    pts.push(x.toFixed(1) + ',' + y.toFixed(1));
  }
  return pts.join(' ');
}

function rsamToPolyline(rsam, w = 600, h = 120) {
  if (!rsam || !rsam.length) return '';
  let min = Infinity, max = -Infinity;
  for (const v of rsam) { if (v < min) min = v; if (v > max) max = v; }
  const range = (max - min) || 1;
  const pad = h * 0.15;
  const n = rsam.length;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const y = pad + ((max - rsam[i]) / range) * (h - 2 * pad);
    const x0 = (i / n) * w;
    const x1 = Math.min(w, ((i + 1) / n) * w);
    pts.push(x0.toFixed(1) + ',' + y.toFixed(1));
    pts.push(x1.toFixed(1) + ',' + y.toFixed(1));
  }
  return pts.join(' ');
}

function drawPolyline(svg, pointsStr, color, opacity = 1, width = 1.6) {
  if (!svg) return;
  svg.innerHTML = '';
  if (!pointsStr) {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', '300'); t.setAttribute('y', '64');
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('fill', 'var(--muted)');
    t.setAttribute('font-size', '12');
    t.setAttribute('font-family', "'Space Mono', monospace");
    t.textContent = 'Aucune donnée';
    svg.appendChild(t);
    return;
  }
  const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  pl.setAttribute('points', pointsStr);
  pl.setAttribute('fill', 'none');
  pl.setAttribute('stroke', color);
  pl.setAttribute('stroke-width', width);
  if (opacity < 1) pl.setAttribute('opacity', opacity);
  svg.appendChild(pl);
}

function spsFor(channel) {
  return channel.startsWith('H') ? 100 : channel.startsWith('B') ? 20 : 50;
}

/* ─── Page navigation ───────────────────────────────────── */
function switchPage(page) {
  if (immersionOn) exitImmersion();
  currentPage = page;
  document.querySelectorAll('.page-content').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + page)?.classList.add('active');
  document.querySelectorAll('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.nav === page));

  if (page === 'webcams') loadWebcams();
  if (page === 'courbes') loadCourbes();
}

/* ─── Theme ─────────────────────────────────────────────── */
function setupTheme() {
  const theme = localStorage.getItem('volcan-theme') || 'dark';
  document.documentElement.className = theme;
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = theme === 'light' ? '☾ Sombre' : '☀ Clair';
}

function toggleTheme() {
  const next = document.documentElement.className === 'light' ? 'dark' : 'light';
  document.documentElement.className = next;
  localStorage.setItem('volcan-theme', next);
  document.getElementById('theme-toggle').textContent = next === 'light' ? '☾ Sombre' : '☀ Clair';
}

/* ─── Immersion mode ────────────────────────────────────── */
function enterImmersion() {
  immersionOn = true;
  immersionBg = 'tremor';
  document.getElementById('accueil-normal').style.display = 'none';
  document.getElementById('accueil-immersion').classList.remove('hidden');
  renderImmersion();
}

function exitImmersion() {
  immersionOn = false;
  document.getElementById('accueil-normal').style.display = '';
  document.getElementById('accueil-immersion').classList.add('hidden');
}

function swapImmersionBg() {
  immersionBg = immersionBg === 'tremor' ? 'webcam' : 'tremor';
  renderImmersion();
}

function renderImmersion() {
  const bg = document.getElementById('immersion-bg');
  const bgLabel = document.getElementById('immersion-bg-label');
  const widget = document.getElementById('widget-content');
  const widgetTitle = document.getElementById('widget-title');
  const selector = document.getElementById('immersion-selector');
  const camBase = document.getElementById('webcams-grid')?.dataset.base;
  const camFile = document.getElementById('accueil-cam-select')?.value;
  const camImg = (camBase && camFile) ? `${camBase}${camFile}?t=${Date.now()}` : null;

  if (immersionBg === 'tremor') {
    bg.classList.remove('webcam-bg');
    bgLabel.textContent = 'FOND · TRÉMOR';
    selector.textContent = `${NETWORK}.${featuredStation}`;
    bg.innerHTML = '<svg class="immersion-wave" viewBox="0 0 600 120" preserveAspectRatio="none"></svg>';
    drawPolyline(bg.querySelector('svg'), samplesToPolyline(lastWaveform.samples), 'var(--accent)', 1, 1.4);

    widgetTitle.textContent = 'Webcam';
    widget.innerHTML = camImg
      ? `<div class="widget-webcam"><img src="${camImg}" alt="webcam"><span class="widget-webcam-timestamp">${fmtTime(new Date())}</span></div>`
      : `<div class="widget-webcam"><span>Webcam indisponible</span></div>`;
  } else {
    bg.classList.add('webcam-bg');
    bgLabel.textContent = 'FOND · WEBCAM';
    selector.textContent = 'Webcam';
    bg.innerHTML = camImg ? `<img class="immersion-cam" src="${camImg}" alt="webcam">` : '';

    widgetTitle.textContent = `${NETWORK}.${featuredStation}`;
    widget.innerHTML = `<div class="widget-tremor"><div class="widget-tremor-label">SIGNAL BRUT</div><svg class="widget-chart" viewBox="0 0 600 120" preserveAspectRatio="none"></svg></div>`;
    drawPolyline(widget.querySelector('svg'), samplesToPolyline(lastWaveform.samples), 'var(--accent)');
  }
}

function startWidgetDrag(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  const widget = document.getElementById('immersion-widget');
  const startX = e.clientX, startY = e.clientY;
  const curX = parseFloat(widget.style.left) || widget.offsetLeft;
  const curY = parseFloat(widget.style.top) || widget.offsetTop;
  const onMove = (ev) => {
    widget.style.left = (curX + ev.clientX - startX) + 'px';
    widget.style.top = (curY + ev.clientY - startY) + 'px';
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

/* ─── Accueil: featured tremor + webcam ─────────────────── */
async function loadFeatured() {
  const end = new Date();
  const start = new Date(end - windowMinutes * 60 * 1000);
  const startISO = start.toISOString().replace(/\.\d+Z$/, 'Z');
  const endISO = end.toISOString().replace(/\.\d+Z$/, 'Z');

  document.getElementById('accueil-window').textContent =
    windowMinutes >= 60 ? `${windowMinutes / 60} h` : `${windowMinutes} min`;

  const result = await fetchWaveformData(featuredStation, startISO, endISO);
  const waveSvg = document.getElementById('accueil-wave');
  const rsamSvg = document.getElementById('accueil-rsam');

  if (!result) {
    lastWaveform = { samples: [], rsam: [], channel: null };
    drawPolyline(waveSvg, '', 'var(--accent)');
    drawPolyline(rsamSvg, '', 'var(--ink)', 0.55);
    return;
  }
  let samples = [];
  try { samples = parseMiniSEED(result.buffer); } catch (_) {}
  const rsam = computeRSAM(samples, spsFor(result.channel), 10);
  lastWaveform = { samples, rsam, channel: result.channel };

  drawPolyline(waveSvg, samplesToPolyline(samples), 'var(--accent)');
  drawPolyline(rsamSvg, rsamToPolyline(rsam), 'var(--ink)', 0.55);
}

function renderAccueilWebcam() {
  const sel = document.getElementById('accueil-cam-select');
  const wrap = document.getElementById('accueil-webcam');
  const base = document.getElementById('webcams-grid')?.dataset.base;
  if (!sel || !sel.value || !base) return;
  wrap.innerHTML = `<img src="${base}${sel.value}?t=${Date.now()}" alt="webcam">
    <span class="webcam-timestamp">${fmtTime(new Date())}</span>`;
}

/* ─── Station selector (Courbes) ────────────────────────── */
function renderChips() {
  const chips = document.getElementById('station-chips');
  if (!chips) return;
  chips.innerHTML = '';
  const displayed = allStations.length ? allStations : PRIORITY_STATIONS;
  for (const code of displayed) {
    const btn = document.createElement('button');
    btn.className = 'station-chip' + (activeStations.has(code) ? ' active' : '');
    btn.textContent = code;
    btn.title = getMeta(code).name;
    btn.addEventListener('click', () => {
      if (activeStations.has(code)) { if (activeStations.size > 1) activeStations.delete(code); }
      else activeStations.add(code);
      renderChips();
      loadCourbes();
    });
    chips.appendChild(btn);
  }
}

/* ─── Courbes: per-station real waveforms ───────────────── */
async function loadCourbes() {
  if (isLoading) return;
  isLoading = true;
  setStatus('', 'Chargement…');

  const list = document.getElementById('stations-list');
  const end = new Date();
  const start = new Date(end - windowMinutes * 60 * 1000);
  const startISO = start.toISOString().replace(/\.\d+Z$/, 'Z');
  const endISO = end.toISOString().replace(/\.\d+Z$/, 'Z');

  const stations = [...activeStations].sort((a, b) => {
    const za = ZONE_ORDER.indexOf(getMeta(a).zone);
    const zb = ZONE_ORDER.indexOf(getMeta(b).zone);
    return (za === -1 ? 99 : za) - (zb === -1 ? 99 : zb) || a.localeCompare(b);
  });

  list.innerHTML = stations.map(code => {
    const m = getMeta(code);
    return `
      <div class="station-card" id="stcard-${code}">
        <div class="station-card-header">
          <div class="station-info">
            <span class="station-id">${NETWORK}.${code}</span>
            <span class="station-name">${m.name}</span>
            <span class="station-zone">${m.zone}</span>
          </div>
          <span class="station-time">chargement…</span>
        </div>
        <div class="station-card-charts">
          <div class="station-chart-section">
            <div class="station-chart-label">SIGNAL BRUT</div>
            <svg class="station-waveform" viewBox="0 0 600 120" preserveAspectRatio="none"></svg>
          </div>
          <div class="station-chart-section">
            <div class="station-chart-label">RSAM</div>
            <svg class="station-rsam" viewBox="0 0 600 120" preserveAspectRatio="none"></svg>
          </div>
        </div>
      </div>`;
  }).join('');

  let loaded = 0;
  await Promise.allSettled(stations.map(async (code) => {
    const result = await fetchWaveformData(code, startISO, endISO);
    const card = document.getElementById('stcard-' + code);
    if (!card) return;
    const timeEl = card.querySelector('.station-time');
    const waveSvg = card.querySelector('.station-waveform');
    const rsamSvg = card.querySelector('.station-rsam');

    if (!result) {
      timeEl.textContent = 'pas de données';
      drawPolyline(waveSvg, '', 'var(--accent)');
      drawPolyline(rsamSvg, '', 'var(--ink)', 0.5);
      return;
    }
    loaded++;
    let samples = [];
    try { samples = parseMiniSEED(result.buffer); } catch (_) {}
    const rsam = computeRSAM(samples, spsFor(result.channel), 10);
    timeEl.textContent = `${result.channel} · ${fmtTime(start)} → ${fmtTime(end)}`;
    drawPolyline(waveSvg, samplesToPolyline(samples), 'var(--accent)', 1, 1.5);
    drawPolyline(rsamSvg, rsamToPolyline(rsam), 'var(--ink)', 0.5, 1.5);
  }));

  isLoading = false;
  setStatus(loaded > 0 ? 'live' : 'error',
    loaded > 0 ? `En direct · ${loaded} station${loaded > 1 ? 's' : ''}` : 'Aucune donnée');
}

/* ─── Time window buttons ───────────────────────────────── */
function setWindow(min, btn) {
  windowMinutes = min;
  document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  loadCourbes();
  loadFeatured();
}

/* ═══════════════════════════════════════════════════════════
   BACKEND SECTIONS — séismes, bulletin, crise, webcams
   ═══════════════════════════════════════════════════════════ */
function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function backendMissingHTML(target) {
  target.innerHTML = `<p class="status-warning">Backend non configuré.</p>`;
}

async function loadSeismes() {
  const body = document.getElementById('seismes-body');
  const footer = document.getElementById('seismes-footer');
  if (!API_BASE) { backendMissingHTML(body); footer.textContent = ''; return; }
  try {
    const r = await fetch(`${API_BASE}/seismes?hours=24`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const c = d.counts || {};
    body.innerHTML = `
      <ul class="stat-list">
        <li><span class="dot-sm sommital"></span>Sommitaux <strong>${c.sommital ?? 0}</strong></li>
        <li><span class="dot-sm profond"></span>Profonds <strong>${c.profond ?? 0}</strong></li>
        <li><span class="dot-sm local"></span>Locaux <strong>${c.local ?? 0}</strong></li>
        <li><span class="dot-sm autre"></span>Autres <strong>${c.autre ?? 0}</strong></li>
      </ul>`;
    footer.textContent = `Fenêtre ${d.hours} h · source ${d.source} · MAJ ${fmtTime(new Date())}`;
    // feed crisis ribbon counts
    document.getElementById('stat-sommitaux').textContent = c.sommital ?? '—';
  } catch (e) {
    body.innerHTML = `<p class="status-error">Indisponible : ${e.message}</p>`;
    footer.textContent = '';
  }
}

async function loadBulletin() {
  const body = document.getElementById('bulletin-body');
  const footer = document.getElementById('bulletin-footer');
  if (!API_BASE) { backendMissingHTML(body); footer.textContent = ''; return; }
  try {
    const r = await fetch(`${API_BASE}/bulletin`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    const eb = d.eboulements || {};
    body.innerHTML = `
      <ul class="stat-list">
        <li>VT sommitaux <strong>${d.vt_sommitaux ?? '—'}</strong></li>
        <li>VT profonds <strong>${d.vt_profonds ?? '—'}</strong></li>
        <li>Séismes locaux <strong>${d.seismes_locaux ?? '—'}</strong></li>
        <li>Éboulements <strong>${eb.total ?? '—'}</strong></li>
      </ul>
      <p class="alerte-line">Niveau d'alerte : <strong>${d.niveau_alerte || '—'}</strong></p>
      ${eb.zones?.length ? `<p class="zones-line">Zones : ${eb.zones.join(', ')}</p>` : ''}`;
    footer.textContent = `Bulletin du ${d.date || '—'} · figé 1×/jour`;
    // feed crisis ribbon
    document.getElementById('stat-profonds').textContent = d.vt_profonds ?? '—';
    document.getElementById('stat-eboulements').textContent = eb.total ?? '—';
    document.getElementById('stat-ovpf').textContent = d.niveau_alerte || '—';
  } catch (e) {
    body.innerHTML = `<p class="status-error">Indisponible : ${e.message}</p>`;
    footer.textContent = '';
  }
}

async function loadCrise() {
  const body = document.getElementById('crise-body');
  const footer = document.getElementById('crise-footer');
  const badge = document.getElementById('crise-niveau');
  if (!API_BASE) { backendMissingHTML(body); footer.textContent = ''; badge.textContent = ''; return; }
  try {
    const r = await fetch(`${API_BASE}/crise?window=3&seuil=15`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const status = d.crise_probable ? 'CRISE PROBABLE' : 'CALME';
    badge.textContent = status;
    badge.className = 'status-card-badge crise-badge ' + (d.crise_probable ? 'is-crise' : 'is-calme');
    body.innerHTML = `
      <ul class="stat-list">
        <li>VT sommitaux <strong>${d.vt_sommitaux}</strong> / ${d.fenetre_h} h</li>
        <li>Taux <strong>${d.taux_par_heure}</strong> / h</li>
        <li>Seuil <strong>${d.seuil}</strong></li>
        <li>OVPF : <strong>${d.niveau_alerte_ovpf || '—'}</strong></li>
      </ul>`;
    footer.textContent = `MAJ ${fmtTime(new Date())}`;
    updateCrisisRibbon(d.niveau_alerte_ovpf, d.crise_probable);
  } catch (e) {
    body.innerHTML = `<p class="status-error">Indisponible : ${e.message}</p>`;
    footer.textContent = '';
    badge.textContent = '';
  }
}

function updateCrisisRibbon(niveau, criseProbable) {
  const label = (niveau || (criseProbable ? 'ALERTE' : 'VIGILANCE')).toUpperCase();
  const valEl = document.getElementById('crisis-value');
  const immEl = document.getElementById('immersion-crisis-label');
  if (valEl) valEl.textContent = label;
  if (immEl) immEl.textContent = label;

  // crisis color tier
  let color = 'var(--crisis)';
  if (/ALERTE|ERUPTION|CRISE/.test(label)) color = '#ff4d4d';
  else if (/CALME/.test(label)) color = 'var(--crisis-calm)';
  document.documentElement.style.setProperty('--crisis', color);
}

async function loadWebcams() {
  const grid = document.getElementById('webcams-grid');
  if (!API_BASE) { backendMissingHTML(grid); return; }
  try {
    const r = await fetch(`${API_BASE}/webcams`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    grid.dataset.base = d.base;
    grid.innerHTML = d.cams.map(c => `
      <div class="webcam-card">
        <div class="webcam-card-time">${fmtTime(new Date())}</div>
        <img class="webcam-card-img" data-cam="${c.file}" src="${d.base}${c.file}?t=${Date.now()}" alt="${c.label}" loading="lazy">
        <div class="webcam-card-footer">
          <span class="webcam-card-name">${c.label}</span>
          <span class="webcam-card-credit">© OVPF-IPGP</span>
        </div>
      </div>`).join('');

    // populate accueil cam dropdown once
    const sel = document.getElementById('accueil-cam-select');
    if (sel && !sel.options.length) {
      sel.innerHTML = d.cams.map(c => `<option value="${c.file}">${c.label}</option>`).join('');
      sel.addEventListener('change', () => { renderAccueilWebcam(); if (immersionOn) renderImmersion(); });
    }
    renderAccueilWebcam();

    // attach filter listeners (visual)
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      };
    });
  } catch (e) {
    grid.innerHTML = `<p class="status-error">Webcams indisponibles : ${e.message}</p>`;
  }
}

function refreshWebcamImages() {
  const base = document.getElementById('webcams-grid')?.dataset.base;
  if (!base) return;
  document.querySelectorAll('img[data-cam]').forEach(el => {
    el.src = base + el.dataset.cam + '?t=' + Date.now();
  });
  renderAccueilWebcam();
}

/* ─── Event wiring ──────────────────────────────────────── */
function attachEvents() {
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', (e) => { e.preventDefault(); switchPage(link.dataset.nav); });
  });
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
  document.getElementById('enter-immersion').addEventListener('click', enterImmersion);
  document.getElementById('exit-immersion').addEventListener('click', exitImmersion);
  document.getElementById('swap-bg').addEventListener('click', swapImmersionBg);
  document.querySelector('.widget-header').addEventListener('pointerdown', startWidgetDrag);

  document.querySelectorAll('.time-btn[data-win]').forEach(btn => {
    btn.addEventListener('click', () => setWindow(parseInt(btn.dataset.win, 10), btn));
  });
  document.getElementById('btn-refresh').addEventListener('click', () => { loadCourbes(); loadFeatured(); });

  const stationSel = document.getElementById('accueil-station-select');
  if (stationSel) {
    stationSel.addEventListener('change', () => {
      featuredStation = stationSel.value;
      loadFeatured();
    });
  }
}

/* ─── Init ──────────────────────────────────────────────── */
async function init() {
  setupTheme();
  attachEvents();
  setStatus('', 'Connexion…');

  const stations = await fetchStations();
  allStations = stations.filter(s => s.length <= 5);
  const available = new Set(allStations);
  activeStations = new Set(PRIORITY_STATIONS.filter(s => available.has(s)).slice(0, 6));
  if (activeStations.size === 0) allStations.slice(0, 5).forEach(s => activeStations.add(s));

  // pick featured station from available priority list
  featuredStation = [...activeStations][0] || 'BOR';
  const stationSel = document.getElementById('accueil-station-select');
  if (stationSel) {
    const opts = (allStations.length ? allStations : PRIORITY_STATIONS);
    stationSel.innerHTML = opts.map(c => `<option value="${c}"${c === featuredStation ? ' selected' : ''}>${NETWORK}.${c}</option>`).join('');
  }

  renderChips();
  loadFeatured();
  loadWebcams();
  loadSeismes();
  loadBulletin();
  loadCrise();

  setStatus('live', 'En direct');

  refreshTimer = setInterval(() => {
    loadFeatured();
    if (currentPage === 'courbes') loadCourbes();
  }, REFRESH_MS);
  setInterval(() => { loadSeismes(); loadCrise(); }, 120_000);
  setInterval(loadBulletin, 3_600_000);
  setInterval(refreshWebcamImages, 30_000);
}

document.addEventListener('DOMContentLoaded', init);
