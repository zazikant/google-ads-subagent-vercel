import './globals.css';
import type { Metadata } from 'next';
import Home from './page';

export const metadata: Metadata = {
  title: 'Google Ads AI Subagent',
  description:
    'Three-stage AI subagent pipeline that turns a product description into Google Ads copy that actually passes compliance.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children ?? <Home />}</body>
    </html>
  );
}
