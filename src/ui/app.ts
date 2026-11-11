/** Application shell: wires the viewer, the panel, file loading and settings together. */
import { LoadError, type LoadErrorCode, type Vec3 } from '../core/types';
import { formatFromName } from '../core/load';
import { getLang, hasKey, setLang, t, type StringKey } from '../i18n';
import { loadModel, type LoadHandle, type LoadSource } from '../platform/loader';
import { initNative, isNative, pickNativeFolder, platform, releaseNative, type IncomingFile } from '../platform/native';
import { fileKey, privateStorageAvailable, store, storeName, storedExists, type RecentFile, type Settings } from '../platform/storage';
import { Viewer, type LayerSettings, type PickResult, type ViewFile, type ViewLayer } from '../viewer/viewer';
import { clear, copyText, fmt, h, icon } from './dom';
import { exportTextFile } from '../platform/export';
import { measure } from './measure';
import { notesToCsv, notesToTsv, type Note, type NoteHeaders } from './notes';
import { Panel } from './panel';

type QueueItem = LoadSource & { nativePath?: string };

export class App {
  private settings: Settings = store.loadSettings();
  private root: HTMLElement;
  private viewport!: HTMLElement;
  private viewer: Viewer | null = null;
  private panel!: Panel;
  private toolbar!: HTMLElement;
  private empty!: HTMLElement;
  private measureCard!: HTMLElement;
  private gridLabel!: HTMLElement;
  private busy!: HTMLElement;
  private busyTitle!: HTMLElement;
  private busyPhase!: HTMLElement;
  private busyBar!: HTMLElement;
  private toasts!: HTMLElement;
  private banner!: HTMLElement;
  private fileInput!: HTMLInputElement;
  private folderInput!: HTMLInputElement;
  /** Whole-folder opening: native picker on Android, directory input where the browser has one. */
  private canPickFolder = false;
  private gridStep = 0;
  private pickA: PickResult | null = null;
  private pickB: PickResult | null = null;
  private noHit = false;
  private queue: QueueItem[] = [];
  private queueTotal = 0;
  private queueDone = 0;
  private current: LoadHandle | null = null;
  private keys = new Map<ViewFile, string>();
  private nextId = 1;
  private notes: Note[] = store.notes();

  constructor(root: HTMLElement) {
    this.root = root;
    setLang(this.settings.lang);
    this.build();
    this.applySettings();
    void initNative({
      onFiles: (files, failed) => this.openNative(files, failed),
      onPause: () => this.viewer?.pause(),
      onResume: () => this.viewer?.resume(),
      onBack: () => this.handleBack(),
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.viewer?.pause();
      else this.viewer?.resume();
    });
    this.setupWebFileHandling();
  }

  // --- construction ------------------------------------------------------
  private build(): void {
    clear(this.root);
    this.fileInput = h('input', { type: 'file', multiple: true, class: 'offscreen', tabindex: -1, 'aria-hidden': 'true' });
    // No accept filter: Android and iOS pickers grey out .dxf when filtered by type.
    this.fileInput.addEventListener('change', () => {
      const files = [...(this.fileInput.files ?? [])];
      this.fileInput.value = '';
      this.openFiles(files);
    });

    this.folderInput = h('input', { type: 'file', multiple: true, webkitdirectory: true, class: 'offscreen', tabindex: -1, 'aria-hidden': 'true' });
    this.folderInput.addEventListener('change', () => {
      const files = [...(this.folderInput.files ?? [])];
      this.folderInput.value = '';
      this.openFolderFiles(files);
    });
    this.canPickFolder = (isNative && platform === 'android') || 'webkitdirectory' in HTMLInputElement.prototype;

    const compass = h('canvas', { class: 'viewcube', role: 'img' });
    this.gridLabel = h('div', { class: 'grid-label' });
    this.measureCard = h('div', { class: 'measure', hidden: true });
    this.empty = h('div', { class: 'empty' });
    this.toolbar = h('div', { class: 'toolbar' });
    this.banner = h('div', { class: 'banner', hidden: true, role: 'status' });
    const stage = h('div', { class: 'stage' });
    this.toasts = h('div', { class: 'toasts', 'aria-live': 'polite' });
    this.viewport = h('main', { class: 'viewport' }, stage, this.toolbar, compass, this.gridLabel, this.empty, this.measureCard, this.banner, this.toasts);

    this.panel = new Panel({
      viewer: () => this.viewer,
      settings: () => this.settings,
      updateSettings: (patch) => this.updateSettings(patch),
      openPicker: () => this.fileInput.click(),
      openFolder: this.canPickFolder ? () => this.openFolder() : null,
      openRecent: (r) => void this.openRecent(r),
      loadedKeys: () => new Set(this.keys.values()),
      layerChanged: (file) => this.persistLayers(file),
      notes: () => this.notes,
      addNote: () => this.addNote(null),
      updateNote: (id, text) => this.updateNote(id, text),
      deleteNote: (id) => this.deleteNote(id),
      gotoNote: (note) => { if (note.point) this.viewer?.centerOn(note.point); },
      exportNotes: () => void this.exportNotes(),
      copyNotes: () => void copyText(notesToTsv(this.notes, this.noteHeaders())).then((ok) => this.toast(t(ok ? 'm.copied' : 'm.copyFailed'), ok ? 'info' : 'error')),
      closeFile: (file) => this.closeFile(file),
      toast: (msg, kind) => this.toast(msg, kind),
      layoutChanged: () => this.syncLayout(),
    });

    this.busyTitle = h('div', { class: 'busy-title' });
    this.busyPhase = h('div', { class: 'busy-phase' });
    this.busyBar = h('div', { class: 'bar-fill' });
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => this.cancelLoading() });
    cancel.dataset.i18n = 'busy.cancel';
    this.busy = h('div', { class: 'busy', hidden: true, role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'busy-box' }, this.busyTitle, this.busyPhase, h('div', { class: 'bar' }, this.busyBar), cancel));

    this.root.append(this.viewport, this.panel.el, this.busy, this.fileInput, this.folderInput);

    try {
      this.viewer = new Viewer(stage, compass, {
        onPick: (r) => this.onPick(r),
        onGridStep: (s) => { this.gridStep = s; this.renderGridLabel(); },
        onContextLost: (lost) => {
          this.banner.hidden = !lost;
          this.banner.textContent = lost ? t('err.contextLost') : '';
        },
      });
    } catch {
      this.viewer = null;
      clear(this.viewport);
      this.viewport.append(h('div', { class: 'empty' }, h('h1', { text: t('err.webgl') })));
    }

    const media = window.matchMedia('(min-width: 840px), (orientation: landscape) and (min-width: 620px)');
    const onMedia = (): void => {
      this.root.classList.toggle('wide', media.matches);
      this.panel.setWide(media.matches);
      this.syncLayout();
    };
    media.addEventListener('change', onMedia);
    onMedia();
    this.renderStatic();
  }

  /** (Re)builds everything that carries translated text. */
  private renderStatic(): void {
    document.title = t('app.name');
    const v = this.viewer;
    clear(this.toolbar);
    const button = (label: string, content: Node | string, onClick: () => void, pressed?: boolean): HTMLButtonElement => {
      const b = h('button', { class: 'tool', type: 'button', title: label, 'aria-label': label, onclick: onClick },
        typeof content === 'string' ? h('span', { class: 'tool-letter', text: content }) : content,
        h('span', { class: 'tool-cap', text: label }));
      if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
      return b;
    };
    const tools: (HTMLButtonElement | null)[] = [
      button(t('tb.open'), icon('open'), () => this.fileInput.click()),
      this.canPickFolder ? button(t('tb.folder'), icon('folder'), () => this.openFolder()) : null,
      button(t('tb.fit'), icon('fit'), () => v?.fitAll()),
      button(this.settings.ortho ? t('tb.ortho') : t('tb.persp'), icon(this.settings.ortho ? 'ortho' : 'persp'),
        () => this.updateSettings({ ortho: !this.settings.ortho })),
      button(t('tb.panel'), icon('layers'), () => this.panel.toggle()),
    ];
    for (const b of tools) if (b) this.toolbar.append(b);
    clear(this.empty);
    this.empty.append(
      h('h1', { text: t('empty.title') }),
      h('p', { text: t('empty.hint') }),
      h('button', { class: 'btn primary big', type: 'button', onclick: () => this.fileInput.click() }, icon('open'), t('empty.open')),
    );
    if (this.canPickFolder) {
      this.empty.append(h('button', { class: 'btn big', type: 'button', onclick: () => this.openFolder() }, icon('folder'), t('files.openFolder')));
    }
    // One tap back to the files that were open last time.
    const last = this.lastSession();
    if (last.length > 0) {
      this.empty.append(h('button', { class: 'btn big', type: 'button', onclick: () => this.enqueue(last.map((r) => ({ kind: 'stored' as const, name: r.name, size: r.size, store: r.store as string }))) },
        icon('file'), t('empty.resume', { n: last.length })));
    }
    this.syncPins();
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n as StringKey);
    if (v?.cube) {
      v.cube.labels = { top: t('cube.top'), bottom: t('cube.bottom'), north: t('letter.north'), south: t('letter.south'), east: t('letter.east'), west: t('letter.west') };
    }
    this.viewport.querySelector('.viewcube')?.setAttribute('aria-label', t('cube.label'));
    this.renderGridLabel();
    this.renderMeasure();
    this.panel.render();
    this.syncEmpty();
    v?.requestRender();
  }

  private applySettings(): void {
    const v = this.viewer;
    if (!v) return;
    v.gridEnabled = this.settings.grid;
    v.labelsEnabled = this.settings.labels;
    v.setOrtho(this.settings.ortho);
  }

  private updateSettings(patch: Partial<Settings>): void {
    const langChanged = patch.lang !== undefined && patch.lang !== this.settings.lang;
    this.settings = { ...this.settings, ...patch };
    store.saveSettings(this.settings);
    if (langChanged) setLang(this.settings.lang);
    this.applySettings();
    this.renderStatic();
  }

  private syncEmpty(): void {
    const none = !this.viewer || this.viewer.files.length === 0;
    this.empty.hidden = !none || !this.viewer;
  }

  private syncLayout(): void {
    // Keep floating elements above the bottom sheet on phones.
    this.viewport.style.setProperty('--sheet', this.panel.overlap() + 'px');
  }

  private renderGridLabel(): void {
    const s = this.gridStep;
    this.gridLabel.hidden = !(s > 0);
    if (!(s > 0)) return;
    const text = s >= 1000 ? fmt(s / 1000, 0) + ' ' + t('unit.km') : (s >= 1 ? fmt(s, 0) : String(s)) + ' ' + t('unit.m');
    this.gridLabel.textContent = t('grid.label', { n: text });
  }

  private handleBack(): boolean {
    if (!this.busy.hidden) { this.cancelLoading(); return true; }
    return this.panel.back();
  }

  // --- toasts ------------------------------------------------------------
  toast(message: string, kind: 'info' | 'error' = 'info'): void {
    const el = h('div', { class: 'toast ' + kind, role: kind === 'error' ? 'alert' : 'status' }, message);
    el.addEventListener('click', () => el.remove());
    this.toasts.append(el);
    while (this.toasts.children.length > 4) this.toasts.firstElementChild?.remove();
    window.setTimeout(() => el.remove(), kind === 'error' ? 9000 : 3500);
  }

  private errorText(code: LoadErrorCode): string {
    const key = 'err.' + code;
    return hasKey(key) ? t(key) : t('err.parseFailed');
  }

  // --- measurement -------------------------------------------------------
  private onPick(r: PickResult | null): void {
    if (!this.viewer || this.viewer.files.length === 0) return;
    this.noHit = r === null;
    if (r) {
      if (this.pickA && !this.pickB) this.pickB = r;
      else { this.pickA = r; this.pickB = null; }
    }
    this.viewer.setMarkers(this.pickA?.point ?? null, this.pickB?.point ?? null);
    this.renderMeasure();
  }

  private clearMeasure(): void {
    this.pickA = this.pickB = null;
    this.noHit = false;
    this.viewer?.setMarkers(null, null);
    this.renderMeasure();
  }

  private pointText(p: Vec3): string {
    return `X=${fmt(p[0])} Y=${fmt(p[1])} Z=${fmt(p[2])}`;
  }

  private measureText(): string {
    const a = this.pickA, b = this.pickB;
    if (!a) return '';
    const where = (p: PickResult): string => `${t('m.layer')}: ${p.layer}; ${t('m.file')}: ${p.file}`;
    if (!b) return `${this.pointText(a.point)}\n${where(a)}`;
    const m = measure(a.point, b.point);
    const u = t('unit.m');
    return [
      `1: ${this.pointText(a.point)} (${where(a)})`,
      `2: ${this.pointText(b.point)} (${where(b)})`,
      `${t('m.d3')}: ${fmt(m.d3)} ${u}`,
      `${t('m.dh')}: ${fmt(m.dh)} ${u}`,
      `${t('m.dz')}: ${fmt(m.dz)} ${u}`,
      `${t('m.az')}: ${fmt(m.azimuth, 1)}°`,
      `${t('m.dip')}: ${fmt(m.dip, 1)}°`,
    ].join('\n');
  }

  private renderMeasure(): void {
    const card = this.measureCard;
    clear(card);
    const a = this.pickA, b = this.pickB;
    if (!a) {
      card.hidden = !this.noHit;
      if (this.noHit) card.append(h('div', { class: 'm-hint', text: t('m.nothing') }));
      return;
    }
    card.hidden = false;
    const coords = (p: PickResult, n: string): HTMLElement =>
      h('div', { class: 'm-point' },
        h('span', { class: 'm-n', text: n }),
        h('div', { class: 'm-xyz' },
          h('span', null, h('i', { text: 'X' }), fmt(p.point[0])),
          h('span', null, h('i', { text: 'Y' }), fmt(p.point[1])),
          h('span', null, h('i', { text: 'Z' }), fmt(p.point[2]))),
        h('div', { class: 'm-meta', text: `${p.layer} · ${p.file} · ${t(('m.kind.' + p.kind) as StringKey)}` }));
    card.append(coords(a, b ? '1' : '•'));
    if (b) {
      card.append(coords(b, '2'));
      const m = measure(a.point, b.point);
      const u = ' ' + t('unit.m');
      const cell = (label: string, value: string): HTMLElement => h('div', { class: 'm-cell' }, h('i', { text: label }), h('b', { text: value }));
      card.append(h('div', { class: 'm-grid' },
        cell(t('m.d3'), fmt(m.d3) + u),
        cell(t('m.dh'), fmt(m.dh) + u),
        cell(t('m.dz'), fmt(m.dz) + u),
        cell(t('m.az'), fmt(m.azimuth, 1) + '°'),
        cell(t('m.dip'), fmt(m.dip, 1) + '°')));
    } else {
      card.append(h('div', { class: 'm-hint', text: t('m.hint') }));
    }
    const last = b ?? a;
    card.append(h('div', { class: 'm-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => void copyText(this.measureText()).then((ok) => this.toast(t(ok ? 'm.copied' : 'm.copyFailed'), ok ? 'info' : 'error')) }, icon('copy'), t('m.copy')),
      h('button', { class: 'btn', type: 'button', onclick: () => this.addNote(last) }, icon('note'), t('m.note')),
      h('button', { class: 'btn', type: 'button', onclick: () => this.viewer?.centerOn(last.point) }, icon('target'), t('m.center')),
      h('button', { class: 'btn', type: 'button', onclick: () => this.clearMeasure() }, icon('close'), t('m.clear'))));
  }

  // --- notes -------------------------------------------------------------
  private noteHeaders(): NoteHeaders {
    return { n: t('notes.col.n'), date: t('notes.col.date'), x: 'X', y: 'Y', z: 'Z', layer: t('notes.col.layer'), file: t('notes.col.file'), note: t('notes.col.note') };
  }

  private syncPins(): void {
    const pins: { p: Vec3; label: string }[] = [];
    this.notes.forEach((n, i) => { if (n.point) pins.push({ p: n.point, label: String(i + 1) }); });
    this.viewer?.setPins(pins);
  }

  private saveNotes(): void {
    store.saveNotes(this.notes);
    this.syncPins();
  }

  /** New note, tied to a picked point or general; opens it for typing. */
  private addNote(at: PickResult | null): void {
    const note: Note = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: Date.now(), text: '', point: at ? [...at.point] : null, layer: at?.layer ?? '', file: at?.file ?? '',
    };
    this.notes.push(note);
    this.saveNotes();
    this.panel.show('notes', note.id);
  }

  private updateNote(id: string, text: string): void {
    const n = this.notes.find((x) => x.id === id);
    if (!n) return;
    n.text = text;
    store.saveNotes(this.notes);
  }

  private deleteNote(id: string): void {
    this.notes = this.notes.filter((x) => x.id !== id);
    this.saveNotes();
    this.panel.render();
  }

  private async exportNotes(): Promise<void> {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const csv = notesToCsv(this.notes, this.noteHeaders(), this.settings.lang === 'ru' ? ';' : ',');
    const r = await exportTextFile(`notes-${stamp}.csv`, csv, 'text/csv');
    if (r === 'failed') this.toast(t('notes.exportFailed'), 'error');
    else if (r === 'downloaded') this.toast(t('notes.exported'));
  }

  // --- last session ------------------------------------------------------
  /** Recent entries of the files that were open last time and still have a stored copy. */
  private lastSession(): RecentFile[] {
    const recents = store.recents();
    return store.session().map((k) => recents.find((r) => r.key === k && r.store)).filter((r): r is RecentFile => !!r);
  }

  private saveSession(): void {
    store.saveSession([...this.keys.values()]);
  }

  // --- opening files -----------------------------------------------------
  openFiles(files: File[]): void {
    if (files.length === 0) return;
    this.enqueue(files.map((f) => ({ kind: 'file' as const, name: f.name, size: f.size, file: f })));
  }

  /** Opens every supported file of a folder, including sub-folders. */
  private openFolder(): void {
    if (isNative && platform === 'android') {
      void pickNativeFolder().then((r) => {
        if (r.cancelled) return;
        if (r.files.length === 0 && r.failed === 0) { this.toast(t('err.folderEmpty'), 'error'); return; }
        this.toast(t('info.folder', { n: r.files.length, m: r.skipped }));
        this.openNative(r.files, r.failed);
      }).catch(() => this.toast(t('err.readFailed'), 'error'));
    } else {
      this.folderInput.click();
    }
  }

  private openFolderFiles(all: File[]): void {
    if (all.length === 0) return;
    const files = all.filter((f) => formatFromName(f.name) !== null).sort((a, b) => a.name.localeCompare(b.name));
    if (files.length === 0) { this.toast(t('err.folderEmpty'), 'error'); return; }
    this.toast(t('info.folder', { n: files.length, m: all.length - files.length }));
    this.openFiles(files);
  }

  private openNative(files: IncomingFile[], failed: number): void {
    if (failed > 0) this.toast(t('err.intake', { n: failed }), 'error');
    this.enqueue(files.map((f) => ({ kind: 'native' as const, name: f.name, size: f.size, path: f.path, nativePath: f.path })));
  }

  private async openRecent(r: RecentFile): Promise<void> {
    if (!r.store || !(await storedExists(r.store))) {
      this.toast(t('err.withFile', { name: r.name, msg: t('err.storedMissing') }), 'error');
      this.fileInput.click();
      return;
    }
    this.enqueue([{ kind: 'stored', name: r.name, size: r.size, store: r.store }]);
  }

  private enqueue(items: QueueItem[]): void {
    if (items.length === 0 || !this.viewer) return;
    this.queue.push(...items);
    this.queueTotal += items.length;
    if (!this.current) void this.pump();
  }

  private cancelLoading(): void {
    const rest = this.queue.splice(0);
    void releaseNative(rest.map((q) => q.nativePath).filter((p): p is string => !!p));
    this.current?.cancel();
  }

  private async pump(): Promise<void> {
    const viewer = this.viewer;
    if (!viewer) return;
    let lastLoaded: ViewFile | null = null;
    while (this.queue.length > 0) {
      const item = this.queue.shift() as QueueItem;
      this.queueDone++;
      const key = fileKey(item.name, item.size);
      const keep = this.settings.keepCopies && privateStorageAvailable() && formatFromName(item.name) !== null;
      const storeAs = item.kind === 'stored' ? null : keep ? storeName(key) : null;
      this.showBusy(item.name, 'read', 0);
      try {
        this.current = loadModel(item, storeAs, (phase, f) => this.showBusy(item.name, phase, f));
        const { model, stored } = await this.current.result;
        // Opening the same file again replaces the previous copy.
        for (const [file, k] of [...this.keys]) if (k === key) this.closeFile(file, false);
        const file = viewer.addFile('f' + this.nextId++, item.name, model, store.layerSettings(key));
        this.keys.set(file, key);
        lastLoaded = file;
        store.touchRecent({
          key, name: item.name, size: item.size, ts: Date.now(),
          store: item.kind === 'stored' ? item.store : stored ? storeAs : null,
        });
        const d = model.diagnostics;
        if (!d.bbox) this.toast(t('err.noGeometry', { name: item.name }), 'error');
        else if (d.warnings.length > 0) this.toast(t('info.warnings', { name: item.name, n: d.warnings.length }));
      } catch (err) {
        const e = err instanceof LoadError ? err : new LoadError('parseFailed', String(err));
        if (e.code === 'cancelled') this.toast(t('err.cancelled'));
        else this.toast(t('err.withFile', { name: item.name, msg: this.errorText(e.code) }), 'error');
      } finally {
        this.current = null;
        if (item.nativePath) void releaseNative([item.nativePath]);
      }
      this.syncEmpty();
      this.panel.render();
    }
    this.queueTotal = this.queueDone = 0;
    this.busy.hidden = true;
    this.saveSession();
    // Several files at once: frame them together.
    if (lastLoaded && viewer.files.length > 1) viewer.fitAll();
    if (viewer.files.some((f) => !f.diagnostics.bbox)) this.panel.show('diag');
  }

  private showBusy(name: string, phase: 'read' | 'index', fraction: number): void {
    this.busy.hidden = false;
    this.busyTitle.textContent = name;
    const multi = this.queueTotal > 1 ? t('busy.of', { i: this.queueDone, n: this.queueTotal }) + ' · ' : '';
    this.busyPhase.textContent = `${multi}${t(phase === 'read' ? 'busy.read' : 'busy.index')} ${Math.round(fraction * 100)}%`;
    this.busyBar.style.width = (fraction * 100).toFixed(1) + '%';
  }

  private closeFile(file: ViewFile, rerender = true): void {
    this.keys.delete(file);
    this.viewer?.removeFile(file);
    if (this.pickA?.file === file.name || this.pickB?.file === file.name || this.viewer?.files.length === 0) this.clearMeasure();
    if (rerender) {
      this.saveSession();
      this.syncEmpty();
      this.panel.render();
    }
  }

  private persistLayers(file: ViewFile): void {
    const key = this.keys.get(file);
    if (!key) return;
    const out: Record<string, LayerSettings> = {};
    for (const l of file.layers as ViewLayer[]) out[l.name] = { v: l.visible, c: l.customColor, o: l.opacity };
    store.saveLayerSettings(key, out);
  }

  // --- web / PWA file sources ---------------------------------------------
  private setupWebFileHandling(): void {
    if (isNative) return;
    // Installed PWA on desktop / ChromeOS: "Open with".
    const lq = (window as unknown as { launchQueue?: { setConsumer(cb: (p: { files?: { getFile(): Promise<File> }[] }) => void): void } }).launchQueue;
    lq?.setConsumer((params) => {
      void Promise.all((params.files ?? []).map((fh) => fh.getFile())).then((files) => this.openFiles(files)).catch(() => undefined);
    });
    // Drag and drop on desktop browsers.
    let depth = 0;
    const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; this.root.classList.add('dropping'); e.preventDefault(); } });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; this.root.classList.remove('dropping'); } });
    window.addEventListener('drop', (e) => {
      depth = 0;
      this.root.classList.remove('dropping');
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.openFiles([...(e.dataTransfer?.files ?? [])]);
    });
  }

  get language(): string {
    return getLang();
  }
}
