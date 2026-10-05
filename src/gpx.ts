// Leitura de arquivos .gpx e modelo da rota (distância acumulada, altimetria, inclinação).

export interface RoutePoint {
  lat: number;
  lon: number;
  ele: number;
  /** Distância acumulada desde o início, em metros. */
  dist: number;
}

export interface RoutePosition {
  lat: number;
  lon: number;
  ele: number;
  /** Rumo em graus (0 = norte, sentido horário). */
  bearing: number;
  /** Índice do ponto da rota imediatamente antes desta posição. */
  index: number;
}

const EARTH_RADIUS = 6371000;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Janela (± metros) da média móvel aplicada à altimetria para remover ruído do GPS. */
const ELEVATION_SMOOTHING = 30;
/** Meia-janela (metros) usada para calcular a inclinação. */
const GRADE_HALF_WINDOW = 25;
const MIN_GRADE = -20;
const MAX_GRADE = 25;

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)));
}

function bearing(a: RoutePoint, b: RoutePoint): number {
  const phi1 = toRad(a.lat);
  const phi2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export class Route {
  readonly totalDistance: number;
  readonly totalAscent: number;
  readonly minEle: number;
  readonly maxEle: number;

  constructor(
    readonly name: string,
    readonly points: RoutePoint[],
    readonly hasElevation: boolean,
  ) {
    this.totalDistance = points[points.length - 1].dist;
    let ascent = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < points.length; i++) {
      const e = points[i].ele;
      if (e < min) min = e;
      if (e > max) max = e;
      if (i > 0 && e > points[i - 1].ele) ascent += e - points[i - 1].ele;
    }
    this.totalAscent = ascent;
    this.minEle = min;
    this.maxEle = max;
  }

  /** Índice i tal que points[i].dist <= d < points[i+1].dist. */
  private segmentAt(d: number): number {
    const pts = this.points;
    let lo = 0;
    let hi = pts.length - 2;
    if (d <= 0) return 0;
    if (d >= pts[hi].dist) return hi;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pts[mid].dist <= d) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  positionAt(distance: number): RoutePosition {
    const d = Math.max(0, Math.min(this.totalDistance, distance));
    const i = this.segmentAt(d);
    const a = this.points[i];
    const b = this.points[i + 1];
    const t = (d - a.dist) / (b.dist - a.dist);
    return {
      lat: a.lat + (b.lat - a.lat) * t,
      lon: a.lon + (b.lon - a.lon) * t,
      ele: a.ele + (b.ele - a.ele) * t,
      bearing: bearing(a, b),
      index: i,
    };
  }

  elevationAt(distance: number): number {
    const d = Math.max(0, Math.min(this.totalDistance, distance));
    const i = this.segmentAt(d);
    const a = this.points[i];
    const b = this.points[i + 1];
    return a.ele + ((b.ele - a.ele) * (d - a.dist)) / (b.dist - a.dist);
  }

  /** Inclinação em % no ponto `distance`. */
  gradeAt(distance: number): number {
    if (!this.hasElevation) return 0;
    const from = Math.max(0, distance - GRADE_HALF_WINDOW);
    const to = Math.min(this.totalDistance, distance + GRADE_HALF_WINDOW);
    if (to - from < 1) return 0;
    const grade = ((this.elevationAt(to) - this.elevationAt(from)) / (to - from)) * 100;
    return Math.max(MIN_GRADE, Math.min(MAX_GRADE, grade));
  }
}

function childText(el: Element, tag: string): string | null {
  const child = el.getElementsByTagNameNS('*', tag)[0];
  return child?.textContent?.trim() || null;
}

export function parseGpx(xml: string, fileName = 'Rota'): Route {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('Arquivo GPX inválido.');
  }

  // Atividades usam <trkpt>; rotas planejadas às vezes usam <rtept>.
  let nodes = Array.from(doc.getElementsByTagNameNS('*', 'trkpt'));
  if (nodes.length < 2) nodes = Array.from(doc.getElementsByTagNameNS('*', 'rtept'));
  if (nodes.length < 2) throw new Error('O GPX não contém pontos de trilha (trkpt/rtept).');

  const name =
    doc.getElementsByTagNameNS('*', 'name')[0]?.textContent?.trim() || fileName.replace(/\.gpx$/i, '');

  const raw: { lat: number; lon: number; ele: number | null }[] = [];
  for (const n of nodes) {
    const lat = parseFloat(n.getAttribute('lat') ?? '');
    const lon = parseFloat(n.getAttribute('lon') ?? '');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const eleText = childText(n, 'ele');
    const ele = eleText !== null ? parseFloat(eleText) : NaN;
    raw.push({ lat, lon, ele: Number.isFinite(ele) ? ele : null });
  }

  // Distância acumulada, descartando pontos duplicados (atividade parada gera muitos).
  const points: RoutePoint[] = [];
  const rawEle: (number | null)[] = [];
  for (const p of raw) {
    const prev = points[points.length - 1];
    if (!prev) {
      points.push({ lat: p.lat, lon: p.lon, ele: 0, dist: 0 });
      rawEle.push(p.ele);
      continue;
    }
    const step = haversine(prev.lat, prev.lon, p.lat, p.lon);
    if (step < 0.5) continue;
    points.push({ lat: p.lat, lon: p.lon, ele: 0, dist: prev.dist + step });
    rawEle.push(p.ele);
  }
  if (points.length < 2) throw new Error('A rota é curta demais.');

  // Preenche altitudes faltantes repetindo o último valor conhecido.
  const hasElevation = rawEle.some((e) => e !== null);
  const firstKnown = rawEle.find((e) => e !== null) ?? 0;
  let last = firstKnown;
  const filled = rawEle.map((e) => (e === null ? last : (last = e)));

  // Média móvel por distância (janela ±ELEVATION_SMOOTHING m).
  let lo = 0;
  let hi = 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const d = points[i].dist;
    while (hi < points.length && points[hi].dist <= d + ELEVATION_SMOOTHING) sum += filled[hi++];
    while (points[lo].dist < d - ELEVATION_SMOOTHING) sum -= filled[lo++];
    points[i].ele = sum / (hi - lo);
  }

  return new Route(name, points, hasElevation);
}
