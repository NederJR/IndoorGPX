// Catálogo de campos de dados que podem ser exibidos no painel (estilo Garmin).

import { gradeColor } from './grade-colors';

/** Snapshot das métricas do pedal, montado em main.ts a cada atualização do painel. */
export interface RideMetrics {
  speed: number; // m/s
  avgSpeed: number;
  maxSpeed: number;
  power: number;
  power3s: number;
  avgPower: number;
  maxPower: number;
  cadence: number;
  avgCadence: number;
  hasCadence: boolean;
  hr: number;
  avgHr: number;
  maxHr: number;
  grade: number;
  trainerGrade: number;
  elevation: number;
  ascent: number;
  descent: number;
  distance: number; // m percorridos
  totalDistance: number; // m do ponto de partida ao fim da rota
  movingTime: number; // s
  energy: number; // J
  riderKg: number;
  /** Metros até o início da próxima subida (null se não houver). */
  nextClimbIn: number | null;
  /** Metros e ganho restantes da subida atual (null fora de subida). */
  climbLeft: number | null;
  climbGainLeft: number | null;
}

export interface WidgetDef {
  id: string;
  name: string;
  category: string;
  unit?: string | ((m: RideMetrics) => string);
  value: (m: RideMetrics) => string;
  color?: (m: RideMetrics) => string | undefined;
}

const kmh = (ms: number) => (ms * 3.6).toFixed(1);
const orDash = (n: number) => (n > 0 ? String(Math.round(n)) : '--');

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export const WIDGETS: WidgetDef[] = [
  // Velocidade
  { id: 'speed', name: 'Velocidade', category: 'Velocidade', unit: 'km/h', value: (m) => kmh(m.speed) },
  { id: 'avgSpeed', name: 'Vel. média', category: 'Velocidade', unit: 'km/h', value: (m) => kmh(m.avgSpeed) },
  { id: 'maxSpeed', name: 'Vel. máxima', category: 'Velocidade', unit: 'km/h', value: (m) => kmh(m.maxSpeed) },

  // Potência
  { id: 'power', name: 'Potência', category: 'Potência', unit: 'W', value: (m) => String(Math.round(m.power)) },
  { id: 'power3s', name: 'Potência 3s', category: 'Potência', unit: 'W', value: (m) => String(Math.round(m.power3s)) },
  { id: 'avgPower', name: 'Pot. média', category: 'Potência', unit: 'W', value: (m) => String(Math.round(m.avgPower)) },
  { id: 'maxPower', name: 'Pot. máxima', category: 'Potência', unit: 'W', value: (m) => String(Math.round(m.maxPower)) },
  { id: 'wkg', name: 'W/kg', category: 'Potência', unit: 'W/kg', value: (m) => (m.power3s / m.riderKg).toFixed(1) },

  // Cadência
  { id: 'cadence', name: 'Cadência', category: 'Cadência', unit: 'rpm', value: (m) => (m.hasCadence ? String(Math.round(m.cadence)) : '--') },
  { id: 'avgCadence', name: 'Cad. média', category: 'Cadência', unit: 'rpm', value: (m) => orDash(m.avgCadence) },

  // Frequência cardíaca
  { id: 'hr', name: 'FC', category: 'Frequência cardíaca', unit: 'bpm', value: (m) => orDash(m.hr) },
  { id: 'avgHr', name: 'FC média', category: 'Frequência cardíaca', unit: 'bpm', value: (m) => orDash(m.avgHr) },
  { id: 'maxHr', name: 'FC máxima', category: 'Frequência cardíaca', unit: 'bpm', value: (m) => orDash(m.maxHr) },

  // Percurso
  {
    id: 'grade',
    name: 'Inclinação',
    category: 'Percurso',
    unit: '%',
    value: (m) => m.grade.toFixed(1),
    color: (m) => gradeColor(m.grade),
  },
  {
    id: 'trainerGrade',
    name: 'Inclinação no rolo',
    category: 'Percurso',
    unit: '%',
    value: (m) => m.trainerGrade.toFixed(1),
    color: (m) => gradeColor(m.trainerGrade),
  },
  {
    id: 'distance',
    name: 'Distância',
    category: 'Percurso',
    unit: (m) => `/ ${(m.totalDistance / 1000).toFixed(1)} km`,
    value: (m) => (m.distance / 1000).toFixed(2),
  },
  {
    id: 'remaining',
    name: 'Dist. restante',
    category: 'Percurso',
    unit: 'km',
    value: (m) => (Math.max(0, m.totalDistance - m.distance) / 1000).toFixed(2),
  },
  {
    id: 'progress',
    name: 'Concluído',
    category: 'Percurso',
    unit: '%',
    value: (m) => String(Math.floor((m.distance / Math.max(1, m.totalDistance)) * 100)),
  },
  { id: 'elevation', name: 'Altitude', category: 'Percurso', unit: 'm', value: (m) => String(Math.round(m.elevation)) },
  { id: 'ascent', name: 'Subida', category: 'Percurso', unit: 'm', value: (m) => String(Math.round(m.ascent)) },
  { id: 'descent', name: 'Descida', category: 'Percurso', unit: 'm', value: (m) => String(Math.round(m.descent)) },

  // Subidas
  {
    id: 'nextClimb',
    name: 'Próx. subida',
    category: 'Subidas',
    unit: (m) => (m.climbLeft !== null ? '' : 'km'),
    value: (m) => (m.climbLeft !== null ? 'Agora' : m.nextClimbIn !== null ? (m.nextClimbIn / 1000).toFixed(1) : '--'),
  },
  {
    id: 'climbLeft',
    name: 'Subida: restante',
    category: 'Subidas',
    unit: 'km',
    value: (m) => (m.climbLeft !== null ? (m.climbLeft / 1000).toFixed(2) : '--'),
  },
  {
    id: 'climbGainLeft',
    name: 'Subida: falta subir',
    category: 'Subidas',
    unit: 'm',
    value: (m) => (m.climbGainLeft !== null ? String(Math.round(m.climbGainLeft)) : '--'),
  },

  // Tempo
  { id: 'time', name: 'Tempo', category: 'Tempo', value: (m) => formatDuration(m.movingTime) },
  {
    id: 'eta',
    name: 'Tempo restante',
    category: 'Tempo',
    // Estimativa pela velocidade média até aqui.
    value: (m) => (m.avgSpeed > 0.5 ? formatDuration((m.totalDistance - m.distance) / m.avgSpeed) : '--'),
  },
  {
    id: 'clock',
    name: 'Hora',
    category: 'Tempo',
    value: () => new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
  },

  // Energia
  { id: 'energy', name: 'Trabalho', category: 'Energia', unit: 'kJ', value: (m) => String(Math.round(m.energy / 1000)) },
  // Com ~24% de eficiência, kJ mecânicos ≈ kcal gastas.
  { id: 'calories', name: 'Calorias (est.)', category: 'Energia', unit: 'kcal', value: (m) => String(Math.round(m.energy / 1000)) },
];

export const WIDGET_MAP = new Map(WIDGETS.map((w) => [w.id, w]));
