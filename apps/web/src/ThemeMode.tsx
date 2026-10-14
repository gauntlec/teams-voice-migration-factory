import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Light, dark, or follow the computer. The choice is remembered in this browser; "system" (the default) follows the operating system and
 * changes live when it does. `resolved` is what is actually showing.
 */
export type ThemeMode = 'system' | 'light' | 'dark';

const KEY = 'voxshift.theme';

interface ThemeModeValue {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  setMode: (m: ThemeMode) => void;
}

const Ctx = createContext<ThemeModeValue>({ mode: 'system', resolved: 'light', setMode: () => {} });
export const useThemeMode = () => useContext(Ctx);

function readMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

const query = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null);

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readMode);
  const [systemDark, setSystemDark] = useState(() => query()?.matches ?? false);

  useEffect(() => {
    const mq = query();
    if (!mq) return;
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const resolved: 'light' | 'dark' = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

  // Native controls (scrollbars, form fields, the overscroll area) follow the chosen theme too.
  useEffect(() => {
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);

  const value = useMemo<ThemeModeValue>(
    () => ({
      mode,
      resolved,
      setMode: (m) => {
        setModeState(m);
        try {
          localStorage.setItem(KEY, m);
        } catch {
          /* storage blocked: the choice lasts until reload */
        }
      },
    }),
    [mode, resolved],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
