// Modelo físico simples de ciclismo: converte potência (W) em velocidade virtual
// considerando inclinação, peso, resistência de rolamento e arrasto aerodinâmico.

export interface PhysicsParams {
  /** Massa total ciclista + bike (kg). */
  mass: number;
  /** Área frontal x coeficiente de arrasto (m²). */
  cda: number;
  /** Coeficiente de resistência ao rolamento. */
  crr: number;
}

export const GRAVITY = 9.81;
export const AIR_DENSITY = 1.225;

const MAX_STEP = 0.05;

/** Integra a velocidade (m/s) por `dt` segundos. */
export function stepSpeed(v: number, power: number, gradePct: number, dt: number, p: PhysicsParams): number {
  const theta = Math.atan(gradePct / 100);
  const sin = Math.sin(theta);
  const cos = Math.cos(theta);

  let remaining = dt;
  while (remaining > 0) {
    const h = Math.min(remaining, MAX_STEP);
    remaining -= h;
    // Abaixo de 1 m/s limitamos a força de tração para evitar divisão por zero na largada.
    const drive = power > 0 ? power / Math.max(v, 1) : 0;
    const gravity = p.mass * GRAVITY * sin;
    const rolling = v > 0.05 || drive > 0 ? p.mass * GRAVITY * p.crr * cos : 0;
    const aero = 0.5 * AIR_DENSITY * p.cda * v * v;
    v = Math.max(0, v + ((drive - gravity - rolling - aero) / p.mass) * h);
  }

  // Sem pedalar, em plano ou subida, consideramos parado abaixo de ~1,5 km/h.
  if (power <= 0 && v < 0.4 && gradePct > -2) v = 0;
  return v;
}
