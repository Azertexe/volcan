/* ──────────────────────────────────────────────────────────────
   Piton de la Fournaise — Real-time tremor dashboard
   Data source: RESIF FDSN Web Services (ws.resif.fr)
   Network: PF (OVPF-IPGP)
   MiniSEED 2.x parser: pure JS — reads Blockette 1000 for
   record length and encoding, supports Steim-1 and Steim-2.
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

function setStatus(state, text) {
     $statusDot.className = 'dot ' + state;
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

/* ─── Draw waveform on canvas ────────────────────────────── */
function drawWaveform(canvas, buffer, channel) {
     const ctx = canvas.getContext('2d');
     const W   = canvas.width  = canvas.offsetWidth  || 900;
     const H   = canvas.height = canvas.offsetHeight || 140;
     ctx.clearRect(0, 0, W, H);

  // Background grid
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
            drawError(ctx, W, H, 'Erreur de lecture');
            return;
     }

  if (!samples || samples.length === 0) {
         drawError(ctx, W, H, 'Aucune donnée décodée');
         return;
  }

  // Compute min/max for normalization
  let min = Infinity, max = -Infinity;
     for (const v of samples) {
            if (v < min) min = v;
            if (v > max) max = v;
     }
     const range = max - min || 1;
     const pad   = H * 0.1;

  // Color: orange for HF channels, blue for LF
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

  // Zero / median line
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

  const endTime    = new Date();
     const startTime  = new Date(endTime - windowMinutes * 60 * 1000);
     const startISO   = startTime.toISOString().replace(/\.\d+Z$/, 'Z');
     const endISO     = endTime.toISOString().replace(/\.\d+Z$/, 'Z');
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
                                          panel.querySelector('.panel-body').innerHTML =
                                                     `<div class="panel-error">Pas de données disponibles pour cette station sur la période</div>`;
                                 }
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
