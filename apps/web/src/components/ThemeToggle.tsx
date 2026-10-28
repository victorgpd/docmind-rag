'use client';

import { useTheme } from '../theme/ThemeProvider';
import { MoonIcon, SunIcon } from './icons';

export function ThemeToggle() {
  const { dark, toggle } = useTheme();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={dark}
      aria-label={dark ? 'Tema claro' : 'Tema escuro'}
      title={dark ? 'Tema claro' : 'Tema escuro'}
      className="inline-flex size-9 items-center justify-center rounded-lg border border-line bg-surface text-muted transition duration-150 hover:bg-subtle hover:text-fg"
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
