// Gravação do pedal no navegador para não perder a atividade se o app for fechado,
// recarregado ou travar antes de exportar/enviar ao Strava.

import type { Sample } from './export';

export interface StoredRide {
  version: 1;
  /** Identificador do pedal: horário (epoch ms) da primeira amostra. */
  id: number;
  routeName: string;
  /** 'finished' ou o estado em que o app estava quando foi fechado. */
  state: 'riding' | 'paused' | 'finished';
  savedAt: number;
  samples: Sample[];
  movingTime: number;
  distance: number; // m percorridos
  totalDistance: number; // m do ponto de partida ao fim da rota
  ascent: number;
  rideTime: number;
  energy: number;
  exported: boolean;
  uploadedUrl: string | null;
}

const STORAGE_KEY = 'indoorgpx.ride';

export function isRideSaved(ride: StoredRide): boolean {
  return ride.exported || !!ride.uploadedUrl;
}

export function storeRide(ride: StoredRide): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ride));
    return true;
  } catch (err) {
    // Cota excedida ou armazenamento bloqueado: o aviso ao fechar continua protegendo.
    console.warn('IndoorGPX: não foi possível salvar o pedal', err);
    return false;
  }
}

export function loadStoredRide(): StoredRide | null {
  try {
    const ride = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as StoredRide | null;
    if (ride?.version === 1 && Array.isArray(ride.samples) && ride.samples.length > 0) return ride;
  } catch {
    // dado corrompido: ignora
  }
  return null;
}

export function clearStoredRide() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignora
  }
}
