import type { ReactNode } from 'react';

// Ícones SVG inline (mesmo traço do icons.tsx do app) só para o chat; decorativos, o nome acessível vem do texto.
function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}
type P = { size?: number };

export const SendIcon = (p: P) => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);
export const StopIcon = (p: P) => (
  <Svg {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Svg>
);
export const UserIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
  </Svg>
);
export const ThumbUpIcon = (p: P) => (
  <Svg {...p}>
    <path d="M7 11v9H4v-9zM7 11l4-8c1.7 0 2.5 1.2 2 3l-.6 2H19a2 2 0 0 1 2 2.4l-1.3 6A2 2 0 0 1 17.7 20H7" />
  </Svg>
);
export const ThumbDownIcon = (p: P) => (
  <Svg {...p}>
    <path d="M17 13V4h3v9zM17 13l-4 8c-1.7 0-2.5-1.2-2-3l.6-2H5a2 2 0 0 1-2-2.4l1.3-6A2 2 0 0 1 6.3 4H17" />
  </Svg>
);
export const CopyIcon = (p: P) => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </Svg>
);
export const CheckIcon = (p: P) => (
  <Svg {...p}>
    <path d="m5 12 5 5 9-10" />
  </Svg>
);
export const CrossIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const ToolIcon = (p: P) => (
  <Svg {...p}>
    <path d="M14.7 6.3a4 4 0 0 0-5 5L3 18l3 3 6.7-6.7a4 4 0 0 0 5-5l-2.4 2.4-2.6-.6-.6-2.6z" />
  </Svg>
);

/** Avatar do assistente: quadrado com o gradiente da marca e a faísca. */
export function AssistantAvatar() {
  return (
    <span aria-hidden="true" className="bg-grad grid size-8 shrink-0 place-items-center rounded-[10px] text-white">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />
      </svg>
    </span>
  );
}
