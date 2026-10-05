// Painel de campos de dados personalizável: adicionar, remover, redimensionar e arrastar campos.

import Sortable from 'sortablejs';
import { WIDGETS, WIDGET_MAP, type RideMetrics, type WidgetDef } from './widgets';

/** s = 1x1, w = largo (2x1), t = alto (1x2), l = grande (2x2). */
export type WidgetSize = 's' | 'w' | 't' | 'l';

export interface LayoutItem {
  id: string;
  size: WidgetSize;
}

export interface DashboardLayout {
  columns: number;
  items: LayoutItem[];
}

const SIZES: WidgetSize[] = ['s', 'w', 't', 'l'];
const SIZE_NAMES: Record<WidgetSize, string> = { s: 'normal', w: 'largo', t: 'alto', l: 'grande' };
const MIN_COLUMNS = 2;
const MAX_COLUMNS = 6;
const MOBILE_MAX_COLUMNS = 3;
const STORAGE_KEY = 'indoorgpx.dashboard';

export const DEFAULT_LAYOUT: DashboardLayout = {
  columns: 4,
  items: [
    { id: 'speed', size: 's' },
    { id: 'power', size: 's' },
    { id: 'cadence', size: 's' },
    { id: 'hr', size: 's' },
    { id: 'grade', size: 's' },
    { id: 'distance', size: 's' },
    { id: 'time', size: 's' },
    { id: 'elevation', size: 's' },
    { id: 'ascent', size: 's' },
  ],
};

interface Cell {
  def: WidgetDef;
  value: HTMLElement;
  unit: HTMLElement;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class Dashboard {
  private layout: DashboardLayout;
  private editing = false;
  private cells: Cell[] = [];
  private metrics?: RideMetrics;
  private sortable: Sortable;
  private mobile = window.matchMedia('(max-width: 760px)');

  constructor(private grid: HTMLElement) {
    this.layout = loadLayout();

    this.sortable = Sortable.create(grid, {
      animation: 150,
      disabled: true,
      filter: '.w-btn',
      preventOnFilter: false,
      ghostClass: 'w-ghost',
      chosenClass: 'w-chosen',
      onEnd: (e) => {
        if (e.oldIndex === undefined || e.newIndex === undefined || e.oldIndex === e.newIndex) return;
        const [moved] = this.layout.items.splice(e.oldIndex, 1);
        this.layout.items.splice(e.newIndex, 0, moved);
        this.commit();
      },
    });

    grid.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('.w-btn');
      if (!btn) return;
      const index = Array.from(grid.children).indexOf(btn.closest('.metric')!);
      if (index < 0) return;
      if (btn.dataset.action === 'remove') this.layout.items.splice(index, 1);
      else if (btn.dataset.action === 'size') {
        const item = this.layout.items[index];
        item.size = SIZES[(SIZES.indexOf(item.size) + 1) % SIZES.length];
      }
      this.commit();
    });

    $('btnEditHud').addEventListener('click', () => this.setEditing(!this.editing));
    $('btnDoneLayout').addEventListener('click', () => this.setEditing(false));
    $('btnAddWidget').addEventListener('click', () => this.openCatalog());
    $('btnResetLayout').addEventListener('click', () => {
      if (!confirm('Voltar ao painel padrão?')) return;
      this.layout = structuredClone(DEFAULT_LAYOUT);
      this.commit();
    });
    $('colsMinus').addEventListener('click', () => this.setColumns(this.layout.columns - 1));
    $('colsPlus').addEventListener('click', () => this.setColumns(this.layout.columns + 1));
    $('widgetCatalog').addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-id]');
      if (!btn || btn.disabled) return;
      this.layout.items.push({ id: btn.dataset.id!, size: 's' });
      this.commit();
      this.renderCatalog();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.editing && !document.querySelector('dialog[open]')) this.setEditing(false);
    });
    this.mobile.addEventListener('change', () => this.render());

    this.render();
  }

  get isEditing(): boolean {
    return this.editing;
  }

  setEditing(editing: boolean) {
    this.editing = editing;
    this.sortable.option('disabled', !editing);
    this.grid.classList.toggle('editing', editing);
    $('hudToolbar').hidden = !editing;
    $('btnEditHud').classList.toggle('active', editing);
    $('btnEditHud').title = editing ? 'Concluir edição' : 'Personalizar painel';
  }

  update(metrics: RideMetrics) {
    this.metrics = metrics;
    for (const cell of this.cells) {
      cell.value.textContent = cell.def.value(metrics);
      if (typeof cell.def.unit === 'function') cell.unit.textContent = cell.def.unit(metrics);
      if (cell.def.color) cell.value.style.color = cell.def.color(metrics) ?? '';
    }
  }

  private setColumns(n: number) {
    this.layout.columns = Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, n));
    this.commit();
  }

  private commit() {
    saveLayout(this.layout);
    this.render();
  }

  private render() {
    const columns = this.mobile.matches ? Math.min(this.layout.columns, MOBILE_MAX_COLUMNS) : this.layout.columns;
    this.grid.style.setProperty('--cols', String(columns));
    $('colsValue').textContent = String(this.layout.columns);

    this.grid.replaceChildren();
    this.cells = [];
    for (const item of this.layout.items) {
      const def = WIDGET_MAP.get(item.id);
      if (!def) continue;
      const el = document.createElement('div');
      el.className = `metric size-${item.size}`;
      el.innerHTML =
        `<span class="value"></span><span class="unit"></span><span class="name"></span>` +
        `<button class="w-btn w-size" data-action="size" title="Tamanho: ${SIZE_NAMES[item.size]}">⤢</button>` +
        `<button class="w-btn w-remove" data-action="remove" title="Remover">✕</button>`;
      el.querySelector('.name')!.textContent = def.name;
      const cell: Cell = {
        def,
        value: el.querySelector('.value')!,
        unit: el.querySelector('.unit')!,
      };
      if (typeof def.unit === 'string') cell.unit.textContent = def.unit;
      this.cells.push(cell);
      this.grid.append(el);
    }
    this.grid.classList.toggle('empty', this.cells.length === 0);
    if (this.metrics) this.update(this.metrics);
  }

  private openCatalog() {
    this.renderCatalog();
    $<HTMLDialogElement>('widgetDialog').showModal();
  }

  private renderCatalog() {
    const used = new Set(this.layout.items.map((i) => i.id));
    const groups = new Map<string, WidgetDef[]>();
    for (const w of WIDGETS) groups.set(w.category, [...(groups.get(w.category) ?? []), w]);

    const root = $('widgetCatalog');
    root.replaceChildren();
    for (const [category, defs] of groups) {
      const section = document.createElement('section');
      const title = document.createElement('h3');
      title.textContent = category;
      const list = document.createElement('div');
      list.className = 'catalog-list';
      for (const def of defs) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'catalog-item';
        btn.dataset.id = def.id;
        btn.disabled = used.has(def.id);
        const preview = this.metrics ? def.value(this.metrics) : '';
        const unit = typeof def.unit === 'function' ? '' : (def.unit ?? '');
        btn.innerHTML = `<span class="ci-name"></span><span class="ci-preview"></span>`;
        btn.querySelector('.ci-name')!.textContent = (btn.disabled ? '✓ ' : '+ ') + def.name;
        btn.querySelector('.ci-preview')!.textContent = `${preview} ${unit}`.trim();
        list.append(btn);
      }
      section.append(title, list);
      root.append(section);
    }
  }
}

function loadLayout(): DashboardLayout {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as DashboardLayout | null;
    if (saved && Array.isArray(saved.items)) {
      return {
        columns: Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, Number(saved.columns) || DEFAULT_LAYOUT.columns)),
        items: saved.items.filter((i) => WIDGET_MAP.has(i.id) && SIZES.includes(i.size)),
      };
    }
  } catch {
    // layout salvo inválido: usa o padrão
  }
  return structuredClone(DEFAULT_LAYOUT);
}

function saveLayout(layout: DashboardLayout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // armazenamento indisponível
  }
}
