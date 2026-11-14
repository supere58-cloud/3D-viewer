/** Bottom sheet (phone) / side panel (tablet): layers, files, diagnostics, settings. */
import type { Diagnostics } from '../core/types';
import { hasKey, t, type Lang, type StringKey } from '../i18n';
import { store, type RecentFile, type Settings } from '../platform/storage';
import type { Opacity, Viewer, ViewFile, ViewLayer } from '../viewer/viewer';
import { clear, copyText, fmt, fmtBytes, fmtCount, h, icon } from './dom';
import { formatDate, type Note } from './notes';
import type { Slice } from './slices';

declare const __APP_VERSION__: string;

export type Tab = 'layers' | 'files' | 'notes' | 'slices' | 'diag' | 'settings';
type Sheet = 'peek' | 'half' | 'full';

export interface PanelDeps {
  viewer(): Viewer | null;
  settings(): Settings;
  updateSettings(patch: Partial<Settings>): void;
  openPicker(): void;
  /** Null where the platform cannot pick a folder. */
  openFolder: (() => void) | null;
  openRecent(r: RecentFile): void;
  loadedKeys(): Set<string>;
  layerChanged(file: ViewFile): void;
  closeFile(file: ViewFile): void;
  toast(message: string, kind?: 'info' | 'error'): void;
  layoutChanged(): void;
  notes(): Note[];
  addNote(): void;
  updateNote(id: string, text: string): void;
  deleteNote(id: string): void;
  gotoNote(note: Note): void;
  exportNotes(): void;
  copyNotes(): void;
  slices(): Slice[];
  activeSlice(): string | null;
  sliceLabel(s: Slice): string;
  addSlice(kind: 'h' | 'v'): void;
  /** Starts the "tap a line to cut along it" tool. */
  pickSliceLine(): void;
  toggleSlice(id: string): void;
  deleteSlice(id: string): void;
  startTutorial(): void;
}

const SWATCHES = [
  0xffffff, 0xffd400, 0xff9500, 0xff3b30, 0xff5ad1, 0xb07bff, 0x4da3ff, 0x00e5ff, 0x3dffb8, 0x7dff5a, 0xc8ff00, 0x9aa5b1,
];
const PEEK = 60;
const TABS: Tab[] = ['layers', 'files', 'notes', 'slices', 'diag', 'settings'];
/** Tabs shown as an icon only, to keep the bar readable on a phone. */
const ICON_TABS: Partial<Record<Tab, string>> = { diag: 'info', settings: 'gear' };

export class Panel {
  readonly el: HTMLElement;
  private tabBar: HTMLElement;
  private body: HTMLElement;
  private tab: Tab = 'layers';
  private wide = false;
  private sheet: Sheet = 'peek';
  private collapsed = false;
  private dialog: HTMLElement | null = null;
  private dragging = false;
  /** Files whose layer list is folded away. */
  private folded = new Set<string>();
  private seenFiles = new Set<string>();

  constructor(private deps: PanelDeps) {
    const handle = h('div', { class: 'sheet-handle', role: 'button', 'aria-label': 'panel' }, h('span'));
    this.tabBar = h('div', { class: 'tabs', role: 'tablist' });
    this.body = h('div', { class: 'panel-body' });
    this.el = h('aside', { class: 'panel' }, handle, this.tabBar, this.body);
    this.bindDrag(handle);
    window.addEventListener('resize', () => this.applySheet());
  }

  // --- layout ------------------------------------------------------------
  setWide(wide: boolean): void {
    this.wide = wide;
    this.applySheet();
  }

  private sheetHeight(state: Sheet): number {
    const total = window.innerHeight;
    return state === 'peek' ? PEEK : state === 'half' ? Math.round(total * 0.46) : Math.round(total * 0.86);
  }

  private applySheet(): void {
    if (this.wide) {
      this.el.style.height = '';
      this.el.classList.toggle('collapsed', this.collapsed);
    } else {
      this.el.classList.remove('collapsed');
      if (!this.dragging) this.el.style.height = this.sheetHeight(this.sheet) + 'px';
    }
    this.el.dataset.sheet = this.sheet;
    this.deps.layoutChanged();
  }

  /** How many pixels of the viewport the bottom sheet covers. */
  overlap(): number {
    if (this.wide) return 0;
    return Math.min(this.sheetHeight(this.sheet), this.sheetHeight('half'));
  }

  toggle(): void {
    if (this.wide) this.collapsed = !this.collapsed;
    else this.sheet = this.sheet === 'peek' ? 'half' : 'peek';
    this.applySheet();
  }

  /** Opens a tab; `focusNote` puts the cursor into that note. */
  show(tab: Tab, focusNote?: string): void {
    this.tab = tab;
    if (this.wide) this.collapsed = false;
    else if (this.sheet === 'peek') this.sheet = 'half';
    this.applySheet();
    this.render();
    if (focusNote) {
      const el = this.body.querySelector<HTMLTextAreaElement>(`[data-note="${focusNote}"] textarea`);
      el?.scrollIntoView({ block: 'nearest' });
      el?.focus();
    }
  }

  /** Folds the bottom sheet down to its tab bar (no effect on the side panel). */
  peek(): void {
    if (this.wide || this.sheet === 'peek') return;
    this.sheet = 'peek';
    this.applySheet();
  }

  /** Android back button. Returns true if something was closed. */
  back(): boolean {
    if (this.dialog) { this.closeDialog(); return true; }
    if (!this.wide && this.sheet !== 'peek') { this.sheet = 'peek'; this.applySheet(); return true; }
    return false;
  }

  private bindDrag(handle: HTMLElement): void {
    let startY = 0, startH = 0, moved = false;
    handle.addEventListener('pointerdown', (e) => {
      if (this.wide) return;
      handle.setPointerCapture(e.pointerId);
      this.dragging = true;
      moved = false;
      startY = e.clientY;
      startH = this.el.getBoundingClientRect().height;
    });
    handle.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dy = startY - e.clientY;
      if (Math.abs(dy) > 6) moved = true;
      const hgt = Math.max(PEEK, Math.min(this.sheetHeight('full'), startH + dy));
      this.el.style.height = hgt + 'px';
    });
    const end = (): void => {
      if (!this.dragging) return;
      this.dragging = false;
      if (!moved) {
        this.sheet = this.sheet === 'peek' ? 'half' : this.sheet === 'half' ? 'full' : 'peek';
      } else {
        const hgt = this.el.getBoundingClientRect().height;
        const states: Sheet[] = ['peek', 'half', 'full'];
        this.sheet = states.reduce((best, s) => (Math.abs(this.sheetHeight(s) - hgt) < Math.abs(this.sheetHeight(best) - hgt) ? s : best), 'peek' as Sheet);
      }
      this.applySheet();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // --- rendering ---------------------------------------------------------
  render(): void {
    clear(this.tabBar);
    for (const tab of TABS) {
      const b = h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(tab === this.tab), onclick: () => {
        if (this.tab === tab && !this.wide && this.sheet !== 'peek') { this.sheet = 'peek'; this.applySheet(); return; }
        this.show(tab);
      } }, ICON_TABS[tab] ? icon(ICON_TABS[tab] as string) : t(('tab.' + tab) as StringKey));
      b.dataset.tab = tab;
      if (ICON_TABS[tab]) { b.classList.add('tab-icon'); b.setAttribute('aria-label', t(('tab.' + tab) as StringKey)); }
      this.tabBar.append(b);
    }
    const scroll = this.body.scrollTop;
    clear(this.body);
    switch (this.tab) {
      case 'layers': this.renderLayers(); break;
      case 'files': this.renderFiles(); break;
      case 'notes': this.renderNotes(); break;
      case 'slices': this.renderSlices(); break;
      case 'diag': this.renderDiag(); break;
      case 'settings': this.renderSettings(); break;
    }
    this.body.scrollTop = scroll;
  }

  private renderLayers(): void {
    const viewer = this.deps.viewer();
    const files = viewer?.files ?? [];
    if (!viewer || files.length === 0) {
      this.body.append(h('p', { class: 'muted pad', text: t('layers.none') }),
        h('div', { class: 'pad' }, h('button', { class: 'btn primary', type: 'button', onclick: () => this.deps.openPicker() }, icon('open'), t('files.open'))));
      return;
    }
    const setAll = (visible: boolean): void => {
      for (const f of files) {
        for (const l of f.layers) { l.visible = visible; viewer.applyLayer(l); }
        this.deps.layerChanged(f);
      }
      this.render();
    };
    this.body.append(h('div', { class: 'row-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => setAll(true) }, icon('eye'), t('layers.showAll')),
      h('button', { class: 'btn', type: 'button', onclick: () => setAll(false) }, icon('eyeOff'), t('layers.hideAll'))));

    for (const file of files) {
      // With many files open, new ones start folded so the list stays short.
      if (!this.seenFiles.has(file.id)) {
        this.seenFiles.add(file.id);
        if (files.length > 3) this.folded.add(file.id);
      }
      const folded = this.folded.has(file.id);
      const eye = h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('layers.fileVisible'), 'aria-pressed': String(file.visible), onclick: () => {
        viewer.setFileVisible(file, !file.visible);
        this.render();
      } }, icon(file.visible ? 'eye' : 'eyeOff'));
      this.body.append(h('div', { class: 'file-head' + (file.visible ? '' : ' off') },
        eye,
        h('button', { class: 'file-name', type: 'button', 'aria-label': t('layers.collapse'), 'aria-expanded': String(!folded), onclick: () => {
          if (folded) this.folded.delete(file.id); else this.folded.add(file.id);
          this.render();
        } }, h('span', { class: 'chev' + (folded ? ' folded' : '') }, icon('chevron')), h('span', { class: 'file-name-text', text: `${file.name} (${file.layers.length})` })),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('layers.zoom'), onclick: () => viewer.fitAll(true, file) }, icon('zoom')),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('layers.close'), onclick: () => this.deps.closeFile(file) }, icon('close'))));
      if (folded) continue;
      const list = h('div', { class: 'layer-list' });
      for (const layer of file.layers) list.append(this.layerRow(viewer, file, layer));
      this.body.append(list);
    }
  }

  private layerRow(viewer: Viewer, file: ViewFile, layer: ViewLayer): HTMLElement {
    const row = h('div', { class: 'layer' + (layer.visible ? '' : ' off') });
    const eye = h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('layers.visible', { name: layer.name }), 'aria-pressed': String(layer.visible) }, icon(layer.visible ? 'eye' : 'eyeOff'));
    eye.addEventListener('click', () => {
      layer.visible = !layer.visible;
      viewer.applyLayer(layer);
      this.deps.layerChanged(file);
      row.classList.toggle('off', !layer.visible);
      eye.setAttribute('aria-pressed', String(layer.visible));
      clear(eye);
      eye.append(icon(layer.visible ? 'eye' : 'eyeOff'));
    });
    const chip = h('span', { class: 'swatch' });
    chip.style.background = layer.css;
    const swatch = h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('layers.color', { name: layer.name }) }, chip);
    swatch.addEventListener('click', () => this.colorDialog(viewer, file, layer, chip));
    const parts: string[] = [];
    if (layer.counts.tri) parts.push(`${fmtCount(layer.counts.tri)} ${t('layers.tri')}`);
    if (layer.counts.seg) parts.push(`${fmtCount(layer.counts.seg)} ${t('layers.seg')}`);
    if (layer.counts.pt) parts.push(`${fmtCount(layer.counts.pt)} ${t('layers.pt')}`);
    if (layer.counts.txt) parts.push(`${fmtCount(layer.counts.txt)} ${t('layers.txt')}`);
    const opacity = h('button', { class: 'opacity-btn', type: 'button', 'aria-label': t('layers.opacity', { name: layer.name }), text: Math.round(layer.opacity * 100) + '%' });
    opacity.addEventListener('click', () => {
      const next: Opacity = layer.opacity === 1 ? 0.5 : layer.opacity === 0.5 ? 0.2 : 1;
      layer.opacity = next;
      viewer.applyLayer(layer);
      this.deps.layerChanged(file);
      opacity.textContent = Math.round(next * 100) + '%';
    });
    row.append(eye, swatch,
      h('div', { class: 'layer-text' }, h('div', { class: 'layer-name', text: layer.name }), h('div', { class: 'layer-meta', text: parts.join(' · ') })),
      opacity);
    return row;
  }

  private colorDialog(viewer: Viewer, file: ViewFile, layer: ViewLayer, chip: HTMLElement): void {
    this.closeDialog();
    const apply = (color: number | null): void => {
      layer.customColor = color;
      viewer.applyLayer(layer);
      chip.style.background = layer.css;
      this.deps.layerChanged(file);
    };
    const grid = h('div', { class: 'swatch-grid' });
    for (const c of SWATCHES) {
      const b = h('button', { class: 'swatch-big', type: 'button', 'aria-label': '#' + c.toString(16).padStart(6, '0') });
      b.style.background = '#' + c.toString(16).padStart(6, '0');
      b.addEventListener('click', () => { apply(c); this.closeDialog(); });
      grid.append(b);
    }
    const custom = h('input', { type: 'color', class: 'color-input', value: layer.css, 'aria-label': t('color.custom') });
    custom.addEventListener('input', () => apply(parseInt(custom.value.slice(1), 16)));
    const box = h('div', { class: 'dialog-box', role: 'dialog', 'aria-modal': 'true' },
      h('h2', { text: `${t('color.title')}: ${layer.name}` }),
      grid,
      h('label', { class: 'color-row' }, h('span', { text: t('color.custom') }), custom),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => { apply(null); this.closeDialog(); } }, t('color.reset')),
        h('button', { class: 'btn primary', type: 'button', onclick: () => this.closeDialog() }, t('color.close'))));
    const dialog = h('div', { class: 'dialog' }, box);
    dialog.addEventListener('click', (e) => { if (e.target === dialog) this.closeDialog(); });
    this.dialog = dialog;
    (this.el.parentElement ?? document.body).append(dialog);
  }

  private privacyDialog(): void {
    this.closeDialog();
    const box = h('div', { class: 'dialog-box privacy', role: 'dialog', 'aria-modal': 'true' },
      h('h2', { text: t('privacy.title') }),
      ...t('privacy.text').split('\n').map((line) => h('p', { text: line })),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => this.closeDialog() }, t('color.close'))));
    const dialog = h('div', { class: 'dialog' }, box);
    dialog.addEventListener('click', (e) => { if (e.target === dialog) this.closeDialog(); });
    this.dialog = dialog;
    (this.el.parentElement ?? document.body).append(dialog);
  }

  private closeDialog(): void {
    this.dialog?.remove();
    this.dialog = null;
  }

  private renderFiles(): void {
    const openFolder = this.deps.openFolder;
    this.body.append(h('div', { class: 'row-actions' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => this.deps.openPicker() }, icon('open'), t('files.open')),
      openFolder ? h('button', { class: 'btn', type: 'button', onclick: () => openFolder() }, icon('folder'), t('files.openFolder')) : null));
    this.body.append(h('h3', { class: 'section', text: t('files.recent') }));
    const recents = store.recents();
    if (recents.length === 0) {
      this.body.append(h('p', { class: 'muted pad', text: t('files.none') }));
      return;
    }
    const loaded = this.deps.loadedKeys();
    const dateFmt = new Intl.DateTimeFormat(this.deps.settings().lang === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' });
    for (const r of recents) {
      const meta = [fmtBytes(r.size), dateFmt.format(new Date(r.ts))];
      if (loaded.has(r.key)) meta.push(t('files.loaded'));
      else if (!r.store) meta.push(t('files.pickAgain'));
      this.body.append(h('div', { class: 'recent' },
        h('button', { class: 'recent-main', type: 'button', onclick: () => this.deps.openRecent(r) },
          icon('file'),
          h('div', { class: 'layer-text' }, h('div', { class: 'layer-name', text: r.name }), h('div', { class: 'layer-meta', text: meta.join(' · ') }))),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('files.forget'), onclick: () => { store.forget(r); this.render(); } }, icon('trash'))));
    }
    this.body.append(h('div', { class: 'pad' },
      h('button', { class: 'btn', type: 'button', onclick: () => { store.clearRecents(); this.render(); } }, icon('trash'), t('files.clear'))));
  }

  // --- sections ----------------------------------------------------------
  private renderSlices(): void {
    const hasModel = (this.deps.viewer()?.files.length ?? 0) > 0;
    const add = (kind: 'h' | 'v', label: string): HTMLElement => {
      const b = h('button', { class: 'btn primary', type: 'button', onclick: () => this.deps.addSlice(kind) }, icon('plus'), label);
      if (!hasModel) b.setAttribute('disabled', '');
      return b;
    };
    this.body.append(
      h('div', { class: 'row-actions compact' }, (() => {
        const b = h('button', { class: 'btn primary', type: 'button', onclick: () => this.deps.pickSliceLine() }, icon('slice'), t('slice.byLine'));
        if (!hasModel) b.setAttribute('disabled', '');
        return b;
      })()),
      h('div', { class: 'row-actions compact' }, add('h', t('slice.h')), add('v', t('slice.v'))),
      h('p', { class: 'muted pad small', text: hasModel ? t('slice.hint') : t('slice.needModel') }));
    const slices = this.deps.slices();
    if (slices.length === 0) {
      this.body.append(h('p', { class: 'muted pad', text: t('slice.none') }));
      return;
    }
    const active = this.deps.activeSlice();
    for (let i = slices.length - 1; i >= 0; i--) {
      const s = slices[i];
      const on = s.id === active;
      this.body.append(h('div', { class: 'recent slice-row' + (on ? ' on' : '') },
        h('button', { class: 'recent-main', type: 'button', 'aria-label': t('slice.show'), 'aria-pressed': String(on), onclick: () => this.deps.toggleSlice(s.id) },
          icon(on ? 'eye' : 'eyeOff'),
          h('div', { class: 'layer-text' },
            h('div', { class: 'layer-name', text: this.deps.sliceLabel(s) }),
            h('div', { class: 'layer-meta', text: t('slice.thickness', { n: s.thickness }) }))),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('slice.delete'), onclick: () => this.deps.deleteSlice(s.id) }, icon('trash'))));
    }
  }

  // --- notes -------------------------------------------------------------
  private renderNotes(): void {
    const notes = this.deps.notes();
    this.body.append(h('div', { class: 'row-actions' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => this.deps.addNote() }, icon('note'), t('notes.new'))));
    if (notes.length === 0) {
      this.body.append(h('p', { class: 'muted pad', text: t('notes.none') }));
      return;
    }
    this.body.append(h('div', { class: 'row-actions compact' },
      h('button', { class: 'btn', type: 'button', onclick: () => this.deps.exportNotes() }, icon('download'), t('notes.export')),
      h('button', { class: 'btn', type: 'button', onclick: () => this.deps.copyNotes() }, icon('copy'), t('notes.copy'))));
    // Newest first; the number is the note's place in the exported table.
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      const area = h('textarea', { class: 'note-text', rows: 2, placeholder: t('notes.placeholder') });
      area.value = n.text;
      const fit = (): void => { area.style.height = 'auto'; area.style.height = Math.min(220, area.scrollHeight + 2) + 'px'; };
      area.addEventListener('input', () => { this.deps.updateNote(n.id, area.value); fit(); });
      const where = n.point
        ? `X ${fmt(n.point[0])}  Y ${fmt(n.point[1])}  Z ${fmt(n.point[2])}`
        : t('notes.noPoint');
      const card = h('div', { class: 'note' },
        h('div', { class: 'note-head' },
          h('span', { class: 'note-n' + (n.point ? '' : ' plain'), text: String(i + 1) }),
          h('div', { class: 'layer-text' },
            h('div', { class: 'note-xyz', text: where }),
            h('div', { class: 'layer-meta', text: [formatDate(n.ts), n.layer, n.file].filter(Boolean).join(' · ') })),
          n.point ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('notes.goto'), onclick: () => this.deps.gotoNote(n) }, icon('target')) : null,
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('notes.delete'), onclick: () => this.deps.deleteNote(n.id) }, icon('trash'))),
        area);
      card.dataset.note = n.id;
      this.body.append(card);
      fit();
    }
  }

  // --- diagnostics -------------------------------------------------------
  private diagRows(file: ViewFile): [string, string][] {
    const d = file.diagnostics;
    const rows: [string, string][] = [
      [t('diag.format'), d.format.toUpperCase()],
      [t('diag.size'), fmtBytes(d.bytes)],
      [t('diag.time'), `${fmt(d.parseMs / 1000, 2)} ${t('diag.sec')}`],
    ];
    if (d.format === 'dxf') {
      rows.push([t('diag.version'), d.version ?? '—'], [t('diag.encoding'), d.encoding], [t('diag.codepage'), d.codepage ?? '—']);
    }
    rows.push(
      [t('diag.layers'), fmtCount(d.layers)],
      [t('diag.triangles'), fmtCount(d.triangles)],
      [t('diag.segments'), fmtCount(d.segments)],
      [t('diag.points'), fmtCount(d.points)],
      [t('diag.texts'), fmtCount(d.texts)],
    );
    if (d.format === 'dxf') rows.push([t('diag.blocks'), fmtCount(d.blocks)], [t('diag.malformed'), fmtCount(d.malformedLines)]);
    return rows;
  }

  private bboxRows(d: Diagnostics): [string, string][] {
    if (!d.bbox) return [];
    const { min, max } = d.bbox;
    const u = ' ' + t('unit.m');
    return [
      [t('diag.min'), `X ${fmt(min[0])}  Y ${fmt(min[1])}  Z ${fmt(min[2])}`],
      [t('diag.max'), `X ${fmt(max[0])}  Y ${fmt(max[1])}  Z ${fmt(max[2])}`],
      [t('diag.extent'), `${fmt(max[0] - min[0])} × ${fmt(max[1] - min[1])} × ${fmt(max[2] - min[2])}${u}`],
    ];
  }

  private warningText(code: string): string {
    const key = 'warn.' + code;
    return hasKey(key) ? t(key) : code;
  }

  private report(file: ViewFile): string {
    const d = file.diagnostics;
    const lines = [file.name, ...this.diagRows(file).map(([k, v]) => `${k}: ${v}`)];
    lines.push('', t('diag.bbox') + ':', ...(d.bbox ? this.bboxRows(d).map(([k, v]) => `  ${k}: ${v}`) : ['  ' + t('diag.empty')]));
    lines.push('', t('diag.entities') + ':', ...Object.entries(d.entities).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${v}`));
    const skipped = Object.entries(d.skipped);
    lines.push('', t('diag.skipped') + ':', ...(skipped.length ? skipped.map(([k, v]) => `  ${k}: ${v}`) : ['  ' + t('diag.nothingSkipped')]));
    if (d.warnings.length) lines.push('', t('diag.warnings') + ':', ...d.warnings.map((w) => '  ' + this.warningText(w)));
    return lines.join('\n');
  }

  private renderDiag(): void {
    const files = this.deps.viewer()?.files ?? [];
    if (files.length === 0) {
      this.body.append(h('p', { class: 'muted pad', text: t('diag.none') }));
      return;
    }
    const table = (rows: [string, string][]): HTMLElement =>
      h('table', { class: 'kv' }, ...rows.map(([k, v]) => h('tr', null, h('th', { text: k }), h('td', { text: v }))));
    for (const file of files) {
      const d = file.diagnostics;
      const card = h('section', { class: 'diag' }, h('h3', { class: 'section', text: file.name }));
      if (d.warnings.length) {
        card.append(h('ul', { class: 'warnings' }, ...d.warnings.map((w) => h('li', { text: this.warningText(w) }))));
      }
      card.append(table(this.diagRows(file)));
      card.append(h('h4', { text: t('diag.bbox') }), d.bbox ? table(this.bboxRows(d)) : h('p', { class: 'warn-text', text: t('diag.empty') }));
      const ents = Object.entries(d.entities).sort((a, b) => b[1] - a[1]);
      if (ents.length) card.append(h('h4', { text: t('diag.entities') }), table(ents.map(([k, v]) => [k, fmtCount(v)])));
      const skipped = Object.entries(d.skipped).sort((a, b) => b[1] - a[1]);
      card.append(h('h4', { text: t('diag.skipped') }),
        skipped.length ? table(skipped.map(([k, v]) => [k, fmtCount(v)])) : h('p', { class: 'muted', text: t('diag.nothingSkipped') }));
      card.append(h('button', { class: 'btn', type: 'button', onclick: () => void copyText(this.report(file)).then((ok) => this.deps.toast(t(ok ? 'm.copied' : 'm.copyFailed'), ok ? 'info' : 'error')) }, icon('copy'), t('diag.copy')));
      this.body.append(card);
    }
  }

  // --- settings ----------------------------------------------------------
  private renderSettings(): void {
    const s = this.deps.settings();
    const langBtn = (lang: Lang, label: string): HTMLElement =>
      h('button', { class: 'seg', type: 'button', 'aria-pressed': String(s.lang === lang), onclick: () => this.deps.updateSettings({ lang }) }, label);
    const toggle = (label: string, value: boolean, set: (v: boolean) => void, hint?: string): HTMLElement => {
      const input = h('input', { type: 'checkbox', class: 'switch' });
      input.checked = value;
      input.addEventListener('change', () => set(input.checked));
      return h('label', { class: 'setting' }, h('div', { class: 'layer-text' }, h('div', { text: label }), hint ? h('div', { class: 'layer-meta', text: hint }) : null), input);
    };
    this.body.append(
      h('h3', { class: 'section', text: t('set.lang') }),
      h('div', { class: 'segs pad' }, langBtn('ru', 'Русский'), langBtn('en', 'English')),
      toggle(t('set.grid'), s.grid, (v) => this.deps.updateSettings({ grid: v })),
      toggle(t('set.labels'), s.labels, (v) => this.deps.updateSettings({ labels: v })),
      toggle(t('set.keep'), s.keepCopies, (v) => this.deps.updateSettings({ keepCopies: v }), t('set.keepHint')),
      toggle(t('set.tutorial'), s.tutorial, (v) => this.deps.updateSettings({ tutorial: v })),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => this.deps.startTutorial() }, t('set.tutorialRun')),
        h('button', { class: 'btn', type: 'button', onclick: () => this.privacyDialog() }, t('set.privacyOpen'))),
      h('p', { class: 'muted pad', text: t('set.privacy') }),
      h('p', { class: 'muted pad', text: t('set.version', { v: __APP_VERSION__ }) }),
    );
  }
}
