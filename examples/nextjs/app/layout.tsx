import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'steel-webgpu: Next.js',
  icons: 'data:,',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, height: '100vh', overflow: 'hidden', background: '#1d2125', color: '#e8e8e8', fontFamily: 'system-ui, sans-serif' }}>
        {children}
      </body>
    </html>
  );
}
