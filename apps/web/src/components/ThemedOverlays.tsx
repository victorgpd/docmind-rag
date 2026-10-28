'use client';

import { ConfigProvider, Drawer, Modal } from 'antd';
import type { ComponentProps } from 'react';
import { buildTheme } from '../theme/antd';

// So estes dois componentes usam antd; ficam num chunk que baixa no primeiro clique (next/dynamic).
// Montados apos interacao do usuario (client-only): ler a classe `dark` do <html> aqui e seguro.
const dark = () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

export function ThemedModal(props: ComponentProps<typeof Modal>) {
  return (
    <ConfigProvider theme={buildTheme(dark())}>
      <Modal {...props} />
    </ConfigProvider>
  );
}

export function ThemedDrawer(props: ComponentProps<typeof Drawer>) {
  return (
    <ConfigProvider theme={buildTheme(dark())}>
      <Drawer {...props} />
    </ConfigProvider>
  );
}
