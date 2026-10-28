import type { ReactNode } from 'react';
import { AntdShell } from '../../src/components/AntdShell';

// Só a área autenticada paga o antd; /login e /register ficam fora deste grupo.
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AntdShell>{children}</AntdShell>;
}
