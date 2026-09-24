import type { Metadata, MetadataRoute, Viewport, ResolvingMetadata, NextConfig } from 'rustyx';
export const metadata: Metadata = {
  metadataBase: new URL('https://example.com'), title: { default: 'Site', template: '%s | Site' },
  verification: { google: ['one', 'two'] }, openGraph: { type: 'article', authors: ['Me'], images: [{ url: '/cover.jpg', width: 800 }] },
  twitter: { card: 'player', players: { playerUrl: 'https://example.com', streamUrl: 'https://example.com/stream', width: 640, height: 360 } },
  appLinks: { web: { url: 'https://example.com', should_fallback: false } },
};
export const viewport: Viewport = { width: 'device-width', themeColor: [{ color: 'black', media: '(prefers-color-scheme: dark)' }] };
export async function generateMetadata(_props: unknown, parent: ResolvingMetadata): Promise<Metadata> {
  return { openGraph: { images: [...((await parent).openGraph?.images || []), '/cover.jpg'] } };
}
export const robots: MetadataRoute.Robots = { rules: [{ userAgent: '*', allow: '/', disallow: ['/private'] }], sitemap: 'https://example.com/sitemap.xml' };
export const sitemap: MetadataRoute.Sitemap = [{ url: 'https://example.com', lastModified: new Date(), priority: 0.5, alternates: { languages: { fr: 'https://example.com/fr' } } }];
export const manifest: MetadataRoute.Manifest = { name: 'App', start_url: '/', display: 'standalone' };
export const config: NextConfig = { transpilePackages: ['widget'], serverExternalPackages: ['native-loader'] };
