import localFont from 'next/font/local';

/** JetBrains Mono, self-hosted so the operator UI looks the same on every machine (OFL, see OFL.txt). */
export const jetbrainsMono = localFont({
  src: [
    { path: './JetBrainsMono-Regular.woff2', weight: '400', style: 'normal' },
    { path: './JetBrainsMono-Bold.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-jetbrains',
  display: 'swap',
  fallback: ['Fira Code', 'Cascadia Code', 'SFMono-Regular', 'Consolas', 'monospace'],
});
