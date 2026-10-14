import React from 'react';
import ReactDOM from 'react-dom/client';
import { FluentProvider } from '@fluentui/react-components';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { darkTheme, lightTheme } from './theme';
import { ThemeModeProvider, useThemeMode } from './ThemeMode';
import { AuthProvider } from './auth';
import { BrandThemeProvider } from './BrandTheme';
import { App } from './App';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

function Themed() {
  const { resolved } = useThemeMode();
  return (
    <FluentProvider theme={resolved === 'dark' ? darkTheme : lightTheme} style={{ minHeight: '100vh' }}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <BrandThemeProvider>
              <App />
            </BrandThemeProvider>
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </FluentProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeModeProvider>
      <Themed />
    </ThemeModeProvider>
  </React.StrictMode>,
);
