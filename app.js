/* ──────────────────────────────────────────────────────────────
   Piton de la Fournaise — Tableau de bord trémor (lo-fi)
   Toutes les données viennent du backend Flask (app.py) :
     /tremor /signal /seismes /bulletin /webcams /crise
   Source réelle : RESIF FDSN + OVPF-IPGP.
────────────────────────────────────────────────────────────── */

const API_BASE = 'https://volcan-backend-gnem.onrender.com';
const REFRESH_MS = 60_000;
const FETCH_CONCURRENCY = 3; // limite les requêtes simultanées (backend free tier)

// Ordre d'affichage des zones du réseau PF.
const ZONE_ORDER = ['Enclos Fouqué', 'Pentes N', 'Pentes S', 'Grand Brûlé', 'Hors enclos'];

// Stations PF (page Courbes + sélecteur d'accueil), groupées par zone.
const STATIONS = [
  { id: 'BOR', name: 'Bory',            zone: 'Enclos Fouqué' },
  { id: 'FEU', name: 'Feu',             zone: 'Enclos Fouqué' },
  { id: 'CSS', name: 'Cassé Sud',       zone: 'Enclos Fouqué' },
  { id: 'FOR', name: 'Formica Leo',     zone: 'Enclos Fouqué' },
  { id: 'FER', name: 'Ferret',          zone: 'Enclos Fouqué' },
  { id: 'NSR', name: 'Nez Scié',        zone: 'Pentes N' },
  { id: 'SNE', name: 'Sainte-Rose NE',  zone: 'Pentes N' },
  { id: 'PER', name: 'Père',            zone: 'Pentes S' },
  { id: 'RVP', name: 'Ravine Plate',    zone: 'Pentes S' },
  { id: 'RVL', name: 'Ravine Langevin', zone: 'Pentes S' },
  { id: 'RER', name: 'Rempart Est',     zone: 'Grand Brûlé' },
  { id: 'BEB', name: 'Basse Estelle',   zone: 'Grand Brûlé' },
  { id: 'HDL', name: 'Hauts-de-Ligne',  zone: 'Hors enclos' },
  { id: 'MAT', name: 'Matouta',         zone: 'Hors enclos' },
  { id: 'PJR', name: 'Piton Jacquot',   zone: 'Hors enclos' },
];

const LEVEL_LABELS = {
  calme: 'CALME',
  vigilance: 'VIGILANCE',
  crise: 'CRISE',
  eruption: 'ÉRUPTION',
};

class VolcanApp {
  constructor() {
    this.state = {
      page: 'accueil',
      theme: localStorage.getItem('volcan-theme') || 'dark',
      accueilStation: 'BOR',
      accueilWebcamIndex: 0,
      courbesMinutes: 10,
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
    this.renderStationChips();
    this.switchPage('accueil');
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

  // Exécute `worker` sur chaque item avec au plus `limit` tâches en parallèle.
  async runPool(items, limit, worker) {
    const queue = items.slice();
    const runners = [];
    for (let i = 0; i < Math.min(limit, queue.length); i++) {
      runners.push((async () => {
        while (queue.length) await worker(queue.shift());
      })());
    }
    await Promise.all(runners);
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

    document.getElementById('theme-toggle')
      .addEventListener('click', () => this.toggleTheme());

    document.getElementById('webcams-refresh')
      .addEventListener('click', () => this.loadWebcams(true));

    document.getElementById('courbes-refresh')
      .addEventListener('click', () => this.loadCourbes());

    document.querySelectorAll('.time-btn[data-minutes]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.time-btn[data-minutes]')
          .forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.state.courbesMinutes = parseInt(btn.dataset.minutes, 10);
        this.loadCourbes();
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
      this.loadAccueilCharts(e.target.value);
    });

    // Immersion
    document.getElementById('enter-immersion').addEventListener('click', () => this.enterImmersion());
    document.getElementById('exit-immersion').addEventListener('click', () => this.exitImmersion());
    document.getElementById('swap-bg').addEventListener('click', () => this.swapImmersionBg());
    document.querySelector('.widget-header').addEventListener('pointerdown', (e) => this.startWidgetDrag(e));

    // Modal webcam : clic sur une image (accueil + grille) → pop-up
    document.addEventListener('click', (e) => {
      const trigger = e.target.closest('[data-cam]');
      if (trigger) this.openWebcamModal(parseInt(trigger.dataset.cam, 10));
    });
    document.getElementById('webcam-modal-close').addEventListener('click', () => this.closeWebcamModal());
    document.getElementById('webcam-modal-backdrop').addEventListener('click', () => this.closeWebcamModal());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeWebcamModal();
    });
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
    document.querySelectorAll('.page-content')
      .forEach(p => p.classList.remove('active'));
    document.getElementById(`page-${page}`).classList.add('active');
    document.querySelectorAll('.nav-link')
      .forEach(link => link.classList.toggle('active', link.dataset.nav === page));

    if (this.refreshTimer) clearInterval(this.refreshTimer);

    if (page === 'accueil') {
      this.loadAccueil();
      this.refreshTimer = setInterval(() => this.loadAccueil(), REFRESH_MS);
    } else if (page === 'webcams') {
      this.loadWebcams();
      this.refreshTimer = setInterval(() => this.loadWebcams(true), REFRESH_MS);
    } else if (page === 'courbes') {
      this.loadCourbes();
      this.refreshTimer = setInterval(() => this.loadCourbes(), REFRESH_MS);
    }
  }

  /* ─── Page ACCUEIL ───────────────────────────────────── */
  async loadAccueil() {
    this.setStatus('loading', 'Mise à jour…');
    const station = this.state.accueilStation;
    document.getElementById('accueil-station-label').textContent = 'PF.' + station;

    this.loadCrisisRibbon();
    this.loadAccueilWebcam();
    this.loadAccueilCharts(station);
  }

  async loadCrisisRibbon() {
    try {
      const [crise, bulletin, seismes] = await Promise.allSettled([
        this.api('/crise?window=3&seuil=15'),
        this.api('/bulletin'),
        this.api('/seismes?hours=24'),
      ]);

      const crisisVal = document.getElementById('crisis-value');
      const crisisDot = document.getElementById('crisis-dot');

      let niveau = null;
      if (bulletin.status === 'fulfilled' && bulletin.value.niveau_alerte) {
        niveau = bulletin.value.niveau_alerte;
      } else if (crise.status === 'fulfilled' && crise.value.niveau_alerte_ovpf) {
        niveau = crise.value.niveau_alerte_ovpf;
      }

      const crise_probable = crise.status === 'fulfilled' && crise.value.crise_probable;
      this.state.crisisText = crise_probable ? 'CRISE PROBABLE' : (niveau || 'VIGILANCE');
      this.state.crisisLevel = crise_probable ? 'crise' : 'vigilance';
      crisisVal.textContent = this.state.crisisText;
      crisisDot.className = 'crisis-dot level-' + this.state.crisisLevel;

      if (seismes.status === 'fulfilled') {
        document.getElementById('stat-sommitaux').textContent = seismes.value.counts?.sommital ?? 0;
        document.getElementById('stat-profonds').textContent = seismes.value.counts?.profond ?? 0;
      }
      if (bulletin.status === 'fulfilled') {
        document.getElementById('stat-eboulements').textContent =
          bulletin.value.eboulements?.total ?? '—';
        document.getElementById('stat-ovpf').textContent =
          bulletin.value.niveau_alerte || '—';
      }
    } catch (err) {
      document.getElementById('crisis-value').textContent = 'INDISPONIBLE';
    }
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

  async loadAccueilCharts(station) {
    const waveSvg = document.querySelector('.waveform-chart');
    const rsamSvg = document.querySelector('.rsam-chart');

    try {
      const sig = await this.api(`/signal?station=${station}&minutes=10`);
      this.drawLine(waveSvg, sig.v, 'var(--accent)');
      document.getElementById('accueil-signal-meta').textContent =
        `${sig.channel} · ${Math.round(sig.sampling_rate)} Hz`;
    } catch (err) {
      this.drawError(waveSvg);
      document.getElementById('accueil-signal-meta').textContent = '· indisponible';
    }

    try {
      const tr = await this.api(`/tremor?station=${station}&hours=6`);
      this.drawLine(rsamSvg, tr.rms, 'var(--ink)', 0.55);
      const niveau = tr.levels?.niveau;
      const lvlEl = document.getElementById('accueil-tremor-level');
      lvlEl.textContent = LEVEL_LABELS[niveau] || '—';
      lvlEl.className = 'time-selector level-' + (niveau || 'calme');
      document.getElementById('accueil-rsam-meta').textContent =
        tr.levels ? `· ${tr.levels.courant} (base ${tr.levels.baseline})` : '';
      this.setStatus('ok', 'En direct · ' + new Date().toLocaleTimeString('fr-FR'));
    } catch (err) {
      this.drawError(rsamSvg);
      document.getElementById('accueil-rsam-meta').textContent = '· indisponible';
      this.setStatus('error', 'Serveur injoignable');
    }
  }

  /* ─── Sélecteurs « personnaliser » ───────────────────── */
  populateStationSelect() {
    const sel = document.getElementById('accueil-station-select');
    sel.innerHTML = ZONE_ORDER.map(zone => {
      const opts = STATIONS.filter(s => s.zone === zone)
        .map(s => `<option value="${s.id}">PF.${s.id} · ${s.name}</option>`).join('');
      return `<optgroup label="${zone}">${opts}</optgroup>`;
    }).join('');
    sel.value = this.state.accueilStation;
  }

  populateWebcamSelect() {
    const sel = document.getElementById('accueil-webcam-select');
    if (sel.options.length === this.state.webcams.length && sel.options.length) return;
    sel.innerHTML = this.state.webcams
      .map((c, i) => `<option value="${i}">${c.label}</option>`).join('');
    sel.value = this.state.accueilWebcamIndex;
  }

  /* ─── Webcams ────────────────────────────────────────── */
  async fetchWebcams() {
    const data = await this.api('/webcams');
    this.state.webcamBase = data.base;
    this.state.webcams = data.cams || [];
    return this.state.webcams;
  }

  camUrl(cam) {
    return this.state.webcamBase + cam.file + '?_=' + Date.now();
  }

  webcamImgHtml(cam, index) {
    return `
      <img class="webcam-img" src="${this.camUrl(cam)}" alt="${cam.label}" data-cam="${index}"
           onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
      <span class="webcam-placeholder" style="display:none">Image indisponible</span>
      <span class="webcam-timestamp">MAJ ${new Date().toLocaleTimeString('fr-FR')}</span>
    `;
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

  /* ─── Modal webcam (pop-up intégré) ──────────────────── */
  openWebcamModal(index) {
    const cam = this.state.webcams[index];
    if (!cam) return;
    document.getElementById('webcam-modal-title').textContent = cam.label;
    const img = document.getElementById('webcam-modal-img');
    img.src = this.camUrl(cam);
    img.alt = cam.label;
    document.getElementById('webcam-modal').classList.remove('hidden');
  }

  closeWebcamModal() {
    document.getElementById('webcam-modal').classList.add('hidden');
  }

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

    if (this.state.immersionBg === 'tremor') {
      bg.classList.remove('webcam-bg');
      bgLabel.textContent = 'FOND · TRÉMOR';
      bgImg.style.display = 'none';
      waveSvg.style.display = '';
      document.getElementById('widget-title').textContent = 'Webcam';
      widget.innerHTML = cam
        ? `<div class="widget-webcam">${this.webcamImgHtml(cam, idx)}</div>`
        : '<div class="widget-webcam"><span class="webcam-placeholder">Webcam indispo</span></div>';
      try {
        const sig = await this.api(`/signal?station=${station}&minutes=10`);
        this.drawLine(waveSvg, sig.v, 'var(--accent)');
      } catch (_) { this.drawError(waveSvg); }
    } else {
      bg.classList.add('webcam-bg');
      bgLabel.textContent = 'FOND · WEBCAM';
      waveSvg.style.display = 'none';
      if (cam) { bgImg.src = this.camUrl(cam); bgImg.style.display = 'block'; }
      document.getElementById('widget-title').textContent = 'PF.' + station;
      widget.innerHTML =
        '<div class="widget-tremor"><div class="widget-tremor-label">SIGNAL BRUT</div>' +
        '<svg class="widget-chart" viewBox="0 0 600 120" preserveAspectRatio="none"></svg></div>';
      try {
        const sig = await this.api(`/signal?station=${station}&minutes=10`);
        this.drawLine(widget.querySelector('svg'), sig.v, 'var(--accent)');
      } catch (_) { this.drawError(widget.querySelector('svg')); }
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

  /* ─── Page COURBES (groupée par zone) ────────────────── */
  renderStationChips() {
    const container = document.getElementById('station-chips');
    container.innerHTML = ZONE_ORDER.map(zone => {
      const sts = STATIONS.filter(s => s.zone === zone);
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
        if (this.state.selectedStations.has(id)) {
          this.state.selectedStations.delete(id);
          chip.classList.remove('active');
        } else {
          this.state.selectedStations.add(id);
          chip.classList.add('active');
        }
        if (this.state.page === 'courbes') this.loadCourbes();
      });
    });
  }

  stationCardHtml(st) {
    return `
      <div class="station-card" id="card-${st.id}">
        <div class="station-card-header">
          <div class="station-info">
            <span class="station-id">PF.${st.id}</span>
            <span class="station-name">${st.name}</span>
            <span class="station-zone">${st.zone}</span>
          </div>
          <span class="station-time" id="time-${st.id}">chargement…</span>
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
  }

  async loadCourbes() {
    const container = document.getElementById('stations-list');
    const selected = STATIONS.filter(st => this.state.selectedStations.has(st.id));
    if (!selected.length) {
      container.innerHTML = '<div class="empty-msg">Sélectionnez au moins une station.</div>';
      this.setStatus('ok', 'Prêt');
      return;
    }

    this.setStatus('loading', 'Mise à jour…');

    // Squelette groupé par zone
    container.innerHTML = ZONE_ORDER.map(zone => {
      const sts = selected.filter(s => s.zone === zone);
      if (!sts.length) return '';
      return `<section class="zone-section">
        <h3 class="zone-heading">${zone} <span class="zone-count">${sts.length}</span></h3>
        ${sts.map(st => this.stationCardHtml(st)).join('')}
      </section>`;
    }).join('');

    const minutes = this.state.courbesMinutes;
    let loaded = 0;

    await this.runPool(selected, FETCH_CONCURRENCY, async (st) => {
      const card = document.getElementById(`card-${st.id}`);
      if (!card) return;
      const waveSvg = card.querySelector('.station-waveform');
      const rsamSvg = card.querySelector('.station-rsam');
      const timeEl = document.getElementById(`time-${st.id}`);
      let ok = false;

      try {
        const sig = await this.api(`/signal?station=${st.id}&minutes=${minutes}`);
        this.drawLine(waveSvg, sig.v, 'var(--accent)');
        timeEl.textContent = `${sig.channel} · ${minutes} min`;
        ok = true;
      } catch (err) {
        this.drawError(waveSvg);
        timeEl.textContent = 'pas de données';
      }

      try {
        const tr = await this.api(`/tremor?station=${st.id}&hours=6`);
        this.drawLine(rsamSvg, tr.rms, 'var(--ink)', 0.55);
        ok = true;
      } catch (err) {
        this.drawError(rsamSvg);
      }

      if (ok) loaded++;
    });

    const time = new Date().toLocaleTimeString('fr-FR');
    if (loaded === selected.length) {
      this.setStatus('ok', `En direct · ${time}`);
    } else if (loaded > 0) {
      this.setStatus('ok', `En direct · ${loaded}/${selected.length} stations · ${time}`);
    } else {
      this.setStatus('error', 'Aucune donnée — serveur injoignable');
    }
  }

  /* ─── Dessin SVG ─────────────────────────────────────── */
  drawLine(svg, values, color, opacity = 1) {
    const W = 600, H = 120, pad = 6;
    svg.innerHTML = '';
    if (!values || !values.length) return this.drawError(svg);

    let min = Infinity, max = -Infinity;
    for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
    if (min === max) { min -= 1; max += 1; }

    const n = values.length;
    const denom = max - min;
    const span = n > 1 ? n - 1 : 1;
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
    poly.setAttribute('stroke-width', '1.2');
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
