// Perfil altimétrico em canvas com o trecho percorrido e a posição atual.

import type { Route } from './gpx';
import { gradeColor } from './grade-colors';
import type { Climb } from './climbs';

export class ElevationProfile {
  /** Disparado ao clicar no perfil, com a distância (m) correspondente. */
  onPick?: (distance: number) => void;

  private ctx: CanvasRenderingContext2D;
  private route?: Route;
  private samples: number[] = [];
  /** Cor (por inclinação) de cada coluna entre samples[i] e samples[i+1]. */
  private sampleColors: string[] = [];
  private width = 0;
  private height = 0;
  private colors = { line: '', done: '', text: '', marker: '' };

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('click', (e) => {
      if (!this.route || !this.onPick) return;
      const rect = canvas.getBoundingClientRect();
      const t = (e.clientX - rect.left) / rect.width;
      this.onPick(Math.max(0, Math.min(1, t)) * this.route.totalDistance);
    });
    this.resize();
  }

  private climbs: Climb[] = [];

  setClimbs(climbs: Climb[]) {
    this.climbs = climbs;
  }

  setRoute(route: Route) {
    this.route = route;
    this.resample();
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(this.canvas);
    this.colors = {
      line: css.getPropertyValue('--profile-line').trim() || 'rgba(255,255,255,.85)',
      done: css.getPropertyValue('--profile-done').trim() || 'rgba(17,21,28,.6)',
      text: css.getPropertyValue('--text-muted').trim() || '#888',
      marker: css.getPropertyValue('--accent').trim() || '#ff6b1a',
    };
    this.resample();
  }

  private resample() {
    if (!this.route || this.width <= 0) return;
    const n = Math.max(2, Math.floor(this.width));
    const route = this.route;
    const step = route.totalDistance / (n - 1);
    this.samples = Array.from({ length: n }, (_, i) => route.elevationAt(i * step));
    // Em rotas longas cada coluna cobre muitos metros: usa a inclinação média da coluna.
    this.sampleColors = Array.from({ length: n - 1 }, (_, i) =>
      gradeColor(
        step > 50
          ? route.hasElevation ? ((this.samples[i + 1] - this.samples[i]) / step) * 100 : 0
          : route.gradeAt((i + 0.5) * step),
      ),
    );
  }

  draw(distance: number, startDistance = 0) {
    const { ctx, width: w, height: h, route } = this;
    ctx.clearRect(0, 0, w, h);
    if (!route || this.samples.length < 2) return;

    const padTop = 24;
    const padBottom = 4;
    const min = route.minEle;
    const range = Math.max(20, route.maxEle - min);
    const n = this.samples.length;
    const x = (i: number) => (i / (n - 1)) * w;
    const y = (ele: number) => padTop + (1 - (ele - min) / range) * (h - padTop - padBottom);

    const area = new Path2D();
    area.moveTo(0, h);
    for (let i = 0; i < n; i++) area.lineTo(x(i), y(this.samples[i]));
    area.lineTo(w, h);
    area.closePath();

    const fromX = (startDistance / route.totalDistance) * w;
    const posX = (distance / route.totalDistance) * w;
    ctx.save();
    ctx.clip(area);
    ctx.globalAlpha = 0.8;
    for (let i = 0; i < n - 1; i++) {
      ctx.fillStyle = this.sampleColors[i];
      ctx.fillRect(x(i), 0, x(i + 1) - x(i) + 0.5, h);
    }
    // Trecho percorrido fica escurecido.
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.colors.done;
    ctx.fillRect(fromX, 0, posX - fromX, h);
    ctx.restore();

    ctx.beginPath();
    for (let i = 0; i < n; i++) ctx.lineTo(x(i), y(this.samples[i]));
    ctx.strokeStyle = this.colors.line;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Subidas: barra fina acima do trecho e número no topo.
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of this.climbs) {
      const x0 = (c.start / route.totalDistance) * w;
      const x1 = (c.end / route.totalDistance) * w;
      ctx.fillStyle = gradeColor(c.avgGrade);
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x0, padTop - 8, Math.max(2, x1 - x0), 3);
      ctx.globalAlpha = 1;
      const topY = Math.max(padTop, y(route.elevationAt(c.end)) - 9);
      ctx.fillStyle = 'rgba(17,21,28,0.85)';
      ctx.beginPath();
      ctx.arc(x1, topY, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = gradeColor(c.avgGrade);
      ctx.fillText(String(c.number), x1, topY + 0.5);
    }

    // Marcador de posição
    const posY = y(route.elevationAt(distance));
    ctx.strokeStyle = this.colors.marker;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(posX, padTop - 4);
    ctx.lineTo(posX, h);
    ctx.stroke();
    ctx.fillStyle = this.colors.marker;
    ctx.beginPath();
    ctx.arc(posX, posY, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = this.colors.text;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(`${Math.round(route.maxEle)} m`, 4, 2);
    ctx.textAlign = 'right';
    ctx.fillText(`${(route.totalDistance / 1000).toFixed(1)} km`, w - 4, 2);
  }
}
