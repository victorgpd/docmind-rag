import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'DocMind',
    short_name: 'DocMind',
    description: 'Pergunte aos seus documentos, com fontes.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f6f7fb',
    theme_color: '#4f46e5',
    lang: 'pt-BR',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
