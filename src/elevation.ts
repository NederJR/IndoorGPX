// Perfil altimétrico em canvas com o trecho percorrido e a posição atual.

import type { Route } from './gpx';

export class ElevationProfile {
  /** Disparado ao clicar no perfil, com a distância (m) correspondente. */
  onPick?: (distance: number) => void;

  private ctx: CanvasRenderingContext2D;
  private route?: Route;
  private samples: number[] = [];
  private width = 0;
  private height = 0;
  private colors = { line: '', fill: '', done: '', text: '', marker: '' };

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
      line: css.getPropertyValue('--profile-line').trim() || '#2f80ed',
      fill: css.getPropertyValue('--profile-fill').trim() || 'rgba(47,128,237,.25)',
      done: css.getPropertyValue('--profile-done').trim() || 'rgba(255,107,26,.55)',
      text: css.getPropertyValue('--text-muted').trim() || '#888',
      marker: css.getPropertyValue('--accent').trim() || '#ff6b1a',
    };
    this.resample();
  }

  private resample() {
    if (!this.route || this.width <= 0) return;
    const n = Math.max(2, Math.floor(this.width));
    this.samples = Array.from({ length: n }, (_, i) =>
      this.route!.elevationAt((i / (n - 1)) * this.route!.totalDistance),
    );
  }

  draw(distance: number, startDistance = 0) {
    const { ctx, width: w, height: h, route } = this;
    ctx.clearRect(0, 0, w, h);
    if (!route || this.samples.length < 2) return;

    const padTop = 18;
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

    ctx.fillStyle = this.colors.fill;
    ctx.fill(area);

    const fromX = (startDistance / route.totalDistance) * w;
    const posX = (distance / route.totalDistance) * w;
    ctx.save();
    ctx.beginPath();
    ctx.rect(fromX, 0, posX - fromX, h);
    ctx.clip();
    ctx.fillStyle = this.colors.done;
    ctx.fill(area);
    ctx.restore();

    ctx.beginPath();
    for (let i = 0; i < n; i++) ctx.lineTo(x(i), y(this.samples[i]));
    ctx.strokeStyle = this.colors.line;
    ctx.lineWidth = 2;
    ctx.stroke();

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
