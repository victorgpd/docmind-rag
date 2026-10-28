import { theme, type ThemeConfig } from 'antd';

// Tokens de docs/DESIGN.md mapeados para o antd: neutros + UM acento, raio 8, sem sombras (so overlays).
const SYSTEM_FONT = '"Inter Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const palette = {
  light: { bg: '#f6f7fb', surface: '#ffffff', subtle: '#eef0f7', fg: '#12141c', muted: '#5b6173', line: '#e3e6ef', control: '#7c8296', primary: '#4f46e5', link: '#4f46e5' },
  dark: { bg: '#0b0d14', surface: '#12151f', subtle: '#1a1e2b', fg: '#eceef6', muted: '#9aa1b5', line: '#232838', control: '#6b7288', primary: '#5a5ee8', link: '#a5b0ff' },
};

/** Botao primario: texto branco sobre o acento (>= 4.5:1 nos dois temas); `link` e o acento legivel como texto. */
export function buildTheme(dark: boolean): ThemeConfig {
  const p = palette[dark ? 'dark' : 'light'];
  return {
    hashed: false, // antd 6 ja usa cssVar: sem hash nas classes, CSS menor
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: p.primary,
      colorLink: p.link,
      colorLinkHover: p.link,
      colorBgBase: p.surface,
      colorBgLayout: p.bg,
      colorBgContainer: p.surface,
      colorBgElevated: p.surface,
      colorTextBase: p.fg,
      colorTextHeading: p.fg,
      colorTextSecondary: p.muted,
      colorBorder: p.control, // bordas de campos: 3:1 (WCAG 1.4.11)
      colorBorderSecondary: p.line,
      colorSplit: p.line,
      colorFillAlter: p.subtle,
      borderRadius: 8,
      borderRadiusLG: 12,
      fontFamily: SYSTEM_FONT,
      fontSize: 14,
      controlHeight: 36,
      boxShadow: 'none',
      boxShadowSecondary: '0 6px 24px rgba(0, 0, 0, 0.08)', // so overlays (modal, popconfirm, drawer)
    },
    components: {
      Button: { primaryShadow: 'none', defaultShadow: 'none', dangerShadow: 'none', fontWeight: 500 },
      Layout: { siderBg: p.bg, headerBg: p.bg, bodyBg: p.bg, headerPadding: '0 16px', headerHeight: 52 },
      Menu: { itemBg: 'transparent', itemSelectedBg: p.subtle, itemSelectedColor: p.fg, itemHoverBg: p.subtle, itemBorderRadius: 6 },
    },
  };
}
