import './style.css';
import { parseGpx, type Route } from './gpx';
import { MapView } from './map';
import { ElevationProfile } from './elevation';
import { Trainer, type ConnectionStatus } from './ftms';
import { HeartRateMonitor } from './hrm';
import { AIR_DENSITY, stepSpeed } from './physics';
import { buildTcx, downloadFile, type Sample } from './export';
import { loadSettings, saveSettings, type Settings } from './settings';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type RideState = 'empty' | 'ready' | 'riding' | 'paused' | 'finished';

const SIM_INTERVAL_MS = 100;
const SENSOR_STALE_MS = 3000;
const GRADE_SEND_INTERVAL_MS = 1000;
const GRADE_FORCE_RESEND_MS = 5000;
const SAMPLE_INTERVAL_MS = 1000;
const HUD_INTERVAL_MS = 200;
const DONE_LINE_INTERVAL_MS = 250;

// ---------- Estado ----------
let settings: Settings = loadSettings();
let route: Route | null = null;
let state: RideState = 'empty';
let startDistance = 0;
let distance = 0; // metros ao longo da rota
let speed = 0; // m/s
let movingTime = 0; // s
let ascent = 0;
let lastEle = 0;
let lastTickAt = performance.now();
let samples: Sample[] = [];
let lastSampleAt = 0;
let lastGradeSentAt = 0;
let lastGradeSent = NaN;

const live = { power: 0, cadence: 0, speedKmh: 0, hr: 0, trainerAt: 0, hrAt: 0, trainerHr: 0 };
let demoMode = false;
let demoPower = 150;
let wakeLock: WakeLockSentinel | null = null;

// ---------- Componentes ----------
const mapView = new MapView($('map'));
const profile = new ElevationProfile($<HTMLCanvasElement>('profile'));
const trainer = new Trainer();
const hrm = new HeartRateMonitor();

// ---------- Leitura dos sensores ----------
trainer.onData = (d) => {
  const now = performance.now();
  if (d.power !== undefined) live.power = Math.max(0, d.power);
  if (d.cadence !== undefined) live.cadence = d.cadence;
  if (d.speedKmh !== undefined) live.speedKmh = d.speedKmh;
  if (d.heartRate) live.trainerHr = d.heartRate;
  live.trainerAt = now;
};
hrm.onHeartRate = (bpm) => {
  live.hr = bpm;
  live.hrAt = performance.now();
};

const trainerFresh = () => trainer.status === 'connected' && performance.now() - live.trainerAt < SENSOR_STALE_MS;

function currentPower(): number {
  if (demoMode) return demoPower;
  return trainerFresh() ? live.power : 0;
}

function currentCadence(): number {
  if (demoMode) return demoPower > 0 ? 85 : 0;
  return trainerFresh() ? live.cadence : 0;
}

function currentHeartRate(): number {
  if (performance.now() - live.hrAt < SENSOR_STALE_MS) return live.hr;
  return trainerFresh() ? live.trainerHr : 0;
}

// ---------- Simulação ----------
function tick() {
  const now = performance.now();
  // Abas em segundo plano têm o timer reduzido; limitamos o passo para não "teleportar".
  const dt = Math.min((now - lastTickAt) / 1000, 2);
  lastTickAt = now;
  if (route && state === 'riding') simulate(dt, now);
  renderPanels(now);
  if (state === 'riding') renderRider(now);
}

function simulate(dt: number, now: number) {
  if (!route) return;

  const power = currentPower();
  const grade = route.gradeAt(distance);

  if (settings.speedSource === 'trainer' && !demoMode) {
    speed = trainerFresh() ? live.speedKmh / 3.6 : 0;
  } else {
    speed = stepSpeed(speed, power, grade, dt, {
      mass: settings.riderKg + settings.bikeKg,
      cda: settings.cda,
      crr: settings.crr,
    });
  }

  distance += speed * dt;
  if (speed > 0) movingTime += dt;

  const ele = route.elevationAt(distance);
  if (ele > lastEle) ascent += ele - lastEle;
  lastEle = ele;

  if (now - lastGradeSentAt >= GRADE_SEND_INTERVAL_MS) sendGrade(grade, now);

  if (Date.now() - lastSampleAt >= SAMPLE_INTERVAL_MS) recordSample();

  if (distance >= route.totalDistance) {
    distance = route.totalDistance;
    recordSample();
    finishRide();
  }
}

function sendGrade(grade: number, now: number) {
  if (trainer.status !== 'connected') return;
  const target = Math.round(grade * (settings.difficulty / 100) * 10) / 10;
  if (Math.abs(target - lastGradeSent) < 0.1 && now - lastGradeSentAt < GRADE_FORCE_RESEND_MS) return;
  lastGradeSent = target;
  lastGradeSentAt = now;
  trainer.setSimulation(target, settings.crr, AIR_DENSITY * settings.cda).catch(() => {});
}

function recordSample() {
  if (!route) return;
  lastSampleAt = Date.now();
  const pos = route.positionAt(distance);
  samples.push({
    time: lastSampleAt,
    lat: pos.lat,
    lon: pos.lon,
    ele: pos.ele,
    distance: distance - startDistance,
    speed,
    power: currentPower(),
    cadence: currentCadence(),
    heartRate: currentHeartRate(),
  });
}

// ---------- Renderização ----------
let lastHudAt = 0;
let lastDoneAt = 0;

/** Ciclista no mapa. Chamado a cada frame (suave) e a cada tick (garante atualização se o rAF pausar). */
function renderRider(now: number) {
  if (!route) return;
  // Interpola entre ticks da simulação para o ciclista deslizar suavemente.
  const ahead = state === 'riding' ? speed * Math.min((now - lastTickAt) / 1000, 0.2) : 0;
  const pos = route.positionAt(Math.min(route.totalDistance, distance + ahead));
  mapView.updateRider(pos, state === 'riding' && speed > 0.3);
}

/** Painéis mais pesados, atualizados pelo timer da simulação. */
function renderPanels(now: number) {
  if (!route) return;
  if (now - lastDoneAt > DONE_LINE_INTERVAL_MS) {
    lastDoneAt = now;
    if (state !== 'ready') mapView.updateDone(startDistance, route.positionAt(distance));
    profile.draw(distance, startDistance);
  }
  if (now - lastHudAt > HUD_INTERVAL_MS) {
    lastHudAt = now;
    updateHud();
  }
}

function frame(now: number) {
  renderRider(now);
  requestAnimationFrame(frame);
}

function updateHud() {
  if (!route) return;
  const cadence = currentCadence();
  const hr = currentHeartRate();
  $('mSpeed').textContent = (speed * 3.6).toFixed(1);
  $('mPower').textContent = String(Math.round(currentPower()));
  $('mCadence').textContent = cadence > 0 || trainerFresh() || demoMode ? String(Math.round(cadence)) : '--';
  $('mHr').textContent = hr > 0 ? String(hr) : '--';
  $('mGrade').textContent = route.gradeAt(distance).toFixed(1);
  $('mDistance').textContent = ((distance - startDistance) / 1000).toFixed(2);
  $('mDistanceTotal').textContent = `/ ${((route.totalDistance - startDistance) / 1000).toFixed(1)} km`;
  $('mTime').textContent = formatDuration(movingTime);
  $('mEle').textContent = String(Math.round(route.elevationAt(distance)));
  $('mAscent').textContent = String(Math.round(ascent));
}

function formatDuration(sec: number): string {
  const s = Math.floor(sec);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- Fluxo do pedal ----------
function loadRoute(r: Route) {
  if (hasUnsavedRide() && !confirm('Descartar o pedal atual e carregar outra rota?')) return;
  route = r;
  $('routeName').textContent =
    `${r.name} · ${(r.totalDistance / 1000).toFixed(1)} km · ↑${Math.round(r.totalAscent)} m` +
    (r.hasElevation ? '' : ' · (sem altimetria)');
  $('emptyState').hidden = true;
  $('hud').hidden = false;
  $('bottom').hidden = false;
  mapView.invalidateSize();
  mapView.setRoute(r);
  profile.setRoute(r);
  resetRide(0);
}

function resetRide(fromDistance: number) {
  startDistance = fromDistance;
  distance = fromDistance;
  speed = 0;
  movingTime = 0;
  ascent = 0;
  lastEle = route?.elevationAt(fromDistance) ?? 0;
  samples = [];
  lastGradeSent = NaN;
  mapView.resetDone();
  setState('ready');
  updateHud();
  renderRider(performance.now());
}

function startOrPause() {
  if (!route) return;
  if (state === 'ready' || state === 'paused') {
    lastTickAt = performance.now();
    if (state === 'ready') {
      mapView.setFollow(true);
      mapView.zoomToRider();
    }
    setState('riding');
    lastGradeSentAt = 0;
    requestWakeLock();
  } else if (state === 'riding') {
    setState('paused');
    speed = 0;
    if (trainer.status === 'connected') {
      lastGradeSent = 0;
      trainer.setSimulation(0, settings.crr, AIR_DENSITY * settings.cda).catch(() => {});
    }
  }
}

function finishRide() {
  if (state !== 'riding' && state !== 'paused') return;
  setState('finished');
  speed = 0;
  if (trainer.status === 'connected') trainer.setSimulation(0, settings.crr, AIR_DENSITY * settings.cda).catch(() => {});
  releaseWakeLock();
  showSummary();
}

function setState(next: RideState) {
  state = next;
  const btnStart = $<HTMLButtonElement>('btnStart');
  const btnFinish = $<HTMLButtonElement>('btnFinish');
  btnStart.textContent =
    state === 'riding' ? '❚❚ Pausar' : state === 'paused' ? '▶ Continuar' : state === 'finished' ? '✓ Concluído' : '▶ Iniciar';
  btnStart.disabled = state === 'finished' || state === 'empty';
  btnFinish.disabled = !(state === 'riding' || state === 'paused');
  $('profileHint').hidden = state !== 'ready';
}

function hasUnsavedRide() {
  return (state === 'riding' || state === 'paused') && samples.length > 0;
}

function showSummary() {
  const dist = (distance - startDistance) / 1000;
  const avgSpeed = movingTime > 0 ? (distance - startDistance) / movingTime : 0;
  const powers = samples.map((s) => s.power);
  const avgPower = powers.length ? powers.reduce((a, b) => a + b, 0) / powers.length : 0;
  const items: [string, string][] = [
    ['Distância', `${dist.toFixed(2)} km`],
    ['Tempo', formatDuration(movingTime)],
    ['Vel. média', `${(avgSpeed * 3.6).toFixed(1)} km/h`],
    ['Potência média', `${Math.round(avgPower)} W`],
    ['Subida', `${Math.round(ascent)} m`],
    ['Concluído', `${Math.round((dist * 1000 * 100) / Math.max(1, route!.totalDistance - startDistance))}%`],
  ];
  $('summaryContent').innerHTML = items.map(([k, v]) => `<div><span>${k}</span><strong>${v}</strong></div>`).join('');
  $<HTMLDialogElement>('summaryDialog').showModal();
}

function exportRide() {
  if (!route || !samples.length) {
    toast('Nada gravado ainda.', true);
    return;
  }
  const tcx = buildTcx(samples, movingTime, `IndoorGPX – ${route.name}`);
  const date = new Date(samples[0].time).toISOString().slice(0, 10);
  const safeName = route.name.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60);
  downloadFile(`IndoorGPX_${date}_${safeName}.tcx`, tcx);
}

// ---------- Importação de GPX ----------
async function importFile(file: File) {
  try {
    loadRoute(parseGpx(await file.text(), file.name));
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Não foi possível ler o arquivo.', true);
  }
}

for (const id of ['fileInput', 'fileInput2']) {
  const input = $<HTMLInputElement>(id);
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) importFile(file);
    input.value = '';
  });
}

$('btnSample').addEventListener('click', async () => {
  const res = await fetch(`${import.meta.env.BASE_URL}samples/exemplo.gpx`);
  loadRoute(parseGpx(await res.text(), 'exemplo.gpx'));
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  $('dropHint').hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) $('dropHint').hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropHint').hidden = true;
  const file = e.dataTransfer?.files[0];
  if (file) importFile(file);
});

// ---------- Dispositivos ----------
function bindDeviceButton(
  id: string,
  device: { status: ConnectionStatus; name: string; connect(): Promise<void>; disconnect(): void; onStatus?: (s: ConnectionStatus, m?: string) => void },
  idleLabel: string,
) {
  const btn = $(id);
  const label = btn.querySelector('.label')!;
  device.onStatus = (status, message) => {
    btn.dataset.status = status;
    label.textContent =
      status === 'connected'
        ? device.name
        : status === 'connecting'
          ? 'Conectando…'
          : status === 'reconnecting'
            ? 'Reconectando…'
            : idleLabel;
    if (status === 'disconnected' && message) toast(message, true);
  };
  btn.addEventListener('click', async () => {
    if (!navigator.bluetooth) {
      toast('Bluetooth indisponível. Use Chrome ou Edge (Windows, macOS, Android) em localhost ou HTTPS.', true);
      return;
    }
    if (device.status === 'connected' || device.status === 'reconnecting') {
      if (confirm(`Desconectar ${device.name}?`)) device.disconnect();
      return;
    }
    try {
      await device.connect();
    } catch (err) {
      // Usuário fechou o seletor de dispositivos: não é erro.
      if (err instanceof DOMException && err.name === 'NotFoundError') return;
      toast(`Falha ao conectar: ${err instanceof Error ? err.message : err}`, true);
    }
  });
}

bindDeviceButton('btnTrainer', trainer, 'Conectar rolo');
bindDeviceButton('btnHr', hrm, 'Conectar FC');

trainer.onStatus = ((original) => (status: ConnectionStatus, message?: string) => {
  original?.(status, message);
  if (status === 'connected') {
    // Ao (re)conectar, reenviar a inclinação atual.
    lastGradeSent = NaN;
    lastGradeSentAt = 0;
    if (demoMode) toggleDemo(false);
  }
})(trainer.onStatus);

// ---------- Modo demo ----------
function toggleDemo(on = !demoMode) {
  demoMode = on;
  $('demoPanel').hidden = !on;
  $('btnDemo').classList.toggle('active', on);
}

$('btnDemo').addEventListener('click', () => toggleDemo());

const demoSlider = $<HTMLInputElement>('demoPower');
function setDemoPower(w: number) {
  demoPower = Math.max(0, Math.min(600, w));
  demoSlider.value = String(demoPower);
  $('demoPowerValue').textContent = `${demoPower} W`;
}
demoSlider.addEventListener('input', () => setDemoPower(Number(demoSlider.value)));

// ---------- Controles ----------
$('btnStart').addEventListener('click', startOrPause);
$('btnFinish').addEventListener('click', () => {
  if (confirm('Finalizar o pedal?')) finishRide();
});
$('btnExport').addEventListener('click', exportRide);
$('btnRestart').addEventListener('click', () => {
  $<HTMLDialogElement>('summaryDialog').close();
  resetRide(0);
});
$('btnCenter').addEventListener('click', () => mapView.setFollow(true));
mapView.onFollowChange = (follow) => ($('btnCenter').hidden = follow);

profile.onPick = (d) => {
  if (state !== 'ready') return;
  resetRide(d);
  mapView.zoomToRider();
};

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (document.querySelector('dialog[open]')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    startOrPause();
  } else if (demoMode && e.code === 'ArrowUp') {
    e.preventDefault();
    setDemoPower(demoPower + 10);
  } else if (demoMode && e.code === 'ArrowDown') {
    e.preventDefault();
    setDemoPower(demoPower - 10);
  }
});

window.addEventListener('beforeunload', (e) => {
  if (hasUnsavedRide()) e.preventDefault();
});

// ---------- Configurações ----------
const settingsDialog = $<HTMLDialogElement>('settingsDialog');
const settingsForm = $<HTMLFormElement>('settingsForm');

$('btnSettings').addEventListener('click', () => {
  for (const [key, value] of Object.entries(settings)) {
    const field = settingsForm.elements.namedItem(key) as HTMLInputElement | HTMLSelectElement | null;
    if (field) field.value = String(value);
  }
  settingsDialog.showModal();
});

settingsDialog.addEventListener('close', () => {
  if (settingsDialog.returnValue !== 'save') return;
  const data = new FormData(settingsForm);
  settings = {
    riderKg: Number(data.get('riderKg')),
    bikeKg: Number(data.get('bikeKg')),
    difficulty: Number(data.get('difficulty')),
    speedSource: data.get('speedSource') === 'trainer' ? 'trainer' : 'power',
    cda: Number(data.get('cda')),
    crr: Number(data.get('crr')),
  };
  saveSettings(settings);
  lastGradeSent = NaN;
});

// ---------- Utilidades ----------
let toastTimer = 0;
function toast(message: string, error = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 5000);
}

async function requestWakeLock() {
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
  } catch {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state === 'riding') requestWakeLock();
});

// ---------- Início ----------
setInterval(tick, SIM_INTERVAL_MS);
requestAnimationFrame(frame);
