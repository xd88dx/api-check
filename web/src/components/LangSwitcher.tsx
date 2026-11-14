import { useTranslation } from 'react-i18next';
import { persistLang, type Lang } from '../i18n';

export default function LangSwitcher() {
  const { i18n, t } = useTranslation();
  const current = (i18n.language === 'en' ? 'en' : 'zh') as Lang;
  const change = (lang: Lang) => {
    void i18n.changeLanguage(lang);
    persistLang(lang);
  };
  return (
    <label className="lang-switch" aria-label={t('app.lang')}>
      <button
        type="button"
        className={current === 'zh' ? 'active' : ''}
        onClick={() => change('zh')}
      >
        中文
      </button>
      <button
        type="button"
        className={current === 'en' ? 'active' : ''}
        onClick={() => change('en')}
      >
        EN
      </button>
    </label>
  );
}
