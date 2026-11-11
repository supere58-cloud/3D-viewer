/**
 * Guided walkthrough: a card with a short text per step and a ring around
 * the control it talks about. Steps may run an action so the feature is
 * shown on the model, not only described.
 */
import { t, type StringKey } from '../i18n';
import { clear, h } from './dom';

export interface TourStep {
  /** Texts are tour.<key>.title and tour.<key>.text in the string resources. */
  key: string;
  /** CSS selector of the element to ring. */
  target?: string;
  /** Runs when the step is shown; may load things or switch tabs. */
  enter?: () => void | Promise<void>;
}

export class Tour {
  private card: HTMLElement;
  private ring: HTMLElement;
  private index = 0;
  private running = false;
  private token = 0;
  private onResize = (): void => this.place();

  constructor(private root: HTMLElement, private steps: TourStep[], private onEnd: (completed: boolean) => void) {
    this.card = h('div', { class: 'tour', role: 'dialog', 'aria-live': 'polite' });
    this.ring = h('div', { class: 'tour-ring', hidden: true });
  }

  get active(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.index = 0;
    this.root.append(this.ring, this.card);
    window.addEventListener('resize', this.onResize);
    void this.show();
  }

  stop(completed: boolean): void {
    if (!this.running) return;
    this.running = false;
    this.token++;
    window.removeEventListener('resize', this.onResize);
    this.card.remove();
    this.ring.remove();
    this.onEnd(completed);
  }

  private async show(): Promise<void> {
    const step = this.steps[this.index];
    const token = ++this.token;
    this.render(step, true);
    try {
      await step.enter?.();
    } catch {
      /* a step that cannot show its example still explains itself */
    }
    if (token !== this.token) return;
    this.render(step, false);
    // Panels animate into place; position the ring once they have settled.
    this.place();
    window.setTimeout(() => { if (token === this.token) this.place(); }, 320);
  }

  private render(step: TourStep, busy: boolean): void {
    clear(this.card);
    const last = this.index === this.steps.length - 1;
    const go = (delta: number): void => {
      this.index = Math.max(0, Math.min(this.steps.length - 1, this.index + delta));
      void this.show();
    };
    const next = h('button', { class: 'btn primary tour-next', type: 'button', onclick: () => (last ? this.stop(true) : go(1)) },
      t(last ? 'tour.done' : this.index === 0 ? 'tour.start' : 'tour.next'));
    if (busy) next.setAttribute('disabled', '');
    this.card.append(
      h('div', { class: 'tour-count', text: `${this.index + 1} / ${this.steps.length}` }),
      h('h2', { text: t(`tour.${step.key}.title` as StringKey) }),
      ...t(`tour.${step.key}.text` as StringKey).split('\n').map((line) => h('p', { text: line })),
      h('div', { class: 'tour-actions' },
        last ? null : h('button', { class: 'btn tour-skip', type: 'button', onclick: () => this.stop(false) }, t('tour.skip')),
        this.index > 0 ? h('button', { class: 'btn tour-back', type: 'button', onclick: () => go(-1) }, t('tour.back')) : null,
        next));
  }

  private place(): void {
    if (!this.running) return;
    const step = this.steps[this.index];
    const el = step.target ? this.root.querySelector<HTMLElement>(step.target) : null;
    const rect = el && !el.hidden ? el.getBoundingClientRect() : null;
    const host = this.root.getBoundingClientRect();
    if (rect && rect.width > 0 && rect.height > 0) {
      this.ring.hidden = false;
      this.ring.style.left = rect.left - host.left - 4 + 'px';
      this.ring.style.top = rect.top - host.top - 4 + 'px';
      this.ring.style.width = rect.width + 8 + 'px';
      this.ring.style.height = rect.height + 8 + 'px';
    } else {
      this.ring.hidden = true;
    }
    // Keep the card away from what it points at.
    const targetLow = rect ? rect.top + rect.height / 2 > host.top + host.height / 2 : false;
    this.card.classList.toggle('top', targetLow);
    this.card.classList.toggle('center', !rect);
  }
}
