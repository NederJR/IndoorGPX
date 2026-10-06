// Mapa estilo Garmin LiveTrack: rota completa, trecho percorrido e o ciclista em movimento.

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Route, RoutePosition } from './gpx';
import { GRADE_BANDS, gradeBand } from './grade-colors';

/** Trecho percorrido: cinza escuro por cima das cores de inclinação. */
const DONE_COLOR = '#3a4250';
const FOLLOW_PAN_INTERVAL_MS = 1000;
const BASE_LAYER_KEY = 'indoorgpx.baseLayer';

export class MapView {
  onFollowChange?: (follow: boolean) => void;

  private map: L.Map;
  private routeLayer = L.layerGroup();
  private outline?: L.Polyline;
  private legend = gradeLegend();
  private doneLine?: L.Polyline;
  private rider?: L.Marker;
  private route?: Route;
  private follow = true;
  private lastPan = 0;
  private lastDoneIndex = -1;
  private highlight?: L.Polyline;
  private highlightTimer = 0;

  constructor(el: HTMLElement) {
    this.map = L.map(el, { zoomControl: false, preferCanvas: true }).setView([-15.78, -47.93], 4);
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);

    const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    });
    const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: '&copy; OpenStreetMap, SRTM | &copy; OpenTopoMap',
    });
    const satellite = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: 'Imagens &copy; Esri' },
    );
    // Mapa do OpenStreetMap voltado a ciclistas: ciclovias, tipo de piso, relevo.
    const cyclosm = L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
      maxZoom: 20,
      attribution: '<a href="https://www.cyclosm.org">CyclOSM</a> | &copy; OpenStreetMap',
    });
    const baseLayers: Record<string, L.TileLayer> = {
      Ciclismo: cyclosm,
      Mapa: street,
      Relevo: topo,
      Satélite: satellite,
    };
    // Lembra a última camada escolhida.
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(BASE_LAYER_KEY);
    } catch {
      // ignora
    }
    (baseLayers[saved ?? ''] ?? cyclosm).addTo(this.map);
    L.control.layers(baseLayers, undefined, { position: 'bottomright' }).addTo(this.map);
    this.map.on('baselayerchange', (e) => {
      try {
        localStorage.setItem(BASE_LAYER_KEY, e.name);
      } catch {
        // ignora
      }
    });

    this.routeLayer.addTo(this.map);
    this.map.on('dragstart', () => this.setFollow(false));
    new ResizeObserver(() => this.map.invalidateSize()).observe(el);
  }

  setRoute(route: Route) {
    this.route = route;
    this.routeLayer.clearLayers();
    this.highlight = undefined;
    this.lastDoneIndex = -1;
    this.legend.addTo(this.map);

    const latlngs = route.points.map((p) => L.latLng(p.lat, p.lon));
    // Contorno branco por baixo deixa a rota legível sobre qualquer camada.
    this.outline = L.polyline(latlngs, { color: '#fff', weight: 9, opacity: 0.85 }).addTo(this.routeLayer);
    for (const run of gradeRuns(route)) {
      L.polyline(run.latlngs, { color: GRADE_BANDS[run.band].color, weight: 6 }).addTo(this.routeLayer);
    }
    this.doneLine = L.polyline([], { color: DONE_COLOR, weight: 6, opacity: 0.85 }).addTo(this.routeLayer);

    const first = route.points[0];
    const last = route.points[route.points.length - 1];
    L.marker([last.lat, last.lon], { icon: flagIcon('finish'), interactive: false }).addTo(this.routeLayer);
    L.marker([first.lat, first.lon], { icon: flagIcon('start'), interactive: false }).addTo(this.routeLayer);

    this.rider = L.marker([first.lat, first.lon], {
      icon: L.divIcon({
        className: 'rider-icon',
        html: '<div class="rider"><div class="rider-pulse"></div><div class="rider-arrow"></div><div class="rider-dot"></div></div>',
        iconSize: [44, 44],
        iconAnchor: [22, 22],
      }),
      interactive: false,
      zIndexOffset: 1000,
    }).addTo(this.routeLayer);

    this.map.fitBounds(this.outline.getBounds(), { padding: [40, 40] });
  }

  /** Atualiza o ciclista. Chamado a cada frame. */
  updateRider(pos: RoutePosition, moving: boolean) {
    if (!this.rider) return;
    const latlng = L.latLng(pos.lat, pos.lon);
    this.rider.setLatLng(latlng);

    const el = this.rider.getElement();
    if (el) {
      const arrow = el.querySelector<HTMLElement>('.rider-arrow');
      if (arrow) arrow.style.transform = `rotate(${pos.bearing}deg)`;
      el.classList.toggle('moving', moving);
    }

    const now = performance.now();
    if (this.follow && now - this.lastPan > FOLLOW_PAN_INTERVAL_MS) {
      this.lastPan = now;
      // Pan linear com a mesma duração do intervalo = movimento contínuo da câmera.
      this.map.panTo(latlng, { animate: true, duration: FOLLOW_PAN_INTERVAL_MS / 1000, easeLinearity: 1 });
    }
  }

  /** Atualiza o trecho já percorrido (mais pesado; chamar poucas vezes por segundo). */
  updateDone(startDistance: number, pos: RoutePosition) {
    if (!this.route || !this.doneLine) return;
    const pts = this.route.points;
    const startIdx = this.route.positionAt(startDistance).index + 1;
    if (pos.index === this.lastDoneIndex) {
      const latlngs = this.doneLine.getLatLngs() as L.LatLng[];
      if (latlngs.length) {
        latlngs[latlngs.length - 1] = L.latLng(pos.lat, pos.lon);
        this.doneLine.setLatLngs(latlngs);
        return;
      }
    }
    this.lastDoneIndex = pos.index;
    const start = this.route.positionAt(startDistance);
    const latlngs = [L.latLng(start.lat, start.lon)];
    for (let i = startIdx; i <= pos.index; i++) latlngs.push(L.latLng(pts[i].lat, pts[i].lon));
    latlngs.push(L.latLng(pos.lat, pos.lon));
    this.doneLine.setLatLngs(latlngs);
  }

  /** Enquadra e destaca temporariamente um trecho da rota (ex.: uma subida). */
  showRange(start: number, end: number) {
    if (!this.route) return;
    const a = this.route.positionAt(start);
    const b = this.route.positionAt(end);
    const latlngs = [L.latLng(a.lat, a.lon)];
    for (let i = a.index + 1; i <= b.index; i++) latlngs.push(L.latLng(this.route.points[i].lat, this.route.points[i].lon));
    latlngs.push(L.latLng(b.lat, b.lon));

    this.highlight?.remove();
    this.highlight = L.polyline(latlngs, { color: '#fff', weight: 16, opacity: 0.55 }).addTo(this.routeLayer);
    this.highlight.bringToBack();
    clearTimeout(this.highlightTimer);
    this.highlightTimer = window.setTimeout(() => this.highlight?.remove(), 6000);

    this.setFollow(false);
    this.map.fitBounds(this.highlight.getBounds(), { padding: [80, 80], maxZoom: 16 });
  }

  resetDone() {
    this.lastDoneIndex = -1;
    this.doneLine?.setLatLngs([]);
  }

  zoomToRider(zoom = 16) {
    const ll = this.rider?.getLatLng();
    if (ll) this.map.setView(ll, Math.max(this.map.getZoom(), zoom));
  }

  setFollow(follow: boolean) {
    if (this.follow === follow) return;
    this.follow = follow;
    if (follow) {
      this.lastPan = 0;
      this.zoomToRider();
    }
    this.onFollowChange?.(follow);
  }

  invalidateSize() {
    this.map.invalidateSize();
  }
}

/** Agrupa pontos consecutivos com a mesma faixa de inclinação em uma única polyline. */
function gradeRuns(route: Route): { band: number; latlngs: L.LatLng[] }[] {
  const pts = route.points;
  const runs: { band: number; latlngs: L.LatLng[] }[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const band = gradeBand(route.gradeAt((pts[i].dist + pts[i + 1].dist) / 2));
    const a = L.latLng(pts[i].lat, pts[i].lon);
    const b = L.latLng(pts[i + 1].lat, pts[i + 1].lon);
    const last = runs[runs.length - 1];
    if (last && last.band === band) last.latlngs.push(b);
    else runs.push({ band, latlngs: [a, b] });
  }
  return runs;
}

function gradeLegend(): L.Control {
  const legend = new L.Control({ position: 'bottomleft' });
  legend.onAdd = () => {
    const el = L.DomUtil.create('div', 'grade-legend');
    el.innerHTML = GRADE_BANDS.map((b) => `<span><i style="background:${b.color}"></i>${b.label}</span>`).join('');
    return el;
  };
  return legend;
}

function flagIcon(kind: 'start' | 'finish'): L.DivIcon {
  return L.divIcon({
    className: 'flag-icon',
    html: `<div class="flag flag-${kind}">${kind === 'start' ? 'S' : 'F'}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}
