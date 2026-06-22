/* ──────────────────────────────────────────────────────────────
   Piton de la Fournaise — Tableau de bord trémor (lo-fi)
   Toutes les données viennent du backend Flask (app.py) :
     /tremor /signal /seismes /bulletin /webcams /crise
   Source réelle : RESIF FDSN + OVPF-IPGP.
────────────────────────────────────────────────────────────── */

const API_BASE = 'https://volcan-backend-gnem.onrender.com';
const REFRESH_MS = 60_000;

// Stations PF affichées sur la page Courbes (+ webcam d'accueil).
const STATIONS = [
  { id: 'BOR', name: 'Bory',            zone: 'ENCLOS FOUQUÉ' },
  { id: 'CSS', name: 'Cassé Sud',       zone: 'ENCLOS FOUQUÉ' },
  { id: 'FOR', name: 'Formica Leo',     zone: 'ENCLOS FOUQUÉ' },
  { id: 'PER', name: 'Père',            zone: 'PENTES S' },
  { id: 'RVL', name: 'Ravine Langevin', zone: 'PENTES S' },
  { id: 'RER', name: "Rivière de l'Est", zone: 'GRAND BRÛLÉ' },
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
      courbesMinutes: 10,
      selectedStations: new Set(['BOR', 'CSS', 'FOR']),
      webcamBase: '',
      webcams: [],
    };
    this.refreshTimer = null;
    this.init();
  }

  init() {
    document.documentElement.className = this.state.theme;
    this.syncThemeButton();
    this.attachEventListeners();
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

    // Ruban de crise : crise + bulletin + séismes
    this.loadCrisisRibbon();
    // Webcam d'accueil
    this.loadAccueilWebcam();
    // Courbes trémor de la station par défaut
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

      let crise_probable = crise.status === 'fulfilled' && crise.value.crise_probable;
      crisisVal.textContent = crise_probable ? 'CRISE PROBABLE' : (niveau || 'VIGILANCE');
      crisisDot.className = 'crisis-dot ' + (crise_probable ? 'level-crise' : 'level-vigilance');

      // Comptages
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
      const cam = this.state.webcams[0];
      if (!cam) return;
      document.getElementById('accueil-webcam-name').textContent = cam.label;
      const box = document.getElementById('accueil-webcam');
      box.innerHTML = this.webcamImgHtml(cam);
    } catch (_) {
      document.getElementById('accueil-webcam').innerHTML =
        '<span class="webcam-placeholder">Webcam indisponible</span>';
    }
  }

  async loadAccueilCharts(station) {
    const waveSvg = document.querySelector('.waveform-chart');
    const rsamSvg = document.querySelector('.rsam-chart');

    // Signal brut
    try {
      const sig = await this.api(`/signal?station=${station}&minutes=10`);
      this.drawLine(waveSvg, sig.v, 'var(--accent)');
      document.getElementById('accueil-signal-meta').textContent =
        `${sig.channel} · ${Math.round(sig.sampling_rate)} Hz`;
    } catch (err) {
      this.drawError(waveSvg);
      document.getElementById('accueil-signal-meta').textContent = '· indisponible';
    }

    // RSAM (trémor)
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

  /* ─── Page WEBCAMS ───────────────────────────────────── */
  async fetchWebcams() {
    const data = await this.api('/webcams');
    this.state.webcamBase = data.base;
    this.state.webcams = data.cams || [];
    return this.state.webcams;
  }

  webcamImgHtml(cam) {
    const url = this.state.webcamBase + cam.file + '?_=' + Date.now();
    return `
      <img class="webcam-img" src="${url}" alt="${cam.label}"
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
      grid.innerHTML = this.state.webcams.map(cam => `
        <div class="webcam-card">
          ${this.webcamImgHtml(cam)}
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

  /* ─── Page COURBES ───────────────────────────────────── */
  renderStationChips() {
    const container = document.getElementById('station-chips');
    container.innerHTML = STATIONS.map(st => {
      const active = this.state.selectedStations.has(st.id);
      return `<button class="station-chip ${active ? 'active' : ''}" data-station="${st.id}">${st.id}</button>`;
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

  async loadCourbes() {
    const container = document.getElementById('stations-list');
    const stations = STATIONS.filter(st => this.state.selectedStations.has(st.id));
    if (!stations.length) {
      container.innerHTML = '<div class="empty-msg">Sélectionnez au moins une station.</div>';
      return;
    }

    this.setStatus('loading', 'Mise à jour…');
    // Squelette immédiat
    container.innerHTML = stations.map(st => `
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
      </div>
    `).join('');

    const minutes = this.state.courbesMinutes;
    let anyError = false;
    await Promise.all(stations.map(async st => {
      const card = document.getElementById(`card-${st.id}`);
      const waveSvg = card.querySelector('.station-waveform');
      const rsamSvg = card.querySelector('.station-rsam');
      const timeEl = document.getElementById(`time-${st.id}`);

      try {
        const sig = await this.api(`/signal?station=${st.id}&minutes=${minutes}`);
        this.drawLine(waveSvg, sig.v, 'var(--accent)');
        timeEl.textContent = `${sig.channel} · ${minutes} min`;
      } catch (err) {
        this.drawError(waveSvg);
        timeEl.textContent = 'pas de données';
        anyError = true;
      }

      try {
        const tr = await this.api(`/tremor?station=${st.id}&hours=6`);
        this.drawLine(rsamSvg, tr.rms, 'var(--ink)', 0.55);
      } catch (err) {
        this.drawError(rsamSvg);
        anyError = true;
      }
    }));

    this.setStatus(anyError ? 'error' : 'ok',
      anyError ? 'Données partielles' : 'En direct · ' + new Date().toLocaleTimeString('fr-FR'));
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
