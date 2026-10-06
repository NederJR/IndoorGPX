// Detecção automática de subidas a partir da altimetria (já suavizada) da rota.

import type { Route } from './gpx';

export interface Climb {
  /** Número da subida (1, 2, 3…) na ordem da rota. */
  number: number;
  /** Início e fim em metros desde o começo da rota. */
  start: number;
  end: number;
  length: number;
  gain: number;
  avgGrade: number;
  maxGrade: number;
  /** Categoria estilo Strava ('4' … '1', 'HC') ou null se não categorizada. */
  category: string | null;
}

/** Resolução da análise (m). */
const STEP = 10;
/** Requisitos mínimos para considerar um trecho uma subida. */
const MIN_GAIN = 15;
const MIN_LENGTH = 300;
const MIN_AVG_GRADE = 1.5;
/** Descida tolerada dentro de uma subida antes de considerá-la encerrada (m). */
const MIN_DROP_TOLERANCE = 8;
const MAX_DROP_TOLERANCE = 30;
/** Pontas com inclinação abaixo disso (em janelas de 100 m) são aparadas. */
const TRIM_GRADE = 1;
const TRIM_WINDOW = 100 / STEP;
/** Janela para inclinação máxima (m). */
const MAX_GRADE_WINDOW = 100 / STEP;

const CATEGORIES: [number, string][] = [
  [80000, 'HC'],
  [64000, '1'],
  [32000, '2'],
  [16000, '3'],
  [8000, '4'],
];

export function detectClimbs(route: Route): Climb[] {
  if (!route.hasElevation) return [];
  const total = route.totalDistance;
  const n = Math.floor(total / STEP) + 1;
  const ele = Array.from({ length: n }, (_, i) => route.elevationAt(Math.min(i * STEP, total)));

  const climbs: Climb[] = [];
  let i = 0;
  while (i < n - 1) {
    // Começa no ponto mais baixo e sobe enquanto as descidas no caminho forem pequenas.
    let start = i;
    let top = i;
    let j = i + 1;
    for (; j < n; j++) {
      if (ele[j] > ele[top]) top = j;
      if (ele[j] < ele[start]) {
        start = j;
        top = j;
        continue;
      }
      const gain = ele[top] - ele[start];
      const tolerance = Math.max(MIN_DROP_TOLERANCE, Math.min(gain * 0.2, MAX_DROP_TOLERANCE));
      if (ele[top] - ele[j] > tolerance) break;
    }

    let s = start;
    let e = top;
    // Apara o plano no começo e no fim para a subida começar onde realmente inclina.
    while (s + TRIM_WINDOW <= e && ((ele[s + TRIM_WINDOW] - ele[s]) / (TRIM_WINDOW * STEP)) * 100 < TRIM_GRADE) s++;
    while (e - TRIM_WINDOW >= s && ((ele[e] - ele[e - TRIM_WINDOW]) / (TRIM_WINDOW * STEP)) * 100 < TRIM_GRADE) e--;

    const length = (e - s) * STEP;
    const gain = ele[e] - ele[s];
    const avgGrade = length > 0 ? (gain / length) * 100 : 0;
    if (gain >= MIN_GAIN && length >= MIN_LENGTH && avgGrade >= MIN_AVG_GRADE) {
      let maxGrade = avgGrade;
      for (let k = s; k + MAX_GRADE_WINDOW <= e; k++) {
        maxGrade = Math.max(maxGrade, ((ele[k + MAX_GRADE_WINDOW] - ele[k]) / (MAX_GRADE_WINDOW * STEP)) * 100);
      }
      climbs.push({
        number: climbs.length + 1,
        start: s * STEP,
        end: Math.min(e * STEP, total),
        length,
        gain,
        avgGrade,
        maxGrade,
        category: categorize(length, avgGrade),
      });
    }
    i = top > start ? top + 1 : j;
  }
  return climbs;
}

/** Categoria aproximada do Strava: comprimento (m) x inclinação média (%). */
function categorize(length: number, avgGrade: number): string | null {
  if (avgGrade < 3) return null;
  const score = length * avgGrade;
  return CATEGORIES.find(([min]) => score >= min)?.[1] ?? null;
}

export interface ClimbStatus {
  /** Subida em que o ciclista está agora. */
  current: Climb | null;
  /** Próxima subida à frente (se não estiver em uma). */
  next: Climb | null;
}

export function climbStatus(climbs: Climb[], distance: number): ClimbStatus {
  const current = climbs.find((c) => distance >= c.start && distance < c.end) ?? null;
  const next = current ? null : (climbs.find((c) => c.start > distance) ?? null);
  return { current, next };
}
