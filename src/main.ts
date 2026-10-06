import './style.css';
import { parseGpx, type Route } from './gpx';
import { MapView } from './map';
import { ElevationProfile } from './elevation';
import { Trainer, type ConnectionStatus } from './ftms';
import { HeartRateMonitor } from './hrm';
import { AIR_DENSITY, stepSpeed } from './physics';
import { buildTcx, downloadFile, type Sample } from './export';
import { loadSettings, saveSettings, type Settings } from './settings';
import { Dashboard } from './dashboard';
import { formatDuration, type RideMetrics } from './widgets';
import { Strava } from './strava';
import { clearStoredRide, isRideSaved, loadStoredRide, storeRide, type StoredRide } from './ride-store';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type RideState = 'empty' | 'ready' | 'riding' | 'paused' | 'finished';

const SIM_INTERVAL_MS = 100;
const SENSOR_STALE_MS = 3000;
const GRADE_SEND_INTERVAL_MS = 1000;
const GRADE_FORCE_RESEND_MS = 5000;
const SAMPLE_INTERVAL_MS = 1000;
const HUD_INTERVAL_MS = 200;
const PERSIST_INTERVAL_MS = 10000;
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

/** Estatísticas acumuladas do pedal (zeradas em resetRide). */
const POWER_AVG_WINDOW_MS = 3000;
const newStats = () => ({
  rideTime: 0, // s pedalando (exclui pausas), base da potência média
  energy: 0, // J
  maxSpeed: 0,
  maxPower: 0,
  cadenceSum: 0,
  cadenceTime: 0,
  hrSum: 0,
  hrTime: 0,
  maxHr: 0,
  descent: 0,
  recentPower: [] as { t: number; p: number }[],
});
let stats = newStats();
let lastTickAt = performance.now();
let samples: Sample[] = [];
let lastSampleAt = 0;
let lastGradeSentAt = 0;
let lastGradeSent = NaN;

const live = { power: 0, cadence: 0, speedKmh: 0, hr: 0, trainerAt: 0, hrAt: 0, trainerHr: 0 };
let demoMode = false;
let demoPower = 150;
let wakeLock: WakeLockSentinel | null = null;
/** Pedal exibido no resumo: o que acabou de terminar ou um recuperado ao abrir o app. */
let summaryRide: StoredRide | null = null;
let summaryRecovered = false;
let lastPersistAt = 0;

// ---------- Componentes ----------
const mapView = new MapView($('map'));
const profile = new ElevationProfile($<HTMLCanvasElement>('profile'));
const trainer = new Trainer();
const hrm = new HeartRateMonitor();
const strava = new Strava();
const dashboard = new Dashboard($('hud'));

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
  else stats.descent += lastEle - ele;
  lastEle = ele;
  accumulateStats(dt, now, power);

  if (now - lastGradeSentAt >= GRADE_SEND_INTERVAL_MS) sendGrade(grade, now);

  if (Date.now() - lastSampleAt >= SAMPLE_INTERVAL_MS) recordSample();
  if (now - lastPersistAt >= PERSIST_INTERVAL_MS) persistCurrentRide();

  if (distance >= route.totalDistance) {
    distance = route.totalDistance;
    recordSample();
    finishRide();
  }
}

function accumulateStats(dt: number, now: number, power: number) {
  stats.rideTime += dt;
  stats.energy += power * dt;
  stats.maxSpeed = Math.max(stats.maxSpeed, speed);
  stats.maxPower = Math.max(stats.maxPower, power);
  const cadence = currentCadence();
  if (cadence > 0) {
    stats.cadenceSum += cadence * dt;
    stats.cadenceTime += dt;
  }
  const hr = currentHeartRate();
  if (hr > 0) {
    stats.hrSum += hr * dt;
    stats.hrTime += dt;
    stats.maxHr = Math.max(stats.maxHr, hr);
  }
  stats.recentPower.push({ t: now, p: power });
  while (stats.recentPower[0].t < now - POWER_AVG_WINDOW_MS) stats.recentPower.shift();
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
  if (route) dashboard.update(buildMetrics(route));
}

function buildMetrics(r: Route): RideMetrics {
  const power = currentPower();
  const recent = stats.recentPower;
  const grade = r.gradeAt(distance);
  const done = distance - startDistance;
  return {
    speed,
    avgSpeed: movingTime > 0 ? done / movingTime : 0,
    maxSpeed: stats.maxSpeed,
    power,
    // Fora do pedal (antes de iniciar/pausado) mostra a potência instantânea.
    power3s: state === 'riding' && recent.length ? recent.reduce((a, s) => a + s.p, 0) / recent.length : power,
    avgPower: stats.rideTime > 0 ? stats.energy / stats.rideTime : 0,
    maxPower: stats.maxPower,
    cadence: currentCadence(),
    avgCadence: stats.cadenceTime > 0 ? stats.cadenceSum / stats.cadenceTime : 0,
    hasCadence: trainerFresh() || demoMode,
    hr: currentHeartRate(),
    avgHr: stats.hrTime > 0 ? stats.hrSum / stats.hrTime : 0,
    maxHr: stats.maxHr,
    grade,
    trainerGrade: grade * (settings.difficulty / 100),
    elevation: r.elevationAt(distance),
    ascent,
    descent: stats.descent,
    distance: done,
    totalDistance: r.totalDistance - startDistance,
    movingTime,
    energy: stats.energy,
    riderKg: settings.riderKg,
  };
}

// ---------- Fluxo do pedal ----------
function loadRoute(r: Route) {
  if (hasUnsavedRide() && !confirm('A atividade atual não foi exportada nem enviada ao Strava e será perdida. Carregar outra rota mesmo assim?')) return;
  route = r;
  $('routeName').textContent =
    `${r.name} · ${(r.totalDistance / 1000).toFixed(1)} km · ↑${Math.round(r.totalAscent)} m` +
    (r.hasElevation ? '' : ' · (sem altimetria)');
  $('emptyState').hidden = true;
  $('hudWrap').hidden = false;
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
  stats = newStats();
  lastEle = route?.elevationAt(fromDistance) ?? 0;
  samples = [];
  summaryRide = null;
  clearStoredRide();
  lastGradeSent = NaN;
  mapView.resetDone();
  setState('ready');
  updateHud();
  renderRider(performance.now());
}

function startOrPause() {
  if (!route) return;
  if (state === 'finished') {
    if (summaryRide) showSummary(summaryRide);
    return;
  }
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
    persistCurrentRide();
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
  summaryRide = snapshotRide();
  summaryRecovered = false;
  if (summaryRide) {
    storeRide(summaryRide);
    showSummary(summaryRide);
  }
}

/** Retrato do pedal atual para gravar no navegador. */
function snapshotRide(): StoredRide | null {
  if (!route || !samples.length) return null;
  return {
    version: 1,
    id: samples[0].time,
    routeName: route.name,
    state: state === 'riding' || state === 'paused' ? state : 'finished',
    savedAt: Date.now(),
    samples,
    movingTime,
    distance: distance - startDistance,
    totalDistance: route.totalDistance - startDistance,
    ascent,
    rideTime: stats.rideTime,
    energy: stats.energy,
    exported: false,
    uploadedUrl: null,
  };
}

function persistCurrentRide() {
  lastPersistAt = performance.now();
  if (state !== 'riding' && state !== 'paused') return;
  const ride = snapshotRide();
  if (ride) storeRide(ride);
}

function setState(next: RideState) {
  state = next;
  const btnStart = $<HTMLButtonElement>('btnStart');
  const btnFinish = $<HTMLButtonElement>('btnFinish');
  btnStart.textContent =
    state === 'riding' ? '❚❚ Pausar' : state === 'paused' ? '▶ Continuar' : state === 'finished' ? '✓ Ver resumo' : '▶ Iniciar';
  btnStart.disabled = state === 'empty';
  btnFinish.disabled = !(state === 'riding' || state === 'paused');
  $('profileHint').hidden = state !== 'ready';
}

function hasUnsavedRide() {
  if ((state === 'riding' || state === 'paused') && samples.length > 0) return true;
  return !!summaryRide && !isRideSaved(summaryRide);
}

function showSummary(ride: StoredRide) {
  const avgSpeed = ride.movingTime > 0 ? ride.distance / ride.movingTime : 0;
  const avgPower = ride.rideTime > 0 ? ride.energy / ride.rideTime : 0;
  const items: [string, string][] = [
    ['Distância', `${(ride.distance / 1000).toFixed(2)} km`],
    ['Tempo', formatDuration(ride.movingTime)],
    ['Vel. média', `${(avgSpeed * 3.6).toFixed(1)} km/h`],
    ['Potência média', `${Math.round(avgPower)} W`],
    ['Subida', `${Math.round(ride.ascent)} m`],
    ['Concluído', `${Math.round((ride.distance * 100) / Math.max(1, ride.totalDistance))}%`],
  ];
  $('summaryContent').innerHTML = items.map(([k, v]) => `<div><span>${k}</span><strong>${v}</strong></div>`).join('');

  const when = new Date(ride.id).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  $('summaryTitle').textContent = summaryRecovered ? 'Atividade não salva' : 'Pedal concluído 🎉';
  $('summaryNote').textContent = summaryRecovered
    ? `${ride.routeName} · ${when}. ` +
      (ride.state === 'finished'
        ? 'Esta atividade terminou, mas não foi exportada nem enviada ao Strava.'
        : 'O app foi fechado durante o pedal. Os dados até aquele momento foram recuperados.')
    : `${ride.routeName} · ${when}`;

  $('uploadStatus').hidden = true;
  if (ride.uploadedUrl) setUploadStatus('Atividade enviada!', false, ride.uploadedUrl);
  refreshSummaryControls();
  const dialog = $<HTMLDialogElement>('summaryDialog');
  if (!dialog.open) dialog.showModal();
}

function refreshSummaryControls() {
  const ride = summaryRide;
  if (!ride) return;
  const saved = isRideSaved(ride);
  const btnUpload = $<HTMLButtonElement>('btnStravaUpload');
  btnUpload.disabled = !!ride.uploadedUrl;
  btnUpload.textContent = ride.uploadedUrl ? '✓ Enviado ao Strava' : 'Enviar ao Strava';
  $('btnExport').textContent = ride.exported ? '✓ TCX exportado' : 'Exportar TCX';
  $('btnCloseSummary').hidden = !saved;
  $('btnRestart').hidden = summaryRecovered || !route;
  $('summaryGuard').hidden = saved;
}

/** Chamado após exportar ou enviar: a atividade está a salvo e não precisa mais ser recuperada. */
function markSummarySaved() {
  clearStoredRide();
  refreshSummaryControls();
}

function closeSummary() {
  $<HTMLDialogElement>('summaryDialog').close();
  if (summaryRecovered) {
    summaryRide = null;
    summaryRecovered = false;
  }
}

function discardSummaryRide() {
  if (!summaryRide) return;
  if (!isRideSaved(summaryRide) && !confirm('Descartar esta atividade? Ela não foi exportada nem enviada ao Strava e será perdida.')) return;
  clearStoredRide();
  const wasCurrent = !summaryRecovered;
  summaryRide = null;
  closeSummary();
  summaryRecovered = false;
  if (wasCurrent && route) resetRide(0);
}

function setUploadStatus(message: string, error = false, link?: string) {
  const el = $('uploadStatus');
  el.textContent = message;
  el.classList.toggle('error', error);
  if (link) {
    const a = document.createElement('a');
    a.href = link;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Ver no Strava ↗';
    el.append(' ', a);
  }
  el.hidden = false;
}

async function uploadToStrava() {
  const ride = summaryRide;
  if (!ride) {
    setUploadStatus('Nada gravado para enviar.', true);
    return;
  }
  if (!strava.connected) {
    setUploadStatus('Conecte sua conta Strava e tente novamente.', true);
    openSettings();
    return;
  }
  const btn = $<HTMLButtonElement>('btnStravaUpload');
  btn.disabled = true;
  try {
    const km = (ride.distance / 1000).toFixed(1);
    const result = await strava.uploadTcx(
      buildTcx(ride.samples, ride.movingTime, `IndoorGPX – ${ride.routeName}`),
      {
        name: `IndoorGPX: ${ride.routeName}`,
        description: `Pedal virtual no IndoorGPX · ${km} km da rota "${ride.routeName}"`,
        externalId: `indoorgpx-${ride.id}`,
      },
      (msg) => setUploadStatus(msg),
    );
    ride.uploadedUrl = result.url;
    markSummarySaved();
    setUploadStatus('Atividade enviada!', false, result.url);
  } catch (err) {
    btn.disabled = false;
    setUploadStatus(err instanceof Error ? err.message : String(err), true);
  }
}

function exportRide() {
  const ride = summaryRide;
  if (!ride) {
    toast('Nada gravado ainda.', true);
    return;
  }
  const tcx = buildTcx(ride.samples, ride.movingTime, `IndoorGPX – ${ride.routeName}`);
  const date = new Date(ride.id).toISOString().slice(0, 10);
  const safeName = ride.routeName.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60);
  downloadFile(`IndoorGPX_${date}_${safeName}.tcx`, tcx);
  ride.exported = true;
  markSummarySaved();
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
$('btnStravaUpload').addEventListener('click', uploadToStrava);
$('btnCloseSummary').addEventListener('click', closeSummary);
$('btnDiscard').addEventListener('click', discardSummaryRide);
// Esc não fecha o resumo enquanto a atividade não estiver salva.
$('summaryDialog').addEventListener('cancel', (e) => {
  e.preventDefault();
  if (summaryRide && isRideSaved(summaryRide)) closeSummary();
  else setUploadStatus('Exporte o arquivo ou envie ao Strava antes de fechar.', true);
});
$('btnRestart').addEventListener('click', () => {
  if (
    summaryRide &&
    !isRideSaved(summaryRide) &&
    !confirm('A atividade não foi exportada nem enviada ao Strava e será perdida. Pedalar de novo mesmo assim?')
  )
    return;
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
  if (!hasUnsavedRide()) return;
  persistCurrentRide();
  e.preventDefault();
  e.returnValue = '';
});

// ---------- Configurações ----------
const settingsDialog = $<HTMLDialogElement>('settingsDialog');
const settingsForm = $<HTMLFormElement>('settingsForm');

const formField = (name: string) => settingsForm.elements.namedItem(name) as HTMLInputElement;

function openSettings() {
  for (const [key, value] of Object.entries(settings)) {
    const field = settingsForm.elements.namedItem(key) as HTMLInputElement | HTMLSelectElement | null;
    if (field) field.value = String(value);
  }
  formField('stravaClientId').value = strava.config.clientId;
  formField('stravaClientSecret').value = strava.config.clientSecret;
  renderStravaStatus();
  settingsDialog.showModal();
}

$('btnSettings').addEventListener('click', openSettings);

function saveStravaConfig() {
  const clientId = formField('stravaClientId').value.trim();
  const clientSecret = formField('stravaClientSecret').value.trim();
  if (clientId !== strava.config.clientId || clientSecret !== strava.config.clientSecret) {
    strava.setConfig({ clientId, clientSecret });
  }
}

function renderStravaStatus(message?: string) {
  const btn = $<HTMLButtonElement>('btnStravaConnect');
  $('stravaStatus').textContent =
    message ??
    (strava.connecting
      ? 'Aguardando autorização na janela do Strava…'
      : strava.connected
      ? `Conectado como ${strava.athleteName}`
      : strava.configured
        ? 'Não conectado'
        : 'Informe as credenciais do seu app Strava para conectar.');
  btn.textContent = strava.connecting ? 'Cancelar' : strava.connected ? 'Desconectar' : 'Conectar ao Strava';
  btn.classList.toggle('strava', !strava.connected && !strava.connecting);
  $<HTMLDetailsElement>('stravaSetup').open = !strava.configured;
}

$('stravaDomain').textContent = location.hostname;

$('btnStravaConnect').addEventListener('click', async () => {
  if (strava.connecting) {
    strava.cancelConnect();
    return;
  }
  if (strava.connected) {
    await strava.disconnect();
    renderStravaStatus();
    return;
  }
  saveStravaConfig();
  const connecting = strava.connect();
  renderStravaStatus();
  try {
    await connecting;
    renderStravaStatus();
  } catch (err) {
    renderStravaStatus(err instanceof Error ? err.message : String(err));
  }
});

settingsDialog.addEventListener('close', () => {
  if (settingsDialog.returnValue !== 'save') return;
  saveStravaConfig();
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

// Ao esconder a aba (minimizar, trocar de app, fechar), grava o pedal imediatamente.
window.addEventListener('pagehide', persistCurrentRide);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistCurrentRide();
  if (document.visibilityState === 'visible' && state === 'riding') requestWakeLock();
});

// ---------- Início ----------
const recovered = loadStoredRide();
if (recovered && !isRideSaved(recovered)) {
  summaryRide = recovered;
  summaryRecovered = true;
  showSummary(recovered);
} else if (recovered) {
  clearStoredRide();
}

setInterval(tick, SIM_INTERVAL_MS);
requestAnimationFrame(frame);
