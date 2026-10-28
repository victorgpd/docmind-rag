'use client';

import { AntdRegistry } from '@ant-design/nextjs-registry';
import { ConfigProvider } from 'antd';
import type { ReactNode } from 'react';
import { buildTheme } from '../theme/antd';
import { useTheme } from '../theme/ThemeProvider';
import { Shell } from './Shell';

export function AntdShell({ children }: { children: ReactNode }) {
  const { dark } = useTheme();
  return (
    <AntdRegistry>
      <ConfigProvider theme={buildTheme(dark)}>
        <Shell>{children}</Shell>
      </ConfigProvider>
    </AntdRegistry>
  );
}
