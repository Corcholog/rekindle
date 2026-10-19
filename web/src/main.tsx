import { createRoot } from 'react-dom/client';
import '@fontsource-variable/literata';
import '@fontsource-variable/hanken-grotesk';
import './styles.css';
import { App } from './App';
import { I18nProvider, storedLanguage, type Language } from './i18n';
import { applyTheme, storedTheme } from './lib/theme';

// Language: this browser's choice, else the server's LANGUAGE preset, else Spanish
async function initialLanguage(): Promise<Language> {
  const stored = storedLanguage();
  if (stored) return stored;
  try {
    const res = await fetch('/api/settings/language');
    if (res.ok) {
      const data = await res.json();
      if (data.preset === 'en' || data.preset === 'es') return data.preset;
    }
  } catch {
    // Offline or older server: keep the default
  }
  return 'es';
}

async function start() {
  applyTheme(storedTheme());
  const lang = await initialLanguage();
  createRoot(document.getElementById('root')!).render(
    <I18nProvider initial={lang}>
      <App />
    </I18nProvider>,
  );
}

start();
