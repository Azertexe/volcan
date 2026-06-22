/* ──────────────────────────────────────────────────────────────
   Piton de la Fournaise — Tableau de bord trémor (lo-fi)
   Données : backend Flask (app.py) → /tremor /signal /seismes
             /bulletin /webcams /crise /stations
   Source réelle : RESIF FDSN + OVPF-IPGP.
────────────────────────────────────────────────────────────── */

const API_BASE = 'https://volcan-backend-gnem.onrender.com';
const REFRESH_MS = 60_000;
const FETCH_CONCURRENCY = 3; // requêtes simultanées max (backend free tier)

// Ordre de préférence des zones (les zones inconnues sont ajoutées à la fin).
const ZONE_PREF = [
  'Sommet / Enclos', 'Enclos Fouqué', 'Pentes N', 'Pentes S',
  'Pentes E / Grand Brûlé', 'Grand Brûlé', 'Pentes O', 'Hors enclos', 'Autre',
];

// Liste de repli si /stations est indisponible (codes OVPF connus).
const FALLBACK_STATIONS = [
  { id: 'BOR', name: 'Bory',            zone: 'Sommet / Enclos' },
  { id: 'FEU', name: 'Feu',             zone: 'Sommet / Enclos' },
  { id: 'CSS', name: 'Cassé Sud',       zone: 'Sommet / Enclos' },
  { id: 'FOR', name: 'Formica Leo',     zone: 'Sommet / Enclos' },
  { id: 'FER', name: 'Ferret',          zone: 'Sommet / Enclos' },
  { id: 'NSR', name: 'Nez Coupé Ste-Rose', zone: 'Pentes N' },
  { id: 'SNE', name: 'Sainte-Rose NE',  zone: 'Pentes N' },
  { id: 'PER', name: 'Père',            zone: 'Pentes S' },
  { id: 'RVP', name: 'Ravine Plate',    zone: 'Pentes S' },
  { id: 'RVL', name: 'Ravine Langevin', zone: 'Pentes S' },
  { id: 'RER', name: 'Rempart Est',     zone: 'Pentes E / Grand Brûlé' },
  { id: 'BEB', name: 'Basse Estelle',   zone: 'Pentes E / Grand Brûlé' },
  { id: 'HDL', name: 'Hauts-de-Ligne',  zone: 'Hors enclos' },
  { id: 'MAT', name: 'Matouta',         zone: 'Hors enclos' },
  { id: 'PJR', name: 'Piton Jacquot',   zone: 'Hors enclos' },
];

// niveau backend → état lisible du trémor (distinct de la crise sismique).
const TREMOR_STATE = {
  calme:     { label: 'AU REPOS',    cls: 'level-calme' },
  vigilance: { label: 'EN RÉVEIL',   cls: 'level-vigilance' },
  crise:     { label: 'EN CRISE',    cls: 'level-crise' },
  eruption:  { label: 'EN ÉRUPTION', cls: 'level-eruption' },
};

function fmtNum(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  if (a >= 10) return v.toFixed(0);
  if (a >= 1) return v.toFixed(1);
  return v.toFixed(2);
}

class VolcanApp {
  constructor() {
    this.state = {
      page: 'accueil',
      theme: localStorage.getItem('volcan-theme') || 'dark',
      stations: FALLBACK_STATIONS.slice(),
      accueilStation: 'BOR',
      accueilWebcamIndex: 0,
      tremorHours: 6,
      signalMinutes: 10,
      selectedStations: new Set(['BOR', 'FOR', 'RER']),
      webcamBase: '',
      webcams: [],
      immersion: false,
      immersionBg: 'tremor',
      crisisText: '…',
      crisisLevel: 'vigilance',
    };
    this.refreshTimer = null;
    this.init();
  }

  init() {
    document.documentElement.className = this.state.theme;
    this.syncThemeButton();
    this.attachEventListeners();
    this.populateStationSelect();
    this.renderAllChips();
    this.switchPage('accueil');
    this.loadStations(); // enrichit la liste depuis RESIF (asynchrone)
  }

  /* ─── Réseau ─────────────────────────────────────────── */
  async api(path) {
    const res = await fetch(API_BASE + path, { mode: 'cors' });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error || ''; } catch (_) {}
      throw new Error(detail || `HTTP ${res.status}`);
    }
    return res.json();
  }

  async runPool(items, limit, worker) {
    const queue = items.slice();
    const runners = [];
    for (let i = 0; i < Math.min(limit, queue.length); i++) {
      runners.push((async () => { while (queue.length) await worker(queue.shift()); })());
    }
    await Promise.all(runners);
  }

  async loadStations() {
    try {
      const data = await this.api('/stations');
      if (data.stations && data.stations.length) {
        this.state.stations = data.stations;
        // garde la sélection valide
        const ids = new Set(data.stations.map(s => s.id));
        const kept = [...this.state.selectedStations].filter(id => ids.has(id));
        if (!kept.length) {
          this.state.selectedStations = new Set(data.stations.slice(0, 3).map(s => s.id));
        } else {
          this.state.selectedStations = new Set(kept);
        }
        this.populateStationSelect();
        this.renderAllChips();
        if (this.state.page === 'tremor') this.loadTremor();
        if (this.state.page === 'signal') this.loadSignal();
      }
    } catch (_) { /* on garde la liste de repli */ }
  }

  zonesInOrder() {
    const present = [...new Set(this.state.stations.map(s => s.zone))];
    const ordered = ZONE_PREF.filter(z => present.includes(z));
    const extra = present.filter(z => !ZONE_PREF.includes(z)).sort();
    return [...ordered, ...extra];
  }

  setStatus(state, text) {
    document.getElementById('status-dot').className = 'status-dot ' + state;
    document.getElementById('status-text').textContent = text;
  }

  /* ─── Événements UI ──────────────────────────────────── */
  attachEventListeners() {
    document.querySelectorAll('.nav-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        this.switchPage(link.dataset.nav);
      });
    });

    document.getElementById('theme-toggle').addEventListener('click', () => this.toggleTheme());
    document.getElementById('webcams-refresh').addEventListener('click', () => this.loadWebcams(true));
    document.getElementById('tremor-refresh').addEventListener('click', () => this.loadTremor());
    document.getElementById('signal-refresh').addEventListener('click', () => this.loadSignal());

    // Fenêtre trémor (heures)
    document.querySelectorAll('.time-btn[data-hours]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.time-btn[data-hours]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.state.tremorHours = parseInt(btn.dataset.hours, 10);
        this.loadTremor();
      });
    });

    // Fenêtre signal (minutes)
    document.querySelectorAll('.time-btn[data-minutes]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.time-btn[data-minutes]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.state.signalMinutes = parseInt(btn.dataset.minutes, 10);
        this.loadSignal();
      });
    });

    // Personnaliser l'accueil
    document.getElementById('accueil-webcam-select').addEventListener('change', (e) => {
      this.state.accueilWebcamIndex = parseInt(e.target.value, 10);
      this.renderAccueilWebcam();
    });
    document.getElementById('accueil-station-select').addEventListener('change', (e) => {
      this.state.accueilStation = e.target.value;
      document.getElementById('accueil-station-label').textContent = 'PF.' + e.target.value;
      this.loadAccueilTremor(e.target.value);
    });

    // Immersion
    document.getElementById('enter-immersion').addEventListener('click', () => this.enterImmersion());
    document.getElementById('exit-immersion').addEventListener('click', () => this.exitImmersion());
    document.getElementById('swap-bg').addEventListener('click', () => this.swapImmersionBg());
    document.querySelector('.widget-header').addEventListener('pointerdown', (e) => this.startWidgetDrag(e));

    // Modal webcam (pop-up intégré)
    document.addEventListener('click', (e) => {
      const trigger = e.target.closest('[data-cam]');
      if (trigger) this.openWebcamModal(parseInt(trigger.dataset.cam, 10));
    });
    document.getElementById('webcam-modal-close').addEventListener('click', () => this.closeWebcamModal());
    document.getElementById('webcam-modal-backdrop').addEventListener('click', () => this.closeWebcamModal());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeWebcamModal(); });
  }

  toggleTheme() {
    this.state.theme = this.state.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('volcan-theme', this.state.theme);
    document.documentElement.className = this.state.theme;
    this.syncThemeButton();
  }

  syncThemeButton() {
    document.getElementById('theme-toggle').textContent =
      this.state.theme === 'light' ? '☾ Sombre' : '☀ Clair';
  }

  switchPage(page) {
    if (this.state.immersion) this.exitImmersion();
    this.state.page = page;
    document.querySelectorAll('.page-content').forEach(p => p.classList.remove('active'));
    document.getElementById(`page-${page}`).classList.add('active');
    document.querySelectorAll('.nav-link')
      .forEach(link => link.classList.toggle('active', link.dataset.nav === page));

    if (this.refreshTimer) clearInterval(this.refreshTimer);
    const map = {
      accueil: () => this.loadAccueil(),
      webcams: () => this.loadWebcams(true),
      tremor: () => this.loadTremor(),
      signal: () => this.loadSignal(),
    };
    if (map[page]) {
      map[page]();
      this.refreshTimer = setInterval(map[page], REFRESH_MS);
    }
  }

  /* ─── Page ACCUEIL ───────────────────────────────────── */
  async loadAccueil() {
    this.setStatus('loading', 'Mise à jour…');
    document.getElementById('accueil-station-label').textContent = 'PF.' + this.state.accueilStation;
    this.loadCrisisRibbon();
    this.loadAccueilWebcam();
    this.loadAccueilTremor(this.state.accueilStation);
  }

  async loadCrisisRibbon() {
    try {
      const [crise, bulletin, seismes] = await Promise.allSettled([
        this.api('/crise?window=3&seuil=15'),
        this.api('/bulletin'),
        this.api('/seismes?hours=24'),
      ]);

      let niveau = null;
      if (bulletin.status === 'fulfilled' && bulletin.value.niveau_alerte) niveau = bulletin.value.niveau_alerte;
      else if (crise.status === 'fulfilled' && crise.value.niveau_alerte_ovpf) niveau = crise.value.niveau_alerte_ovpf;

      const crise_probable = crise.status === 'fulfilled' && crise.value.crise_probable;
      this.state.crisisText = crise_probable ? 'CRISE PROBABLE' : (niveau || 'VIGILANCE');
      this.state.crisisLevel = crise_probable ? 'crise' : 'vigilance';
      document.getElementById('crisis-value').textContent = this.state.crisisText;
      document.getElementById('crisis-dot').className = 'crisis-dot level-' + this.state.crisisLevel;

      if (seismes.status === 'fulfilled') {
        document.getElementById('stat-sommitaux').textContent = seismes.value.counts?.sommital ?? 0;
        document.getElementById('stat-profonds').textContent = seismes.value.counts?.profond ?? 0;
      }
      if (bulletin.status === 'fulfilled') {
        document.getElementById('stat-eboulements').textContent = bulletin.value.eboulements?.total ?? '—';
        document.getElementById('stat-ovpf').textContent = bulletin.value.niveau_alerte || '—';
      }
    } catch (err) {
      document.getElementById('crisis-value').textContent = 'INDISPONIBLE';
    }
  }

  async loadAccueilTremor(station) {
    const host = document.getElementById('accueil-tremor-chart');
    const stateEl = document.getElementById('accueil-tremor-state');
    try {
      const tr = await this.api(`/tremor?station=${station}&hours=${this.state.tremorHours}`);
      host.innerHTML = this.buildTremorChart(tr);
      stateEl.innerHTML = this.tremorStateHtml(tr);
      this.setStatus('ok', 'En direct · ' + new Date().toLocaleTimeString('fr-FR'));
    } catch (err) {
      host.innerHTML = `<div class="chart-empty">Trémor indisponible (${err.message})</div>`;
      stateEl.textContent = '';
      this.setStatus('error', 'Serveur injoignable');
    }
  }

  tremorStateHtml(tr) {
    const lv = tr.levels || {};
    const st = TREMOR_STATE[lv.niveau] || { label: '—', cls: '' };
    const cur = lv.courant != null ? `${fmtNum(lv.courant)} counts` : '';
    const ratio = (lv.courant != null && lv.baseline) ? ` · ×${(lv.courant / lv.baseline).toFixed(1)} base` : '';
    return `<span class="state-badge ${st.cls}">${st.label}</span>
            <span class="state-detail">${cur}${ratio}</span>`;
  }

  /* ─── Sélecteurs « personnaliser » ───────────────────── */
  populateStationSelect() {
    const sel = document.getElementById('accueil-station-select');
    sel.innerHTML = this.zonesInOrder().map(zone => {
      const opts = this.state.stations.filter(s => s.zone === zone)
        .map(s => `<option value="${s.id}">PF.${s.id} · ${s.name}</option>`).join('');
      return opts ? `<optgroup label="${zone}">${opts}</optgroup>` : '';
    }).join('');
    if (this.state.stations.some(s => s.id === this.state.accueilStation)) {
      sel.value = this.state.accueilStation;
    } else if (this.state.stations[0]) {
      this.state.accueilStation = this.state.stations[0].id;
      sel.value = this.state.accueilStation;
    }
  }

  populateWebcamSelect() {
    const sel = document.getElementById('accueil-webcam-select');
    if (sel.options.length === this.state.webcams.length && sel.options.length) return;
    sel.innerHTML = this.state.webcams.map((c, i) => `<option value="${i}">${c.label}</option>`).join('');
    sel.value = this.state.accueilWebcamIndex;
  }

  /* ─── Webcams ────────────────────────────────────────── */
  async fetchWebcams() {
    const data = await this.api('/webcams');
    this.state.webcamBase = data.base;
    this.state.webcams = data.cams || [];
    return this.state.webcams;
  }

  camUrl(cam) { return this.state.webcamBase + cam.file + '?_=' + Date.now(); }

  webcamImgHtml(cam, index) {
    return `
      <img class="webcam-img" src="${this.camUrl(cam)}" alt="${cam.label}" data-cam="${index}"
           onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
      <span class="webcam-placeholder" style="display:none">Image indisponible</span>
      <span class="webcam-timestamp">MAJ ${new Date().toLocaleTimeString('fr-FR')}</span>
    `;
  }

  async loadAccueilWebcam() {
    try {
      if (!this.state.webcams.length) await this.fetchWebcams();
      this.populateWebcamSelect();
      this.renderAccueilWebcam();
    } catch (_) {
      document.getElementById('accueil-webcam').innerHTML =
        '<span class="webcam-placeholder">Webcam indisponible</span>';
    }
  }

  renderAccueilWebcam() {
    const idx = this.state.accueilWebcamIndex;
    const cam = this.state.webcams[idx];
    if (!cam) return;
    document.getElementById('accueil-webcam-name').textContent = cam.label;
    document.getElementById('accueil-webcam').innerHTML = this.webcamImgHtml(cam, idx);
  }

  async loadWebcams(force = false) {
    const grid = document.getElementById('webcams-grid');
    try {
      if (force || !this.state.webcams.length) await this.fetchWebcams();
      this.setStatus('ok', 'En direct · ' + new Date().toLocaleTimeString('fr-FR'));
      grid.innerHTML = this.state.webcams.map((cam, i) => `
        <div class="webcam-card">
          ${this.webcamImgHtml(cam, i)}
          <div class="webcam-card-footer">
            <span class="webcam-card-name">${cam.label}</span>
            <span class="webcam-card-credit">© OVPF-IPGP</span>
          </div>
        </div>
      `).join('');
    } catch (err) {
      this.setStatus('error', 'Serveur injoignable');
      grid.innerHTML = `<div class="empty-msg">Webcams indisponibles — ${err.message}</div>`;
    }
  }

  /* ─── Modal webcam ───────────────────────────────────── */
  openWebcamModal(index) {
    const cam = this.state.webcams[index];
    if (!cam) return;
    document.getElementById('webcam-modal-title').textContent = cam.label;
    const img = document.getElementById('webcam-modal-img');
    img.src = this.camUrl(cam);
    img.alt = cam.label;
    document.getElementById('webcam-modal').classList.remove('hidden');
  }

  closeWebcamModal() { document.getElementById('webcam-modal').classList.add('hidden'); }

  /* ─── Mode immersion ─────────────────────────────────── */
  enterImmersion() {
    this.state.immersion = true;
    this.state.immersionBg = 'tremor';
    document.getElementById('accueil-normal').style.display = 'none';
    document.getElementById('accueil-immersion').classList.remove('hidden');
    const cont = document.getElementById('accueil-immersion');
    const widget = document.getElementById('immersion-widget');
    widget.style.left = Math.max(20, cont.clientWidth - 360) + 'px';
    widget.style.top = '70px';
    this.renderImmersion();
  }

  exitImmersion() {
    this.state.immersion = false;
    document.getElementById('accueil-normal').style.display = '';
    document.getElementById('accueil-immersion').classList.add('hidden');
  }

  swapImmersionBg() {
    this.state.immersionBg = this.state.immersionBg === 'tremor' ? 'webcam' : 'tremor';
    this.renderImmersion();
  }

  async renderImmersion() {
    const station = this.state.accueilStation;
    const idx = this.state.accueilWebcamIndex;
    const cam = this.state.webcams[idx];
    const bg = document.getElementById('immersion-bg');
    const bgLabel = document.getElementById('immersion-bg-label');
    const bgImg = document.getElementById('immersion-bg-img');
    const waveSvg = bg.querySelector('svg');
    const widget = document.getElementById('widget-content');

    document.getElementById('immersion-selector').textContent = 'PF.' + station;
    document.getElementById('immersion-crisis-label').textContent = this.state.crisisText || 'VIGILANCE';
    document.getElementById('immersion-crisis-dot').className =
      'crisis-dot-small level-' + (this.state.crisisLevel || 'vigilance');

    const fetchRms = () => this.api(`/tremor?station=${station}&hours=${this.state.tremorHours}`)
      .then(tr => tr.rms).catch(() => null);

    if (this.state.immersionBg === 'tremor') {
      bg.classList.remove('webcam-bg');
      bgLabel.textContent = 'FOND · TRÉMOR';
      bgImg.style.display = 'none';
      waveSvg.style.display = '';
      document.getElementById('widget-title').textContent = 'Webcam';
      widget.innerHTML = cam
        ? `<div class="widget-webcam">${this.webcamImgHtml(cam, idx)}</div>`
        : '<div class="widget-webcam"><span class="webcam-placeholder">Webcam indispo</span></div>';
      const rms = await fetchRms();
      if (rms) this.drawLine(waveSvg, rms, 'var(--accent)'); else this.drawError(waveSvg);
    } else {
      bg.classList.add('webcam-bg');
      bgLabel.textContent = 'FOND · WEBCAM';
      waveSvg.style.display = 'none';
      if (cam) { bgImg.src = this.camUrl(cam); bgImg.style.display = 'block'; }
      document.getElementById('widget-title').textContent = 'PF.' + station;
      widget.innerHTML =
        '<div class="widget-tremor"><div class="widget-tremor-label">TRÉMOR (RSAM)</div>' +
        '<svg class="widget-chart" viewBox="0 0 600 120" preserveAspectRatio="none"></svg></div>';
      const rms = await fetchRms();
      const svg = widget.querySelector('svg');
      if (rms) this.drawLine(svg, rms, 'var(--accent)'); else this.drawError(svg);
    }
  }

  startWidgetDrag(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const widget = document.getElementById('immersion-widget');
    const startX = e.clientX, startY = e.clientY;
    const curX = parseFloat(widget.style.left) || 60;
    const curY = parseFloat(widget.style.top) || 60;
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

  /* ─── Sélecteur de stations (Trémor + Signal) ────────── */
  renderAllChips() {
    this.renderChips('tremor-chips');
    this.renderChips('signal-chips');
  }

  renderChips(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = this.zonesInOrder().map(zone => {
      const sts = this.state.stations.filter(s => s.zone === zone);
      if (!sts.length) return '';
      const chips = sts.map(s => {
        const active = this.state.selectedStations.has(s.id);
        return `<button class="station-chip ${active ? 'active' : ''}" data-station="${s.id}">${s.id}</button>`;
      }).join('');
      return `<div class="chip-zone-group">
        <span class="chip-zone-label">${zone}</span>
        <div class="chip-zone-row">${chips}</div>
      </div>`;
    }).join('');

    container.querySelectorAll('.station-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const id = chip.dataset.station;
        if (this.state.selectedStations.has(id)) this.state.selectedStations.delete(id);
        else this.state.selectedStations.add(id);
        this.renderAllChips();
        if (this.state.page === 'tremor') this.loadTremor();
        if (this.state.page === 'signal') this.loadSignal();
      });
    });
  }

  selectedList() {
    return this.state.stations.filter(s => this.state.selectedStations.has(s.id));
  }

  zoneSkeleton(listId, selected, prefix) {
    const container = document.getElementById(listId);
    container.innerHTML = this.zonesInOrder().map(zone => {
      const sts = selected.filter(s => s.zone === zone);
      if (!sts.length) return '';
      const cards = sts.map(st => `
        <div class="station-card" id="${prefix}card-${st.id}">
          <div class="station-card-header">
            <div class="station-info">
              <span class="station-id">PF.${st.id}</span>
              <span class="station-name">${st.name}</span>
            </div>
            <span class="station-time" id="${prefix}meta-${st.id}">chargement…</span>
          </div>
          <div class="chart-host" id="${prefix}chart-${st.id}">
            <span class="webcam-placeholder">Chargement…</span>
          </div>
        </div>`).join('');
      return `<section class="zone-section">
        <h3 class="zone-heading">${zone} <span class="zone-count">${sts.length}</span></h3>
        ${cards}
      </section>`;
    }).join('');
  }

  /* ─── Page TRÉMOR ────────────────────────────────────── */
  async loadTremor() {
    const selected = this.selectedList();
    if (!selected.length) {
      document.getElementById('tremor-list').innerHTML =
        '<div class="empty-msg">Sélectionnez au moins une station.</div>';
      this.setStatus('ok', 'Prêt');
      return;
    }
    this.setStatus('loading', 'Mise à jour…');
    this.zoneSkeleton('tremor-list', selected, 't');

    const hours = this.state.tremorHours;
    let loaded = 0;
    await this.runPool(selected, FETCH_CONCURRENCY, async (st) => {
      const host = document.getElementById(`tchart-${st.id}`);
      const meta = document.getElementById(`tmeta-${st.id}`);
      if (!host) return;
      try {
        const tr = await this.api(`/tremor?station=${st.id}&hours=${hours}`);
        host.innerHTML = this.buildTremorChart(tr);
        meta.innerHTML = this.tremorStateHtml(tr);
        loaded++;
      } catch (err) {
        host.innerHTML = '<div class="chart-empty">pas de données</div>';
        meta.textContent = '—';
      }
    });
    this.reportLoaded(loaded, selected.length);
  }

  /* ─── Page SIGNAL BRUT ───────────────────────────────── */
  async loadSignal() {
    const selected = this.selectedList();
    if (!selected.length) {
      document.getElementById('signal-list').innerHTML =
        '<div class="empty-msg">Sélectionnez au moins une station.</div>';
      this.setStatus('ok', 'Prêt');
      return;
    }
    this.setStatus('loading', 'Mise à jour…');
    this.zoneSkeleton('signal-list', selected, 's');

    const minutes = this.state.signalMinutes;
    let loaded = 0;
    await this.runPool(selected, FETCH_CONCURRENCY, async (st) => {
      const host = document.getElementById(`schart-${st.id}`);
      const meta = document.getElementById(`smeta-${st.id}`);
      if (!host) return;
      try {
        const sig = await this.api(`/signal?station=${st.id}&minutes=${minutes}`);
        host.innerHTML = this.buildSignalChart(sig);
        meta.textContent = `${sig.channel} · ${minutes} min · ${Math.round(sig.sampling_rate)} Hz`;
        loaded++;
      } catch (err) {
        host.innerHTML = '<div class="chart-empty">pas de données</div>';
        meta.textContent = 'pas de données';
      }
    });
    this.reportLoaded(loaded, selected.length);
  }

  reportLoaded(loaded, total) {
    const time = new Date().toLocaleTimeString('fr-FR');
    if (loaded === total) this.setStatus('ok', `En direct · ${time}`);
    else if (loaded > 0) this.setStatus('ok', `En direct · ${loaded}/${total} stations · ${time}`);
    else this.setStatus('error', 'Aucune donnée — serveur injoignable');
  }

  /* ─── Graphiques avec axes ───────────────────────────── */
  z(iso) { return /[zZ]$|[+\-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z'; }

  buildTremorChart(tr) {
    const rms = tr.rms || [];
    const times = tr.t || [];
    const lv = tr.levels || {};
    const base = lv.baseline || 0;
    const thresholds = [];
    if (base > 0) {
      thresholds.push({ v: base * 1.5, label: 'réveil', color: 'var(--crisis)' });
      thresholds.push({ v: base * 3,   label: 'crise',  color: 'var(--crisis-red)' });
      thresholds.push({ v: base * 10,  label: 'éruption', color: '#b30000' });
    }
    const maxData = rms.length ? Math.max(...rms) : 1;
    const yTo = Math.max(maxData, base * 3) * 1.15 || 1;
    return this.buildAxedChart({
      values: rms,
      yFrom: 0, yTo,
      thresholds,
      unit: 'counts',
      color: 'var(--accent)',
      xLabel: (i) => {
        const d = new Date(this.z(times[i] || ''));
        return isNaN(d) ? '' : d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      },
    });
  }

  buildSignalChart(sig) {
    const v = sig.v || [];
    const t = sig.t || [];
    const base = sig.start ? Date.parse(this.z(sig.start)) : 0;
    return this.buildAxedChart({
      values: v,
      unit: 'counts',
      color: 'var(--accent)',
      xLabel: (i) => {
        if (!base) return '';
        const d = new Date(base + (t[i] || 0) * 1000);
        return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      },
    });
  }

  buildAxedChart(o) {
    const W = 840, H = 300, L = 66, R = 72, T = 16, B = 36;
    const x0 = L, x1 = W - R, y0 = T, y1 = H - B;
    const vals = o.values || [];
    if (!vals.length) {
      return `<svg class="axed-chart" viewBox="0 0 ${W} ${H}"><text x="${W / 2}" y="${H / 2}" ` +
        `text-anchor="middle" fill="currentColor" opacity="0.45" font-size="15" ` +
        `font-family="monospace">données indisponibles</text></svg>`;
    }

    let lo = o.yFrom, hi = o.yTo;
    if (lo == null || hi == null) {
      let mn = Infinity, mx = -Infinity;
      for (const x of vals) { if (x < mn) mn = x; if (x > mx) mx = x; }
      for (const th of (o.thresholds || [])) { if (th.v > mx) mx = th.v; }
      if (mn === mx) { mn -= 1; mx += 1; }
      const pad = (mx - mn) * 0.08;
      if (lo == null) lo = mn - pad;
      if (hi == null) hi = mx + pad;
    }
    const span = (hi - lo) || 1;
    const X = (i) => x0 + (i / ((vals.length - 1) || 1)) * (x1 - x0);
    const Y = (val) => y1 - ((val - lo) / span) * (y1 - y0);

    let s = `<svg class="axed-chart" viewBox="0 0 ${W} ${H}" role="img">`;
    // grille + ticks Y
    const TY = 4;
    for (let k = 0; k <= TY; k++) {
      const val = lo + span * (k / TY);
      const y = Y(val);
      s += `<line x1="${x0}" y1="${y.toFixed(1)}" x2="${x1}" y2="${y.toFixed(1)}" ` +
        `stroke="var(--line)" stroke-width="0.6" opacity="0.5"/>`;
      s += `<text x="${x0 - 7}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" fill="var(--muted)" ` +
        `font-size="11" font-family="monospace">${fmtNum(val)}</text>`;
    }
    s += `<text x="${x0 - 7}" y="${y0 - 4}" text-anchor="end" fill="var(--muted)" ` +
      `font-size="10" font-family="monospace">${o.unit || ''}</text>`;
    // axes
    s += `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y1}" stroke="var(--line2)" stroke-width="1"/>`;
    s += `<line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y1}" stroke="var(--line2)" stroke-width="1"/>`;
    // seuils
    for (const th of (o.thresholds || [])) {
      if (th.v < lo || th.v > hi) continue;
      const y = Y(th.v);
      s += `<line x1="${x0}" y1="${y.toFixed(1)}" x2="${x1}" y2="${y.toFixed(1)}" stroke="${th.color}" ` +
        `stroke-width="1.1" stroke-dasharray="5 4" opacity="0.9"/>`;
      s += `<text x="${x1 + 5}" y="${(y + 3.5).toFixed(1)}" fill="${th.color}" ` +
        `font-size="10.5" font-family="monospace">${th.label}</text>`;
    }
    // ticks X
    const TX = Math.min(5, vals.length - 1) || 1;
    for (let k = 0; k <= TX; k++) {
      const i = Math.round((vals.length - 1) * (k / TX));
      const x = X(i);
      s += `<line x1="${x.toFixed(1)}" y1="${y1}" x2="${x.toFixed(1)}" y2="${y1 + 4}" ` +
        `stroke="var(--line2)" stroke-width="1"/>`;
      s += `<text x="${x.toFixed(1)}" y="${y1 + 18}" text-anchor="middle" fill="var(--muted)" ` +
        `font-size="10.5" font-family="monospace">${o.xLabel ? o.xLabel(i) : i}</text>`;
    }
    // données
    let pts = '';
    for (let i = 0; i < vals.length; i++) pts += `${X(i).toFixed(1)},${Y(vals[i]).toFixed(1)} `;
    s += `<polyline points="${pts.trim()}" fill="none" stroke="${o.color || 'var(--accent)'}" ` +
      `stroke-width="1.3" stroke-linejoin="round"/>`;
    s += `</svg>`;
    return s;
  }

  /* ─── Dessin simple (immersion) ──────────────────────── */
  drawLine(svg, values, color, opacity = 1) {
    const W = 600, H = 120, pad = 6;
    svg.innerHTML = '';
    if (!values || !values.length) return this.drawError(svg);
    let min = Infinity, max = -Infinity;
    for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
    if (min === max) { min -= 1; max += 1; }
    const n = values.length, denom = max - min, span = n > 1 ? n - 1 : 1;
    const pts = new Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / span) * W;
      const y = H - pad - ((values[i] - min) / denom) * (H - 2 * pad);
      pts[i] = x.toFixed(1) + ',' + y.toFixed(1);
    }
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', pts.join(' '));
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', color);
    poly.setAttribute('stroke-width', '1.4');
    poly.setAttribute('stroke-linejoin', 'round');
    if (opacity < 1) poly.setAttribute('opacity', opacity);
    svg.appendChild(poly);
  }

  drawError(svg) {
    svg.innerHTML =
      '<text x="300" y="64" text-anchor="middle" fill="currentColor" ' +
      'opacity="0.45" font-size="13" font-family="monospace">données indisponibles</text>';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.app = new VolcanApp();
});
