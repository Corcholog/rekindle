// Dark and light themes: follow the system unless the person picks one (stored per browser).
export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'rekindle.theme';

export function storedTheme(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice) {
  const prefersDark = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = choice === 'dark' || (choice === 'system' && prefersDark);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

export function saveTheme(choice: ThemeChoice) {
  try {
    if (choice === 'system') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, choice);
  } catch {
    // Private mode: the choice lasts for this page only
  }
  applyTheme(choice);
}
