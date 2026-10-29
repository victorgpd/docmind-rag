import './globals.css';
import { cookies } from 'next/headers';
import type { Viewport } from 'next';
import type { ReactNode } from 'react';
import { AuthProvider } from '../src/lib/auth';
import { ThemeProvider, themeInitScript } from '../src/theme/ThemeProvider';

export const metadata = { title: 'DocMind' };

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f7fb' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0d14' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // cookie de tema lido no servidor: o antd (CSS-in-JS) renderiza no tema certo, sem flash
  const saved = (await cookies()).get('docmind_theme')?.value;
  const initialDark = saved === 'dark' ? true : saved === 'light' ? false : undefined;
  return (
    <html lang="pt-BR" className={initialDark ? 'dark' : undefined} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen bg-bg text-fg">
        <ThemeProvider initialDark={initialDark}>
          <AuthProvider>
            {children}
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
