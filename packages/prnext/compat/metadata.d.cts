type OneOrMany<T> = T | T[];
type Url = string | URL;
type Title = string | { default: string; template: string; absolute?: string } | { absolute: string; template?: string };
type UrlDescriptor = { url: Url; title?: string };
type Image = Url | { url: Url; secureUrl?: Url; width?: string | number; height?: string | number; alt?: string; type?: string };
type Robots = { index?: boolean; follow?: boolean; noarchive?: boolean; nosnippet?: boolean; noimageindex?: boolean; nocache?: boolean; notranslate?: boolean; indexifembedded?: boolean; nositelinkssearchbox?: boolean; unavailable_after?: string; 'max-video-preview'?: number; 'max-image-preview'?: 'none' | 'standard' | 'large'; 'max-snippet'?: number };
type Icon = Url | { url: Url; rel?: string; sizes?: string; type?: string; media?: string; color?: string; fetchPriority?: 'high' | 'low' | 'auto' };
type Social = { title?: Title; description?: string; images?: OneOrMany<Image> };
type OpenGraph = Social & {
  type?: 'website' | 'article' | 'book' | 'profile' | 'music.song' | 'music.album' | 'music.playlist' | 'music.radio_station' | 'video.movie' | 'video.episode' | 'video.tv_show' | 'video.other';
  url?: Url; siteName?: string; locale?: string; countryName?: string; determiner?: string; ttl?: number;
  emails?: OneOrMany<string>; phoneNumbers?: OneOrMany<string>; faxNumbers?: OneOrMany<string>; alternateLocale?: OneOrMany<string>;
  audio?: OneOrMany<Url | { url: Url; secureUrl?: Url; type?: string }>; videos?: OneOrMany<Image>;
  publishedTime?: string; modifiedTime?: string; expirationTime?: string; authors?: OneOrMany<string>; section?: string; tags?: OneOrMany<string>;
  isbn?: string; releaseDate?: string; firstName?: string; lastName?: string; username?: string; gender?: string;
  duration?: number; albums?: OneOrMany<Url | { url: Url; disc?: number; track?: number }>; songs?: OneOrMany<Url | { url: Url; disc?: number; track?: number }>;
  musicians?: OneOrMany<string>; creators?: OneOrMany<string>; actors?: OneOrMany<Url | { url: Url; role?: string }>; directors?: OneOrMany<string>; writers?: OneOrMany<string>; series?: Url;
};
type Twitter = Social & {
  card?: 'summary' | 'summary_large_image' | 'player' | 'app'; site?: string; siteId?: string; creator?: string; creatorId?: string;
  players?: OneOrMany<{ playerUrl: string; streamUrl: string; width: number; height: number }>;
  app?: { name?: string; id: { iphone?: string | number; ipad?: string | number; googleplay?: string }; url?: { iphone?: string; ipad?: string; googleplay?: string } };
};
export interface Viewport {
  width?: string | number; height?: string | number; initialScale?: number; minimumScale?: number; maximumScale?: number; userScalable?: boolean;
  viewportFit?: 'auto' | 'cover' | 'contain'; interactiveWidget?: 'resizes-visual' | 'resizes-content' | 'overlays-content';
  themeColor?: string | Array<{ color: string; media?: string }> | null;
  colorScheme?: string | null;
}
export interface Metadata {
  metadataBase?: URL | null; title?: Title | null; description?: string | null; applicationName?: string | null; generator?: string | null;
  referrer?: string | null; keywords?: OneOrMany<string> | null; authors?: OneOrMany<{ name?: string; url?: Url }> | null;
  creator?: string | null; publisher?: string | null; category?: string | null; abstract?: string | null; classification?: string | null;
  manifest?: Url | null; robots?: string | (Robots & { googleBot?: string | Robots }) | null;
  alternates?: { canonical?: Url | UrlDescriptor | null; languages?: Record<string, Url | UrlDescriptor[]> | null; media?: Record<string, Url | UrlDescriptor[]> | null; types?: Record<string, Url | UrlDescriptor[]> | null } | null;
  icons?: OneOrMany<Icon> | { icon?: OneOrMany<Icon>; shortcut?: OneOrMany<Icon>; apple?: OneOrMany<Icon>; other?: OneOrMany<Icon> } | null;
  openGraph?: OpenGraph | null; twitter?: Twitter | null;
  verification?: { google?: OneOrMany<string | number>; yahoo?: OneOrMany<string | number>; yandex?: OneOrMany<string | number>; me?: OneOrMany<string | number>; other?: Record<string, OneOrMany<string | number>> };
  appleWebApp?: boolean | { capable?: boolean; title?: string; statusBarStyle?: 'default' | 'black' | 'black-translucent'; startupImage?: OneOrMany<Url | { url: Url; media?: string }> } | null;
  formatDetection?: { telephone?: boolean; date?: boolean; address?: boolean; email?: boolean; url?: boolean } | null;
  itunes?: { appId: string; appArgument?: string } | null;
  facebook?: { appId?: string; admins?: OneOrMany<string> } | null; pinterest?: { richPin: boolean };
  archives?: OneOrMany<string> | null; assets?: OneOrMany<string> | null; bookmarks?: OneOrMany<string> | null; pagination?: { previous?: Url | null; next?: Url | null };
  appLinks?: {
    ios?: OneOrMany<{ url: Url; app_store_id?: string | number; app_name?: string }>; iphone?: OneOrMany<{ url: Url; app_store_id?: string | number; app_name?: string }>; ipad?: OneOrMany<{ url: Url; app_store_id?: string | number; app_name?: string }>;
    android?: OneOrMany<{ package: string; url?: Url; class?: string; app_name?: string }>;
    windows_phone?: OneOrMany<{ url: Url; app_id?: string; app_name?: string }>; windows?: OneOrMany<{ url: Url; app_id?: string; app_name?: string }>; windows_universal?: OneOrMany<{ url: Url; app_id?: string; app_name?: string }>;
    web?: OneOrMany<{ url: Url; should_fallback?: boolean }>;
  } | null;
  other?: Record<string, OneOrMany<string | number>>;
}
export type ResolvingMetadata = Promise<Omit<Metadata, 'title' | 'openGraph' | 'twitter' | 'metadataBase'> & {
  title: { absolute: string; template: string | null } | null;
  metadataBase?: string | null;
  openGraph?: Omit<OpenGraph, 'images' | 'title'> & { images?: Exclude<Image, Url>[]; title?: { absolute: string; template: string | null } } | null;
  twitter?: Omit<Twitter, 'images' | 'title'> & { images?: Exclude<Image, Url>[]; title?: { absolute: string; template: string | null } } | null;
}>;
export type ResolvingViewport = Promise<Viewport>;
export namespace MetadataRoute {
  type Robots = {
    rules: OneOrMany<{ userAgent?: OneOrMany<string>; allow?: OneOrMany<string>; disallow?: OneOrMany<string>; crawlDelay?: number; other?: Record<string, OneOrMany<string> | null> }>;
    sitemap?: OneOrMany<string>; host?: string;
  };
  type Sitemap = Array<{
    url: string; lastModified?: string | Date; changeFrequency?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never'; priority?: number;
    alternates?: { languages?: Record<string, string> }; images?: string[];
    videos?: Array<{ title: string; thumbnail_loc: string; description: string; content_loc?: string; player_loc?: string; duration?: number; view_count?: number; tag?: string; rating?: number; expiration_date?: string; publication_date?: string; family_friendly?: 'yes' | 'no'; requires_subscription?: 'yes' | 'no'; live?: 'yes' | 'no'; restriction?: { relationship: 'allow' | 'deny'; content: string }; platform?: { relationship: 'allow' | 'deny'; content: string }; uploader?: { content: string; info?: string } }>;
  }>;
  interface Manifest {
    name?: string; short_name?: string; description?: string; id?: string; start_url?: string; scope?: string; lang?: string; dir?: 'auto' | 'ltr' | 'rtl';
    display?: 'fullscreen' | 'standalone' | 'minimal-ui' | 'browser'; display_override?: string[]; orientation?: string; background_color?: string; theme_color?: string; categories?: string[];
    icons?: Array<{ src: string; sizes?: string; type?: string; purpose?: string }>; screenshots?: Array<{ src: string; sizes?: string; type?: string; form_factor?: string; label?: string }>;
    shortcuts?: Array<{ name: string; short_name?: string; description?: string; url: string; icons?: Manifest['icons'] }>;
    related_applications?: Array<{ platform: string; url?: string; id?: string }>; prefer_related_applications?: boolean;
    [extension: string]: unknown;
  }
}
