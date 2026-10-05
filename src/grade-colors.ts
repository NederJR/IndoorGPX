// Escala de cores por inclinação, compartilhada entre mapa e perfil altimétrico.

export interface GradeBand {
  /** Limite superior (exclusivo) da faixa, em %. */
  max: number;
  color: string;
  label: string;
}

export const GRADE_BANDS: GradeBand[] = [
  { max: -2, color: '#3fa7ff', label: 'Descida' },
  { max: 2, color: '#27c26c', label: '-2–2%' },
  { max: 5, color: '#c6d93a', label: '2–5%' },
  { max: 8, color: '#f5b301', label: '5–8%' },
  { max: 12, color: '#ff6b1a', label: '8–12%' },
  { max: Infinity, color: '#d6264f', label: '12%+' },
];

export function gradeBand(gradePct: number): number {
  const i = GRADE_BANDS.findIndex((b) => gradePct < b.max);
  return i === -1 ? GRADE_BANDS.length - 1 : i;
}

export function gradeColor(gradePct: number): string {
  return GRADE_BANDS[gradeBand(gradePct)].color;
}
