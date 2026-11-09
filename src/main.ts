import './styles.css';
import { Capacitor } from '@capacitor/core';
import { App } from './ui/app';
import { setLang, t } from './i18n';
import { store } from './platform/storage';

/** Last-resort screen: any unexpected error ends up here, never on a blank page. */
function fatal(detail: string): void {
  const root = document.getElementById('app');
  if (!root || root.querySelector('.fatal')) return;
  const box = document.createElement('div');
  box.className = 'fatal';
  const title = document.createElement('h1');
  title.textContent = t('err.fatalTitle');
  const text = document.createElement('pre');
  text.textContent = detail;
  const again = document.createElement('button');
  again.className = 'btn primary big';
  again.type = 'button';
  again.textContent = t('err.fatalReload');
  again.addEventListener('click', () => location.reload());
  box.append(title, text, again);
  root.append(box);
}

let started = false;
window.addEventListener('error', (e) => {
  // After a successful start, errors are local to one action; do not cover the model.
  if (!started) fatal(e.message || String(e.error));
});
window.addEventListener('unhandledrejection', (e) => {
  if (!started) fatal(e.reason instanceof Error ? e.reason.message : String(e.reason));
});

try {
  setLang(store.loadSettings().lang);
  const root = document.getElementById('app');
  if (!root) throw new Error('#app missing');
  const app = new App(root);
  started = true;
  // Handy for automated UI tests; carries no data.
  (window as unknown as { __app: App }).__app = app;
} catch (err) {
  fatal(err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
}

// Offline support for the browser / installed PWA. The native shells ship the
// files inside the app and do not need a service worker.
if (import.meta.env.PROD && 'serviceWorker' in navigator && !Capacitor.isNativePlatform()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}
