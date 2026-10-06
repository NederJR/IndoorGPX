// Painel "Subidas detectadas": próxima subida / subida atual e lista de subidas da rota.

import { climbStatus, type Climb } from './climbs';
import { gradeColor } from './grade-colors';

const COLLAPSED_KEY = 'indoorgpx.climbsCollapsed';

const km = (m: number) => (m / 1000).toFixed(1);

export class ClimbsPanel {
  /** Clique em uma subida da lista. */
  onSelect?: (climb: Climb) => void;

  private climbs: Climb[] = [];
  private items: HTMLElement[] = [];
  private lastKey = '';

  constructor(
    private root: HTMLElement,
    private next: HTMLElement,
    private list: HTMLElement,
    toggle: HTMLElement,
  ) {
    let collapsed = false;
    try {
      collapsed = localStorage.getItem(COLLAPSED_KEY) === '1';
    } catch {
      // ignora
    }
    root.classList.toggle('collapsed', collapsed);
    toggle.addEventListener('click', () => {
      const now = !root.classList.contains('collapsed');
      root.classList.toggle('collapsed', now);
      try {
        localStorage.setItem(COLLAPSED_KEY, now ? '1' : '0');
      } catch {
        // ignora
      }
    });
    list.addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-index]');
      if (li) this.onSelect?.(this.climbs[Number(li.dataset.index)]);
    });
  }

  setClimbs(climbs: Climb[], hasElevation: boolean) {
    this.climbs = climbs;
    this.lastKey = '';
    this.root.querySelector('.climbs-count')!.textContent = climbs.length ? String(climbs.length) : '';
    this.list.replaceChildren();
    this.items = climbs.map((c, i) => {
      const li = document.createElement('li');
      li.dataset.index = String(i);
      li.title = `Inclinação máx. ${c.maxGrade.toFixed(1)}% · clique para ver no mapa`;
      li.innerHTML =
        `<span class="cl-num"></span><span class="cl-range"></span>` +
        `<span class="cl-grade"></span>`;
      li.querySelector('.cl-num')!.textContent = `${c.number}.`;
      li.querySelector('.cl-range')!.textContent =
        `${km(c.start)} → ${km(c.end)} km · ${km(c.length)} km · ${Math.round(c.gain)} m`;
      const grade = li.querySelector<HTMLElement>('.cl-grade')!;
      grade.textContent = `${c.avgGrade.toFixed(1)}%`;
      grade.style.color = gradeColor(c.avgGrade);
      if (c.category) {
        const cat = document.createElement('span');
        cat.className = 'cl-cat';
        cat.textContent = c.category === 'HC' ? 'HC' : `Cat ${c.category}`;
        li.insertBefore(cat, grade);
      }
      this.list.append(li);
      return li;
    });
    if (!climbs.length) {
      this.next.textContent = hasElevation ? 'Nenhuma subida relevante nesta rota.' : 'Rota sem altimetria.';
    }
  }

  /** Atualiza a posição do ciclista (metros desde o início da rota). */
  update(distance: number, elevationAt: (d: number) => number) {
    if (!this.climbs.length) return;
    const { current, next } = climbStatus(this.climbs, distance);

    // Texto de destaque
    if (current) {
      const left = current.end - distance;
      const progress = ((distance - current.start) / current.length) * 100;
      const gainLeft = Math.max(0, elevationAt(current.end) - elevationAt(distance));
      this.next.innerHTML =
        `<strong class="cl-now">Na subida ${current.number}</strong> ` +
        `<span>faltam ${km(left)} km · ~${Math.round(gainLeft)} m</span>` +
        `<div class="cl-progress"><i style="width:${progress.toFixed(1)}%;background:${gradeColor(current.avgGrade)}"></i></div>`;
    } else if (next) {
      this.next.innerHTML =
        `<strong class="cl-soon">Próxima subida em ${km(next.start - distance)} km</strong> ` +
        `<span>${km(next.length)} km · ${Math.round(next.gain)} m · ${next.avgGrade.toFixed(1)}% méd.</span>`;
    } else {
      this.next.textContent = 'Nenhuma subida pela frente. 🎉';
    }

    // Estados da lista só mudam ao entrar/sair de subidas.
    const key = `${current?.number ?? 0}:${next?.number ?? 0}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.climbs.forEach((c, i) => {
      this.items[i].classList.toggle('done', c.end <= distance);
      this.items[i].classList.toggle('current', c === current);
      this.items[i].classList.toggle('upcoming', c === next);
    });
  }
}
