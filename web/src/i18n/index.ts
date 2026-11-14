import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zh from './zh';
import en from './en';

export type Lang = 'zh' | 'en';

const LANG_KEY = 'api-check.lang';

/** localStorage 持久化 → 浏览器语言 → zh */
export function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
    const langs = navigator.languages ?? [navigator.language];
    if (langs.some((l) => l.toLowerCase().startsWith('zh'))) return 'zh';
    if (navigator.language) return 'en';
  } catch {
    // 环境异常时回退
  }
  return 'zh';
}

export function persistLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // 忽略
  }
}

i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
  },
  lng: detectLang(),
  fallbackLng: 'zh',
  interpolation: { escapeValue: false },
});

export default i18n;
