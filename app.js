/* ──────────────────────────────────────────────────────────────
   Piton de la Fournaise — Real-time tremor dashboard
   Data source: RESIF FDSN Web Services (ws.resif.fr)
   Network: PF (OVPF-IPGP)
   MiniSEED 2.x parser: pure JS (Steim-1/2, Blockette 1000) — no CDN.
────────────────────────────────────────────────────────────── */

/* ─── Backend (séismes / bulletin / webcams / crise) ──────
   Remplace par l'URL Render après déploiement, p.ex. :
   const API_BASE = 'https://volcan-backend.onrender.com';
   Laisser '' désactive proprement les sections backend.
*/
const API_BASE = 'https://volcan-backend-gnem.onrender.com';

const FDSN_BASE   = 'https://ws.resif.fr/fdsnws';
const NETWORK     = 'PF';
const REFRESH_MS  = 60_000;
const DEFAULT_WIN = 30;

/* ─── Station metadata (name + geographic zone) ──────────── */
const ZONE_ORDER = [
  'Sommet', 'Enclos Fouqué', 'Pentes N', 'Pentes S',
  'Pentes E', 'Grand Brûlé', 'Hors enclos', 'Autre',
];

const STATIONS_META = {
  BOR: { name: 'Bory',            zone: 'Enclos Fouqué' },
  FEU: { name: 'Feu',             zone: 'Enclos Fouqué' },
  CSS: { name: 'Cassé Sud',       zone: 'Enclos Fouqué' },
  FOR: { name: 'Formica Leo',     zone: 'Enclos Fouqué' },
  FER: { name: 'Ferret',          zone: 'Enclos Fouqué' },
  PER: { name: 'Pére',            zone: 'Pentes S' },
  RVP: { name: 'Ravine Plate',    zone: 'Pentes S' },
  RVL: { name: 'Ravine Langevin', zone: 'Pentes S' },
  NSR: { name: 'Nez Scie',        zone: 'Pentes N' },
  SNE: { name: 'Sainte-Neige',    zone: 'Pentes N' },
  RER: { name: 'Rempart Est',     zone: 'Grand Brûlé' },
  BEB: { name: 'Basse Estelle B', zone: 'Grand Brûlé' },
  HDL: { name: 'Hauts-de-Ligne',  zone: 'Hors enclos' },
  MAT: { name: 'Matouta',         zone: 'Hors enclos' },
  PJR: { name: 'Piton Jacquot',   zone: 'Hors enclos' },
};

function getMeta(code) {
  return STATIONS_META[code] || { name: code, zone: 'Autre' };
}

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

/* ═══════════════════════════════════════════════════════════
   MINISEED 2.x PARSER — pure JavaScript
   Correctly reads Blockette 1000 for record length/encoding
   Supports: encoding 1 (int16), 3 (int32), 4 (float32),
             5 (float64), 10 (Steim-1), 11 (Steim-2)
   ═══════════════════════════════════════════════════════════ */

/**
 * Sign-extend a value from `bits` to 32-bit signed integer.
 */
function signExtend(val, bits) {
     const sign = 1 << (bits - 1);
     return (val ^ sign) - sign;
}

/**
 * Parse a MiniSEED 2.x buffer and return a flat array of sample values.
 */
function parseMiniSEED(buffer) {
     const allSamples = [];
     const bytes = new Uint8Array(buffer);
     let offset = 0;

  while (offset + 64 <= buffer.byteLength) {
         // Validate 6-byte ASCII sequence number
       let valid = true;
         for (let i = 0; i < 6; i++) {
                  if (bytes[offset + i] < 48 || bytes[offset + i] > 57) { valid = false; break; }
         }
         if (!valid) { offset++; continue; }

       const view = new DataView(buffer, offset);

       // Fixed section of Data Header
       const numSamples          = view.getUint16(30, false); // big-endian
       const dataOffset          = view.getUint16(44, false); // offset to first data byte
       const firstBlocketteOff   = view.getUint16(46, false); // offset to first blockette

       // Read Blockette 1000 (Data Only SEED Blockette) to get encoding & record length
       let encoding   = 11; // default Steim-2
       let bigEndian  = true;
         let recLenExp  = 9;  // default 512 bytes

       if (firstBlocketteOff >= 48 && offset + firstBlocketteOff + 8 <= buffer.byteLength) {
                let blkOff = firstBlocketteOff;
                // Walk blockette chain looking for type 1000
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

       const recLen    = Math.pow(2, recLenExp);
         const le        = !bigEndian; // little-endian flag for DataView

       if (offset + recLen > buffer.byteLength) break;
         if (numSamples === 0 || dataOffset < 48 || dataOffset >= recLen) {
                  offset += recLen;
                  continue;
         }

       const dataStart = offset + dataOffset;
         const dataLen   = recLen - dataOffset;

       try {
                const chunk = decodeData(buffer, dataStart, dataLen, numSamples, encoding, le);
                for (const s of chunk) allSamples.push(s);
       } catch (_) { /* skip bad record */ }

       offset += recLen;
  }

  return allSamples;
}

function decodeData(buffer, start, dataLen, numSamples, encoding, le) {
     const view = new DataView(buffer, start, dataLen);
     const out  = [];

  switch (encoding) {
     case 1: // 16-bit integers
         for (let i = 0; i < numSamples && (i + 1) * 2 <= dataLen; i++)
                    out.push(view.getInt16(i * 2, le));
              break;
     case 3: // 32-bit integers
         for (let i = 0; i < numSamples && (i + 1) * 4 <= dataLen; i++)
                    out.push(view.getInt32(i * 4, le));
              break;
     case 4: // 32-bit float
         for (let i = 0; i < numSamples && (i + 1) * 4 <= dataLen; i++)
                    out.push(view.getFloat32(i * 4, le));
              break;
     case 5: // 64-bit float
         for (let i = 0; i < numSamples && (i + 1) * 8 <= dataLen; i++)
                    out.push(view.getFloat64(i * 8, le));
              break;
     case 10:
              return decodeSteim1(buffer, start, dataLen, numSamples);
     case 11:
              return decodeSteim2(buffer, start, dataLen, numSamples);
     default:
              return [];
  }
     return out;
}

/* ─── Steim-1 decoder ────────────────────────────────────── */
function decodeSteim1(buffer, start, dataLen, numSamples) {
     const bytes  = new Uint8Array(buffer, start, dataLen);
     const view   = new DataView(buffer, start, dataLen);
     const frames = Math.floor(dataLen / 64);
     const out    = [];
     let   last   = 0;

  for (let f = 0; f < frames && out.length < numSamples; f++) {
         const fo = f * 64;
         const cn = view.getUint32(fo, false); // big-endian control nibbles

       for (let w = 0; w < 16 && out.length < numSamples; w++) {
                const nibble = (cn >>> (30 - w * 2)) & 0x3;
                const wo     = fo + w * 4;

           if (f === 0 && w === 1) { last = view.getInt32(wo, false); continue; } // x0
           if (f === 0 && w === 2) continue;                                       // xn
           if (nibble === 0) continue;

           const word    = view.getUint32(wo, false);
                const deltas  = [];

           if (nibble === 1) {
                      deltas.push(view.getInt32(wo, false));
           } else if (nibble === 2) {
                      deltas.push(signExtend((word >>> 16) & 0xFFFF, 16));
                      deltas.push(signExtend(word & 0xFFFF, 16));
           } else if (nibble === 3) {
                      deltas.push(signExtend((word >>> 24) & 0xFF, 8));
                      deltas.push(signExtend((word >>> 16) & 0xFF, 8));
                      deltas.push(signExtend((word >>> 8)  & 0xFF, 8));
                      deltas.push(signExtend(word & 0xFF, 8));
           }

           for (const d of deltas) {
                      last += d;
                      out.push(last);
                      if (out.length >= numSamples) break;
           }
       }
  }
     return out;
}

/* ─── Steim-2 decoder ────────────────────────────────────── */
function decodeSteim2(buffer, start, dataLen, numSamples) {
     const view   = new DataView(buffer, start, dataLen);
     const frames = Math.floor(dataLen / 64);
     const out    = [];
     let   last   = 0;

  for (let f = 0; f < frames && out.length < numSamples; f++) {
         const fo = f * 64;
         const cn = view.getUint32(fo, false); // big-endian

       for (let w = 0; w < 16 && out.length < numSamples; w++) {
                const nibble = (cn >>> (30 - w * 2)) & 0x3;
                const wo     = fo + w * 4;

           // Frame 0: w=1 is x0 (first sample, stored as int32), w=2 is xn
           if (f === 0 && w === 1) { last = view.getInt32(wo, false); continue; }
                if (f === 0 && w === 2) continue;

           if (nibble === 0) continue; // no data in this word

           const word   = view.getUint32(wo, false);
                const deltas = [];

           if (nibble === 1) {
                      // One 32-bit uncompressed sample (not a difference)
                  last = view.getInt32(wo, false);
                      out.push(last);
                      continue;
           }

           // nibble = 2 or 3: variable-length differences encoded in 30 bits
           // Bits 31-30 = dnib (sub-type), bits 29-0 = data
           const dnib = (word >>> 30) & 0x3;

           if (nibble === 2) {
                      if (dnib === 1) {
                                   // 1 difference × 30 bits
                        deltas.push(signExtend(word & 0x3FFFFFFF, 30));
                      } else if (dnib === 2) {
                                   // 2 differences × 15 bits
                        deltas.push(signExtend((word >>> 15) & 0x7FFF, 15));
                                   deltas.push(signExtend(word & 0x7FFF, 15));
                      } else if (dnib === 3) {
                                   // 3 differences × 10 bits
                        deltas.push(signExtend((word >>> 20) & 0x3FF, 10));
                                   deltas.push(signExtend((word >>> 10) & 0x3FF, 10));
                                   deltas.push(signExtend(word & 0x3FF, 10));
                      }
           } else { // nibble === 3
                  if (dnib === 0) {
                               // 5 differences × 6 bits
                        deltas.push(signExtend((word >>> 24) & 0x3F, 6));
                               deltas.push(signExtend((word >>> 18) & 0x3F, 6));
                               deltas.push(signExtend((word >>> 12) & 0x3F, 6));
                               deltas.push(signExtend((word >>> 6)  & 0x3F, 6));
                               deltas.push(signExtend(word & 0x3F, 6));
                  } else if (dnib === 1) {
                               // 6 differences × 5 bits
                        deltas.push(signExtend((word >>> 25) & 0x1F, 5));
                               deltas.push(signExtend((word >>> 20) & 0x1F, 5));
                               deltas.push(signExtend((word >>> 15) & 0x1F, 5));
                               deltas.push(signExtend((word >>> 10) & 0x1F, 5));
                               deltas.push(signExtend((word >>> 5)  & 0x1F, 5));
                               deltas.push(signExtend(word & 0x1F, 5));
                  } else if (dnib === 2) {
                               // 7 differences × 4 bits
                        deltas.push(signExtend((word >>> 24) & 0xF, 4));
                               deltas.push(signExtend((word >>> 20) & 0xF, 4));
                               deltas.push(signExtend((word >>> 16) & 0xF, 4));
                               deltas.push(signExtend((word >>> 12) & 0xF, 4));
                               deltas.push(signExtend((word >>> 8)  & 0xF, 4));
                               deltas.push(signExtend((word >>> 4)  & 0xF, 4));
                               deltas.push(signExtend(word & 0xF, 4));
                  }
                      // dnib === 3: not used in standard Steim-2
           }

           for (const d of deltas) {
                      last += d;
                      out.push(last);
                      if (out.length >= numSamples) break;
           }
       }
  }
     return out;
}

/* ═══════════════════════════════════════════════════════════ */

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

/* ─── Compute RSAM (mean absolute amplitude per window) ──── */
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
  let min = Infinity, max = -Infinity;
  for (const v of data) { if (v < min) min = v; if (v > max) max = v; }
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

  const zeroY = pad + (max / range) * (H - 2 * pad);
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth   = 0.5;
  ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(W, zeroY); ctx.stroke();
}

function drawCanvasLabel(ctx, text, color) {
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

function renderCanvas(canvas, data, color, labelText) {
  const W = canvas.width  = canvas.offsetWidth  || 600;
  const H = canvas.height = canvas.offsetHeight || 140;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  drawGrid(ctx, W, H);
  if (data && data.length) {
    drawLine(ctx, data, W, H, color);
    drawCanvasLabel(ctx, labelText, color + 'cc');
  } else {
    drawError(ctx, W, H, 'Aucune donnée');
  }
}

/* ─── Build dual panel (raw waveform + RSAM) ─────────────── */
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
      <div class="panel-half"><canvas class="panel-canvas" id="canvas-wf-${station}"></canvas></div>
      <div class="panel-half"><canvas class="panel-canvas" id="canvas-rsam-${station}"></canvas></div>
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

  const endTime    = new Date();
  const startTime  = new Date(endTime - windowMinutes * 60 * 1000);
  const startISO   = startTime.toISOString().replace(/\.\d+Z$/, 'Z');
  const endISO     = endTime.toISOString().replace(/\.\d+Z$/, 'Z');
  const startLabel = fmtTime(startTime);
  const endLabel   = fmtTime(endTime);

  // Sort active stations by geographic zone order
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
      panel.querySelector('.panel-dual').innerHTML =
        `<div class="panel-error">Pas de données disponibles pour cette station</div>`;
      return;
    }

    loaded++;
    let samples = [];
    try { samples = parseMiniSEED(result.buffer); } catch (_) {}

    const sps      = channel.startsWith('H') ? 100 : channel.startsWith('B') ? 20 : 50;
    const rsam     = computeRSAM(samples, sps, 10);

    requestAnimationFrame(() => {
      const cvWF   = document.getElementById('canvas-wf-'   + station);
      const cvRSAM = document.getElementById('canvas-rsam-' + station);
      if (cvWF)   renderCanvas(cvWF,   samples, '#ff8c42', 'Signal brut');
      if (cvRSAM) renderCanvas(cvRSAM, rsam,    '#30d158', 'RSAM');
    });
  });

  await Promise.allSettled(tasks);

  $overlay.classList.add('hidden');
  $lastUpdate.textContent   = fmtTime(new Date());
  $stationCount.textContent = `${loaded} / ${stations.length}`;
  isLoading = false;

  setStatus(
    loaded > 0 ? 'live' : 'error',
    loaded > 0 ? `En direct · ${loaded} station${loaded > 1 ? 's' : ''}` : 'Aucune donnée reçue'
  );
}

/* ─── Station chips (grouped by zone) ────────────────────── */
function renderChips() {
  $chips.innerHTML = '';
  const displayed = allStations.length ? allStations : PRIORITY_STATIONS;

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
    label.className   = 'chip-group-label' + (first ? '' : ' chip-group-label--gap');
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

/* ═══════════════════════════════════════════════════════════
   BACKEND SECTIONS — séismes, bulletin, crise, webcams
   ═══════════════════════════════════════════════════════════ */

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function backendMissingHTML(target) {
  target.innerHTML = `
    <p class="status-warning">
      Backend non configuré. Renseigne <code>API_BASE</code> en haut de
      <code>app.js</code> avec l'URL de ton déploiement Render.
    </p>`;
}

async function loadSeismes() {
  const body   = document.getElementById('seismes-body');
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
  } catch (e) {
    body.innerHTML = `<p class="status-error">Indisponible : ${e.message}</p>`;
    footer.textContent = '';
  }
}

async function loadBulletin() {
  const body   = document.getElementById('bulletin-body');
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
      <p class="alerte-line">
        Niveau d'alerte : <strong>${d.niveau_alerte || '—'}</strong>
      </p>
      ${eb.zones?.length ? `<p class="zones-line">Zones : ${eb.zones.join(', ')}</p>` : ''}`;
    footer.textContent = `Bulletin du ${d.date || '—'} · figé 1×/jour`;
  } catch (e) {
    body.innerHTML = `<p class="status-error">Indisponible : ${e.message}</p>`;
    footer.textContent = '';
  }
}

async function loadCrise() {
  const body   = document.getElementById('crise-body');
  const footer = document.getElementById('crise-footer');
  const badge  = document.getElementById('crise-niveau');
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
  } catch (e) {
    body.innerHTML = `<p class="status-error">Indisponible : ${e.message}</p>`;
    footer.textContent = '';
    badge.textContent = '';
  }
}

async function loadWebcams() {
  const grid = document.getElementById('webcams-grid');
  if (!API_BASE) { backendMissingHTML(grid); return; }
  try {
    const r = await fetch(`${API_BASE}/webcams`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    grid.innerHTML = d.cams.map(c => `
      <figure class="webcam">
        <img data-cam="${c.file}" src="${d.base}${c.file}?t=${Date.now()}" alt="${c.label}" loading="lazy">
        <figcaption>${c.label}<span>© OVPF-IPGP</span></figcaption>
      </figure>`).join('');
    grid.dataset.base = d.base;
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
}

function loadBackendSections() {
  loadSeismes();
  loadCrise();
}

/* ─── Init ───────────────────────────────────────────────── */
async function init() {
  setStatus('', 'Connexion…');
  const stations = await fetchStations();
  allStations = stations.filter(s => s.length <= 5);

  const available = new Set(allStations);
  activeStations  = new Set(PRIORITY_STATIONS.filter(s => available.has(s)).slice(0, 6));
  if (activeStations.size === 0) allStations.slice(0, 5).forEach(s => activeStations.add(s));

  renderChips();
  await loadData();
  startAutoRefresh();

  loadBackendSections();
  loadBulletin();
  loadWebcams();
  setInterval(loadBackendSections, 120_000);
  setInterval(loadBulletin, 3_600_000);
  setInterval(refreshWebcamImages, 30_000);
}

init();
