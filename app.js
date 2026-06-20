class VolcanApp {
  constructor() {
    this.state = {
      page: 'accueil',
      immersion: false,
      immersionBg: 'tremor',
      theme: 'dark',
      windowSize: 30,
      selectedStations: new Set(['BOR', 'CSS', 'FOR', 'PER']),
    };

    this.stationData = [
      { id: 'PF.FOR', name: 'Formica Leo', zone: 'ENCLOS FOUQUÉ', chan: 'HHZ' },
      { id: 'PF.CSS', name: 'Cassé Sud', zone: 'ENCLOS FOUQUÉ', chan: 'HHZ' },
      { id: 'PF.BOR', name: 'Bory', zone: 'ENCLOS FOUQUÉ', chan: 'EHZ' },
      { id: 'PF.PER', name: 'Père', zone: 'PENTES S', chan: 'EHZ' },
      { id: 'PF.RVL', name: 'Rivals', zone: 'PENTES S', chan: 'EHZ' },
      { id: 'PF.RER', name: "Rivière de l'Est", zone: 'GRAND BRÛLÉ', chan: 'EHZ' },
    ];

    this.webcamData = [
      { name: 'Cratère Bory', time: '14:35:20' },
      { name: 'Dolomieu Est', time: '14:40:08' },
      { name: 'Piton Bert', time: '14:26:08' },
      { name: 'Enclos Fouqué', time: '14:30:11' },
      { name: 'Piton Partage', time: '14:40:05' },
      { name: 'Piton Basaltes', time: '14:35:20' },
      { name: 'Piton Cascades', time: '14:40:08' },
      { name: 'Nez Coupé', time: '14:38:02' },
    ];

    this.widgetDragState = { dragging: false, offsetX: 0, offsetY: 0 };

    this.init();
  }

  init() {
    this.setupTheme();
    this.attachEventListeners();
    this.renderCaption();
    this.renderPage('accueil');
    this.generateCharts();
  }

  setupTheme() {
    const theme = localStorage.getItem('volcan-theme') || 'dark';
    this.state.theme = theme;
    document.documentElement.className = theme;
  }

  attachEventListeners() {
    // Page switcher
    document.querySelectorAll('.switcher-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchPage(btn.dataset.page));
    });

    // Top nav links
    document.querySelectorAll('.nav-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        this.switchPage(link.dataset.nav);
      });
    });

    // Theme toggle
    document.getElementById('theme-toggle').addEventListener('click', () => this.toggleTheme());

    // Accueil immersion mode
    document.getElementById('enter-immersion').addEventListener('click', () => this.enterImmersion());
    document.getElementById('exit-immersion').addEventListener('click', () => this.exitImmersion());
    document.getElementById('swap-bg').addEventListener('click', () => this.swapImmersionBg());

    // Widget dragging
    document.querySelector('.widget-header').addEventListener('pointerdown', (e) => this.startWidgetDrag(e));

    // Courbes time buttons
    document.querySelectorAll('.time-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  }

  switchPage(page) {
    if (this.state.immersion) this.exitImmersion();

    this.state.page = page;
    document.querySelectorAll('.page-content').forEach(p => p.classList.remove('active'));
    document.getElementById(`page-${page}`).classList.add('active');

    // Update switcher buttons
    document.querySelectorAll('.switcher-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.page === page);
    });

    // Update nav links
    document.querySelectorAll('.nav-link').forEach(link => {
      link.classList.toggle('active', link.dataset.nav === page);
    });

    document.getElementById('url-path').textContent = page;
    this.renderCaption();

    if (page === 'webcams') this.renderWebcams();
    if (page === 'courbes') this.renderCourbes();
  }

  toggleTheme() {
    const newTheme = this.state.theme === 'dark' ? 'light' : 'dark';
    this.state.theme = newTheme;
    localStorage.setItem('volcan-theme', newTheme);
    document.documentElement.className = newTheme;

    const btn = document.getElementById('theme-toggle');
    btn.textContent = newTheme === 'light' ? '☾ Sombre' : '☀ Clair';
  }

  enterImmersion() {
    this.state.immersion = true;
    this.state.immersionBg = 'tremor';
    document.getElementById('accueil-normal').style.display = 'none';
    document.getElementById('accueil-immersion').classList.remove('hidden');
    this.renderImmersionMode();
  }

  exitImmersion() {
    this.state.immersion = false;
    document.getElementById('accueil-normal').style.display = 'grid';
    document.getElementById('accueil-immersion').classList.add('hidden');
  }

  swapImmersionBg() {
    this.state.immersionBg = this.state.immersionBg === 'tremor' ? 'webcam' : 'tremor';
    this.renderImmersionMode();
  }

  renderImmersionMode() {
    const bg = document.getElementById('immersion-bg');
    const bgLabel = document.getElementById('immersion-bg-label');
    const widget = document.getElementById('widget-content');

    if (this.state.immersionBg === 'tremor') {
      bg.classList.remove('webcam-bg');
      bgLabel.textContent = 'FOND · TRÉMOR';
      document.querySelector('.immersion-selector').textContent = 'PF.BOR ▾';

      // Show wave in background
      const waveSvg = bg.querySelector('svg');
      if (waveSvg) {
        const wave = this.generateWave(7, 96, 600, 120, 52);
        this.drawPolyline(waveSvg, wave, 'var(--accent)');
      }

      // Widget shows webcam
      document.getElementById('widget-title').textContent = 'Webcam ▾';
      widget.innerHTML = `
        <div class="widget-webcam">
          <span>▦ WEBCAM</span>
          <span class="widget-webcam-timestamp">14:30 TU</span>
        </div>
      `;
    } else {
      bg.classList.add('webcam-bg');
      bgLabel.textContent = 'FOND · WEBCAM';
      document.querySelector('.immersion-selector').textContent = 'Enclos Fouqué ▾';

      // Clear background wave
      const waveSvg = bg.querySelector('svg');
      if (waveSvg) waveSvg.innerHTML = '';

      // Widget shows tremor
      document.getElementById('widget-title').textContent = 'PF.BOR ▾';
      const wave = this.generateWave(7, 96, 600, 120, 52);
      widget.innerHTML = `
        <div class="widget-tremor">
          <div class="widget-tremor-label">SIGNAL BRUT</div>
          <svg class="widget-chart" viewBox="0 0 600 120" preserveAspectRatio="none"></svg>
        </div>
      `;
      const svg = widget.querySelector('svg');
      this.drawPolyline(svg, wave, 'var(--accent)');
    }
  }

  startWidgetDrag(e) {
    if (e.button !== 0) return;
    e.preventDefault();

    const widget = document.getElementById('immersion-widget');
    const rect = widget.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const currentX = parseFloat(widget.style.left) || 690;
    const currentY = parseFloat(widget.style.top) || 340;

    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      widget.style.left = (currentX + dx) + 'px';
      widget.style.top = (currentY + dy) + 'px';
    };

    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  renderCaption() {
    const captions = {
      accueil: 'Accueil — « Côte à côte »',
      webcams: 'Page Webcams — toutes les caméras',
      courbes: 'Page Courbes — toutes les stations',
    };

    const descriptions = {
      accueil: 'Ruban de crise fin en haut · webcam et courbe à parité 50/50.',
      webcams: 'Grille filtrable de toutes les webcams OVPF-IPGP.',
      courbes: 'Sélecteur de stations + signal brut & RSAM pour chaque station.',
    };

    const caption = document.getElementById('caption');
    caption.innerHTML = `
      <span class="caption-title">${captions[this.state.page]}</span>
      <span>${descriptions[this.state.page]}</span>
    `;
  }

  renderPage(page) {
    this.switchPage(page);
  }

  renderWebcams() {
    const grid = document.getElementById('webcams-grid');
    grid.innerHTML = this.webcamData.map(cam => `
      <div class="webcam-card">
        <div class="webcam-card-time">${cam.time} TU</div>
        <div class="webcam-card-placeholder">▦ CAM</div>
        <div class="webcam-card-footer">
          <span class="webcam-card-name">${cam.name}</span>
          <span class="webcam-card-credit">© OVPF-IPGP</span>
        </div>
      </div>
    `).join('');

    // Attach filter listeners
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  }

  renderCourbes() {
    this.renderStationChips();
    this.renderStationCards();
  }

  renderStationChips() {
    const container = document.getElementById('station-chips');
    const allStations = ['BOR', 'CSS', 'FOR', 'PER', 'RVL', 'RER', 'HDL', '+ 50'];

    container.innerHTML = allStations.map(station => {
      const isActive = this.state.selectedStations.has(station);
      return `
        <button class="station-chip ${isActive ? 'active' : ''}" data-station="${station}">
          ${station}
        </button>
      `;
    }).join('');

    document.querySelectorAll('.station-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const station = chip.dataset.station;
        if (this.state.selectedStations.has(station)) {
          this.state.selectedStations.delete(station);
          chip.classList.remove('active');
        } else {
          this.state.selectedStations.add(station);
          chip.classList.add('active');
        }
      });
    });
  }

  renderStationCards() {
    const container = document.getElementById('stations-list');
    container.innerHTML = this.stationData.map((st, i) => {
      const wave = this.generateWave(91 + i * 13, 84, 600, 120, 46);
      const rsam = this.generateRSAM(173 + i * 11, 20, 600, 120);

      return `
        <div class="station-card">
          <div class="station-card-header">
            <div class="station-info">
              <span class="station-id">${st.id}</span>
              <span class="station-name">${st.name}</span>
              <span class="station-zone">${st.zone}</span>
            </div>
            <span class="station-time">${st.chan} · 18:10:25 → 18:40:25</span>
          </div>
          <div class="station-card-charts">
            <div class="station-chart-section">
              <div class="station-chart-label">SIGNAL BRUT</div>
              <svg class="station-waveform" viewBox="0 0 600 120" preserveAspectRatio="none" data-wave="${wave}"></svg>
            </div>
            <div class="station-chart-section">
              <div class="station-chart-label">RSAM</div>
              <svg class="station-rsam" viewBox="0 0 600 120" preserveAspectRatio="none" data-rsam="${rsam}"></svg>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Draw charts
    document.querySelectorAll('.station-waveform').forEach(svg => {
      const wave = svg.dataset.wave;
      this.drawPolyline(svg, wave, 'var(--accent)');
    });

    document.querySelectorAll('.station-rsam').forEach(svg => {
      const rsam = svg.dataset.rsam;
      this.drawPolyline(svg, rsam, 'var(--ink)', 0.5);
    });
  }

  generateCharts() {
    // Accueil normal mode charts
    const wave1 = this.generateWave(7, 96, 600, 120, 52);
    const rsam1 = this.generateRSAM(31, 24, 600, 120);

    const waveSvg = document.querySelector('.waveform-chart');
    const rsamSvg = document.querySelector('.rsam-chart');

    if (waveSvg) this.drawPolyline(waveSvg, wave1, 'var(--accent)');
    if (rsamSvg) this.drawPolyline(rsamSvg, rsam1, 'var(--ink)', 0.55);

    // Immersion mode background
    const immersionSvg = document.querySelector('.immersion-wave');
    if (immersionSvg) this.drawPolyline(immersionSvg, wave1, 'var(--accent)');
  }

  generateWave(seed, n, w, h, amp) {
    const rng = this.seededRandom(seed);
    const points = [];

    for (let i = 0; i <= n; i++) {
      const x = (i / n) * w;
      const env = 0.42 + 0.58 * Math.abs(Math.sin(i * 0.21) + 0.4 * Math.sin(i * 0.07));
      let y = h / 2 + (rng() - 0.5) * amp * env * 2;
      y = Math.max(3, Math.min(h - 3, y));
      points.push(x.toFixed(1) + ',' + y.toFixed(1));
    }

    return points.join(' ');
  }

  generateRSAM(seed, n, w, h) {
    const rng = this.seededRandom(seed);
    const points = [];

    for (let i = 0; i <= n; i++) {
      const y = (h * 0.22 + rng() * h * 0.5).toFixed(1);
      const x0 = ((i / n) * w).toFixed(1);
      const x1 = (Math.min(w, ((i + 1) / n) * w)).toFixed(1);
      points.push(x0 + ',' + y);
      points.push(x1 + ',' + y);
    }

    return points.join(' ');
  }

  seededRandom(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  drawPolyline(svg, pointsStr, color, opacity = 1) {
    const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('points', pointsStr);
    polyline.setAttribute('fill', 'none');
    polyline.setAttribute('stroke', color);
    polyline.setAttribute('stroke-width', '1.6');
    if (opacity < 1) polyline.setAttribute('opacity', opacity);

    svg.innerHTML = '';
    svg.appendChild(polyline);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.app = new VolcanApp();
});
