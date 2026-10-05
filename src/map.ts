// Mapa estilo Garmin LiveTrack: rota completa, trecho percorrido e o ciclista em movimento.

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Route, RoutePosition } from './gpx';

const ROUTE_COLOR = '#2f80ed';
const DONE_COLOR = '#ff6b1a';
const FOLLOW_PAN_INTERVAL_MS = 1000;

export class MapView {
  onFollowChange?: (follow: boolean) => void;

  private map: L.Map;
  private routeLayer = L.layerGroup();
  private routeLine?: L.Polyline;
  private doneLine?: L.Polyline;
  private rider?: L.Marker;
  private route?: Route;
  private follow = true;
  private lastPan = 0;
  private lastDoneIndex = -1;

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
    street.addTo(this.map);
    L.control
      .layers({ Mapa: street, Relevo: topo, Satélite: satellite }, undefined, { position: 'bottomright' })
      .addTo(this.map);

    this.routeLayer.addTo(this.map);
    this.map.on('dragstart', () => this.setFollow(false));
    new ResizeObserver(() => this.map.invalidateSize()).observe(el);
  }

  setRoute(route: Route) {
    this.route = route;
    this.routeLayer.clearLayers();
    this.lastDoneIndex = -1;

    const latlngs = route.points.map((p) => L.latLng(p.lat, p.lon));
    // Contorno branco por baixo deixa a rota legível sobre qualquer camada.
    L.polyline(latlngs, { color: '#fff', weight: 8, opacity: 0.8 }).addTo(this.routeLayer);
    this.routeLine = L.polyline(latlngs, { color: ROUTE_COLOR, weight: 5 }).addTo(this.routeLayer);
    this.doneLine = L.polyline([], { color: DONE_COLOR, weight: 5 }).addTo(this.routeLayer);

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

    this.map.fitBounds(this.routeLine.getBounds(), { padding: [40, 40] });
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

function flagIcon(kind: 'start' | 'finish'): L.DivIcon {
  return L.divIcon({
    className: 'flag-icon',
    html: `<div class="flag flag-${kind}">${kind === 'start' ? 'S' : 'F'}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}
