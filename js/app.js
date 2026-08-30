const LAYER_TYPES = [
  { key: 'kingdom', label: 'Kingdoms', icon: '<path d="M4 21V10l3-3 3 3v11M12 21V6l3-3 3 3v15M4 10h6M12 6h8"/>' },
  { key: 'castle', label: 'Castles', icon: '<path d="M4 21V11l3-2v3l3-2v3l3-2v3l3-2v9Z"/><path d="M4 21h16"/>' },
  { key: 'ruins', label: 'Ruins', icon: '<path d="M3 21h18M6 21V9l6-5 6 5v12" stroke-dasharray="2 2"/>' },
  { key: 'settlement', label: 'Settlements', icon: '<path d="M12 21V9M8 13l4-4 4 4M9 17l3-3 3 3"/>' },
  { key: 'water', label: 'Water', icon: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/>' },
  { key: 'place', label: 'Places', icon: '<path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/>' },
];

const layerGroups = {};
const markersById = {};
let locationsIndex = [];

function iconSvg(inner, size = 14) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${inner}</svg>`;
}

function buildLayerRows() {
  const rows = document.getElementById('layer-rows');
  LAYER_TYPES.forEach((t) => {
    layerGroups[t.key] = L.layerGroup();
    const row = document.createElement('div');
    row.className = 'layer-row active';
    row.dataset.key = t.key;
    row.innerHTML = `
      <div class="swatch">${iconSvg(t.icon, 12)}</div>
      <span class="label">${t.label}</span>
    `;
    row.addEventListener('click', () => toggleLayer(t.key, row));
    rows.appendChild(row);
  });
}

function toggleLayer(key, row) {
  const active = row.classList.toggle('active');
  if (active) {
    layerGroups[key].addTo(window.map);
  } else {
    window.map.removeLayer(layerGroups[key]);
  }
}

function popupHtml(loc) {
  const typeLabel = (LAYER_TYPES.find((t) => t.key === loc.type) || {}).label || loc.type;
  const meta = [];
  if (loc.region) meta.push(`<div><b>Region:</b> ${loc.region}</div>`);
  if (loc.era) meta.push(`<div><b>Era:</b> ${loc.era}</div>`);
  return `
    <div class="loc-card">
      <span class="badge">${typeLabel}</span>
      <h3>${loc.name}</h3>
      <p>${loc.description || ''}</p>
      ${meta.length ? `<p style="margin-top:8px;">${meta.join(' ')}</p>` : ''}
    </div>
  `;
}

function markerHtml(loc, typeIcon) {
  return `
    <div class="marker-wrap">
      <div class="marker-badge">${iconSvg(typeIcon || '', 16)}</div>
      <div class="marker-label">${loc.name}</div>
    </div>
  `;
}

function renderLocations(locations) {
  locationsIndex = locations;
  locations.forEach((loc) => {
    const type = LAYER_TYPES.find((t) => t.key === loc.type);
    const marker = L.marker([loc.y, loc.x], {
      icon: L.divIcon({
        className: '',
        html: markerHtml(loc, type && type.icon),
        iconSize: [130, 62],
        iconAnchor: [65, 19],
        popupAnchor: [0, -28],
      }),
    }).bindPopup(popupHtml(loc));
    const group = layerGroups[loc.type];
    if (group) group.addLayer(marker);
    markersById[loc.id] = marker;
  });
  Object.values(layerGroups).forEach((g) => g.addTo(window.map));
}

function initMap() {
  const bounds = [[0, 0], [MAP_CONFIG.height, MAP_CONFIG.width]];
  const map = L.map('map', {
    crs: L.CRS.Simple,
    minZoom: -3,
    maxZoom: 4,
    zoomControl: false,
    attributionControl: false,
  });
  map.fitBounds(bounds);
  window.map = map;

  if (MAP_CONFIG.src) {
    document.getElementById('map-placeholder').style.display = 'none';
    L.imageOverlay(MAP_CONFIG.src, bounds).addTo(map);
  }

  map.on('move zoom', updateStatusBar);
  updateStatusBar();
}

function updateStatusBar() {
  const c = window.map.getCenter();
  document.getElementById('status-coords').textContent = `${Math.round(c.lng)}, ${Math.round(c.lat)}`;
  document.getElementById('status-zoom').textContent = `Z${window.map.getZoom()}`;
}

function setPanel(panel) {
  document.getElementById('search-overlay').classList.toggle('open', panel === 'search');
  document.getElementById('layers-panel').classList.toggle('open', panel === 'layers');
  document.getElementById('btn-search').classList.toggle('active', panel === 'search');
  document.getElementById('btn-layers').classList.toggle('active', panel === 'layers');
  if (panel === 'search') document.getElementById('search-input').focus();
}

function initSearch() {
  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    results.innerHTML = '';
    if (!q) return;
    const matches = locationsIndex.filter((l) => l.name.toLowerCase().includes(q)).slice(0, 8);
    matches.forEach((loc) => {
      const typeLabel = (LAYER_TYPES.find((t) => t.key === loc.type) || {}).label || loc.type;
      const item = document.createElement('div');
      item.className = 'search-result-item';
      item.innerHTML = `${loc.name}<span class="type">${typeLabel}</span>`;
      item.addEventListener('click', () => {
        const group = layerGroups[loc.type];
        const row = document.querySelector(`.layer-row[data-key="${loc.type}"]`);
        if (group && !window.map.hasLayer(group)) {
          group.addTo(window.map);
          if (row) row.classList.add('active');
        }
        window.map.setView([loc.y, loc.x], Math.max(window.map.getZoom(), 1));
        markersById[loc.id].openPopup();
        results.innerHTML = '';
        input.value = '';
        setPanel(null);
      });
      results.appendChild(item);
    });
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-overlay') && !e.target.closest('#btn-search')) {
      results.innerHTML = '';
    }
  });
}

function initSplash() {
  document.getElementById('btn-begin').addEventListener('click', () => {
    document.getElementById('splash').classList.add('hidden');
  });
}

function initControls() {
  document.getElementById('zoom-in').addEventListener('click', () => window.map.zoomIn());
  document.getElementById('zoom-out').addEventListener('click', () => window.map.zoomOut());

  document.getElementById('btn-search').addEventListener('click', () => {
    const isOpen = document.getElementById('search-overlay').classList.contains('open');
    setPanel(isOpen ? null : 'search');
  });
  document.getElementById('btn-layers').addEventListener('click', () => {
    const isOpen = document.getElementById('layers-panel').classList.contains('open');
    setPanel(isOpen ? null : 'layers');
  });
  document.getElementById('btn-fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  });

  setPanel('layers');
}

buildLayerRows();
initMap();
initSplash();
initControls();
initSearch();

fetch('data/locations.json')
  .then((res) => res.json())
  .then(renderLocations)
  .catch(() => renderLocations([]));
