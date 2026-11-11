/** Tiny DOM helpers; the UI is plain DOM to keep the bundle small. */

type Attrs = Record<string, string | number | boolean | undefined | ((ev: Event) => void)>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v === undefined || v === false) continue;
      if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
      else if (k === 'class') el.className = String(v);
      else if (k === 'text') el.textContent = String(v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const PATHS: Record<string, string> = {
  open: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  plan: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 8v8M9 11l3-3 3 3"/>',
  persp: '<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8"/>',
  ortho: '<rect x="4" y="8" width="12" height="12"/><path d="M4 8l4-4h12v12l-4 4M16 8l4-4"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12l9 5 9-5M3 16l9 5 9-5"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.2A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.3 4M6.5 6.6A17 17 0 0 0 2 12s4 7 10 7a10 10 0 0 0 4.2-.9M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  zoom: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5M8 11h6M11 8v6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  target: '<circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
};

export function icon(name: keyof typeof PATHS | string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = PATHS[name] ?? '';
  return svg;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Fixed two decimals, no thousands separators, never "-0.00". */
export function fmt(n: number, digits = 2): string {
  const s = n.toFixed(digits);
  return /^-0\.?0*$/.test(s) ? s.slice(1) : s;
}

export function fmtBytes(n: number): string {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' kB';
  return n + ' B';
}

export function fmtCount(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = h('textarea', { class: 'offscreen', readonly: true });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
