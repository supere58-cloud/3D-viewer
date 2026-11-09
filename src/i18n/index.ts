/** UI strings. Russian is the default; every string lives in the JSON resources. */
import ru from './ru.json';
import en from './en.json';

export type Lang = 'ru' | 'en';
export type StringKey = keyof typeof ru;

const tables: Record<Lang, Record<string, string>> = { ru, en };
let current: Lang = 'ru';

export function setLang(lang: Lang): void {
  current = lang;
  document.documentElement.lang = lang;
}

export function getLang(): Lang {
  return current;
}

export function t(key: StringKey, params?: Record<string, string | number>): string {
  let s = tables[current][key] ?? tables.ru[key] ?? key;
  if (params) for (const k of Object.keys(params)) s = s.replace('{' + k + '}', String(params[k]));
  return s;
}

/** True when the key exists (used for codes that come from data). */
export function hasKey(key: string): key is StringKey {
  return key in tables.ru;
}
