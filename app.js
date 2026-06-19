/* ──────────────────────────────────────────────────────────────
   Piton de la Fournaise — Real-time tremor dashboard
   Data source: RESIF FDSN Web Services (ws.resif.fr)
   Network: PF (OVPF-IPGP)
   MiniSEED parser: pure JS (no external lib needed)
────────────────────────────────────────────────────────────── */

const FDSN_BASE   = 'https://ws.resif.fr/fdsnws';
const NETWORK     = 'PF';
const REFRESH_MS  = 60_000;
const DEFAULT_WIN = 30;

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
const $panels      = document.getElementById('panels');
const $specPanels  = document.getElementById('spectro-panels');
const $overlay     = document.getElementById('loading-overlay');
const $chips       = document.getElementById('station-chips');
const $statusDot   = document.querySelector('.dot');
const $statusText  = document.getElementById('status-text');
const $lastUpdate  = document.getElementById('last-update');
const $stationCount = document.getElementById('station-count');
const $windowLabel = document.getElementById('window-label');

/* ─── Helpers ────────────────────────────────────────────── */
function fmtTime(d) {
     return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function setStatus(state, text) {
     $statusDot.className = 'dot ' + state;
     $statusText.textContent = text;
}

/* ═══════════════════════════════════════════════════════════
   MINISEED PARSER (pure JS — no external library)
   Supports encodings: 1 (int16), 3 (int32), 4 (float32),
                       5 (float64), 10 (Steim-1), 11 (Steim-2)
   ═══════════════════════════════════════════════════════════ */

function parseMiniSEED(buffer) {
     const samples = [];
     let offset = 0;
     const bytes = new Uint8Array(buffer);

  while (offset + 48 < buffer.byteLength) {
         const view = new DataView(buffer, offset);

       // Validate sequence number (6 ASCII digits)
       let validHeader = true;
         for (let i = 0; i < 6; i++) {
                  const c = bytes[offset + i];
                  if (c < 48 || c > 57) { validHeader = false; break; }
         }
         if (!validHeader) { offset++; continue; }

       // Read fixed header fields
       const recLenExp   = view.getUint8(20);       // byte 20: record length as 2^n
       const encoding    = view.getUint8(45);        // byte 45: encoding format
       const byteOrder   = view.getUint8(46);        // byte 46: word order (1=big-endian)
       const dataOffset  = view.getUint16(44, false); // bytes 44-45: offset to data (big-endian)
       const numSamples  = view.getUint16(30, false); // bytes 30-31: number of samples
       const recLen      = recLenExp >= 8 && recLenExp <= 16 ? Math.pow(2, recLenExp) : 4096;

       if (offset + recLen > buffer.byteLength) break;
         if (numSamples === 0 || dataOffset < 48 || dataOffset >= recLen) {
                  offset += recLen;
                  continue;
         }

       const be = byteOrder !== 0; // big-endian?
       const dataStart = offset + dataOffset;
         const dataLen   = recLen - dataOffset;

       try {
                const chunk = decodeSamples(buffer, dataStart, dataLen, numSamples, encoding, be);
                for (const s of chunk) samples.push(s);
       } catch (e) {
                // skip bad record
       }

       offset += recLen;
  }

  return samples;
}

function decodeSamples(buffer, start, dataLen, numSamples, encoding, bigEndian) {
     const view = new DataView(buffer, start, dataLen);
     const out  = [];

  switch (encoding) {
     case 1: { // 16-bit integers
              for (let i = 0; i < numSamples && (i * 2 + 2) <= dataLen; i++)
                         out.push(view.getInt16(i * 2, !bigEndian));
              break;
     }
     case 3: { // 32-bit integers
              for (let i = 0; i < numSamples && (i * 4 + 4) <= dataLen; i++)
                         out.push(view.getInt32(i * 4, !bigEndian));
              break;
     }
     case 4: { // 32-bit float
              for (let i = 0; i < numSamples && (i * 4 + 4) <= dataLen; i++)
                         out.push(view.getFloat32(i * 4, !bigEndian));
              break;
     }
     case 5: { // 64-bit float
              for (let i = 0; i < numSamples && (i * 8 + 8) <= dataLen; i++)
                         out.push(view.getFloat64(i * 8, !bigEndian));
              break;
     }
     case 10: // Steim-1
         return decodeSteim1(buffer, start, dataLen, numSamples, bigEndian);
     case 11: // Steim-2
         return decodeSteim2(buffer, start, dataLen, numSamples, bigEndian);
     default:
              return []; // unsupported encoding
  }
     return out;
}

function decodeSteim1(buffer, start, dataLen, numSamples, bigEndian) {
     const view   = new DataView(buffer, start, dataLen);
     const frames = Math.floor(dataLen / 64);
     const out    = [];
     let x0 = null, last = 0;

  for (let f = 0; f < frames; f++) {
         const fo  = f * 64;
         const cn  = view.getUint32(fo, !bigEndian); // control nibbles word

       for (let w = 0; w < 16; w++) {
                const nibble = (cn >>> (30 - w * 2)) & 0x3;
                const wo     = fo + w * 4;
                const word   = view.getInt32(wo, !bigEndian);

           if (f === 0 && w === 1) { x0 = word; last = word; continue; }
                if (f === 0 && w === 2) continue; // xn

           if (nibble === 0) continue; // special

           let deltas = [];
                if (nibble === 1)      deltas = [word];                                              // 1×32
           else if (nibble === 2) deltas = [(word >> 16) & 0xffff | (((word >> 16) & 0x8000) ? 0xffff0000 : 0),
                                                                                   (word & 0xffff)       | ((word & 0x8000)         ? 0xffff0000 : 0)]; // 2×16
           else if (nibble === 3) deltas = [((word >> 24) << 24) >> 24,
                                                                                   ((word >> 16) << 24) >> 24,
                                                                                   ((word >>  8) << 24) >> 24,
                                                                                   ((word)       << 24) >> 24];                        // 4×8

           for (const d of deltas) {
                      last += d;
                      out.push(last);
                      if (out.length >= numSamples) return out;
           }
       }
  }
     return out;
}

function decodeSteim2(buffer, start, dataLen, numSamples, bigEndian) {
     const view   = new DataView(buffer, start, dataLen);
     const frames = Math.floor(dataLen / 64);
     const out    = [];
     let last = 0;

  for (let f = 0; f < frames; f++) {
         const fo = f * 64;
         const cn = view.getUint32(fo, !bigEndian);

       for (let w = 0; w < 16; w++) {
                const nibble = (cn >>> (30 - w * 2)) & 0x3;
                if (nibble === 0) continue;

           const wo   = fo + w * 4;
                const word = view.getUint32(wo, !bigEndian);

           if (f === 0 && (w === 1 || w === 2)) {
                      if (w === 1) last = view.getInt32(wo, !bigEndian);
                      continue;
           }

           if (nibble === 1) { // uncompressed int32
                  const v = view.getInt32(wo, !bigEndian);
                      out.push(v); last = v;
                      if (out.length >= numSamples) return out;
                      continue;
           }

           // nibble 2 or 3: Steim-2 compressed
           const dnib = (word >>> 30) & 0x3;
                let deltas = [];

           if (nibble === 2) {
                      if      (dnib === 1) deltas = steim2Unpack(word, 1, 30, true);
                      else if (dnib === 2) deltas = steim2Unpack(word, 2, 15, true);
                      else if (dnib === 3) deltas = steim2Unpack(word, 3, 10, true);
           } else { // nibble === 3
                  if      (dnib === 0) deltas = steim2Unpack(word, 5,  6, true);
                      else if (dnib === 1) deltas = steim2Unpack(word, 6,  5, true);
                      else if (dnib === 2) deltas = steim2Unpack(word, 7,  4, true, true);
           }

           for (const d of deltas) {
                      last += d;
                      out.push(last);
                      if (out.length >= numSamples) return out;
           }
       }
  }
     return out;
}

function steim2Unpack(word, count, bits, signed, skipDnib) {
     const out    = [];
     const start  = skipDnib ? 28 - (count - 1) * bits : 30 - count * bits;
     const mask   = (1 << bits) - 1;
     const signBit = 1 << (bits - 1);

  for (let i = 0; i < count; i++) {
         const shift = start - i * bits;
         let v = (shift >= 0) ? ((word >>> shift) & mask) : 0;
         if (signed && (v & signBit)) v |= ~mask; // sign extend
       out.push(v | 0);
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
            const codes = Array.from(doc.querySelectorAll('Station')).map(n => n.getAttribute('code')).filter(Boolean);
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

/* ─── Draw waveform on canvas ────────────────────────────── */
function drawWaveform(canvas, buffer, channel) {
     const ctx = canvas.getContext('2d');
     const W   = canvas.width  = canvas.offsetWidth  || 900;
     const H   = canvas.height = canvas.offsetHeight || 140;
     ctx.clearRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
     ctx.lineWidth   = 1;
     for (let i = 1; i < 4; i++) {
            const y = (H / 4) * i;
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
     }

  // Parse MiniSEED
  let samples;
     try {
            samples = parseMiniSEED(buffer);
     } catch (e) {
            console.warn('MiniSEED parse error:', e);
            drawError(ctx, W, H, 'Données illisibles');
            return;
     }

  if (!samples || samples.length === 0) {
         drawError(ctx, W, H, 'Aucune donnée décodée');
         return;
  }

  // Normalize
  let min = Infinity, max = -Infinity;
     for (const v of samples) { if (v < min) min = v; if (v > max) max = v; }
     const range = max - min || 1;
     const pad   = H * 0.1;

  const isHF = channel.startsWith('H') || channel.startsWith('E');
     ctx.strokeStyle = isHF ? '#ff8c42' : '#5b9bd5';
     ctx.lineWidth   = 1.2;
     ctx.beginPath();

  const step = samples.length / W;
     for (let px = 0; px < W; px++) {
            const idx = Math.min(Math.floor(px * step), samples.length - 1);
            const y   = pad + ((max - samples[idx]) / range) * (H - 2 * pad);
            px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
     }
     ctx.stroke();

  // Zero line
  const zeroY = pad + (max / range) * (H - 2 * pad);
     ctx.strokeStyle = 'rgba(255,255,255,0.08)';
     ctx.lineWidth   = 0.5;
     ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(W, zeroY); ctx.stroke();
}

function drawError(ctx, W, H, msg) {
     ctx.fillStyle = 'rgba(255,78,26,0.15)';
     ctx.fillRect(0, 0, W, H);
     ctx.fillStyle = '#7a7a90';
     ctx.font      = '13px Inter, system-ui, sans-serif';
     ctx.textAlign = 'center';
     ctx.fillText(msg, W / 2, H / 2 + 5);
}

/* ─── Build panel DOM ────────────────────────────────────── */
function buildPanel(id, station, channel, startLabel, endLabel) {
     const div = document.createElement('div');
     div.className = 'panel';
     div.id        = 'panel-' + id;
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
         const result  = await fetchWaveformData(station, startISO, endISO);
         const id      = station;
         const channel = result ? result.channel : '—';
         const panel   = buildPanel(id, station, channel, startLabel, endLabel);
         $panels.appendChild(panel);

                                 if (result) {
                                          const canvas = document.getElementById('canvas-' + id);
                                          if (canvas) {
                                                     requestAnimationFrame(() => drawWaveform(canvas, result.buffer, result.channel));
                                          }
                                          loaded++;
                                 } else {
                                          const body = panel.querySelector('.panel-body');
                                          body.innerHTML = `<div class="panel-error">Pas de données disponibles pour cette station sur la période</div>`;
                                 }
  });

  await Promise.allSettled(tasks);

  $overlay.classList.add('hidden');
     $lastUpdate.textContent  = fmtTime(new Date());
     $stationCount.textContent = `${loaded} / ${stations.length}`;
     isLoading = false;

  setStatus(loaded > 0 ? 'live' : 'error',
                        loaded > 0 ? `En direct · ${loaded} station${loaded > 1 ? 's' : ''}` : 'Aucune donnée reçue');
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
     const stations = await fetchStations();
     allStations = stations.filter(s => s.length <= 5);

  const available = new Set(allStations);
     activeStations  = new Set(PRIORITY_STATIONS.filter(s => available.has(s)).slice(0, 6));
     if (activeStations.size === 0) allStations.slice(0, 5).forEach(s => activeStations.add(s));

  renderChips();
     await loadData();
     startAutoRefresh();
}

init();
