// Preferências do usuário persistidas no navegador.

export interface Settings {
  riderKg: number;
  bikeKg: number;
  /** % da inclinação real enviada ao rolo (como o "trainer difficulty" do Zwift). */
  difficulty: number;
  /** De onde vem a velocidade virtual: modelo físico (potência) ou velocidade informada pelo rolo. */
  speedSource: 'power' | 'trainer';
  cda: number;
  crr: number;
}

export const DEFAULT_SETTINGS: Settings = {
  riderKg: 75,
  bikeKg: 9,
  difficulty: 100,
  speedSource: 'power',
  cda: 0.32,
  crr: 0.004,
};

const KEY = 'indoorgpx.settings';

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // armazenamento indisponível: segue sem persistir
  }
}
