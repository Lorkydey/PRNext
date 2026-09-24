import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { resolveMetadata, metadataElements } from './app-metadata.mjs';

const props = { params: Promise.resolve({ slug: 'story' }), searchParams: Promise.resolve({}) };
async function resolved(metadata, options = {}) {
  return resolveMetadata({ page: { metadata } }, { ...props, pathname: '/news/story', ...options });
}
async function tags(metadata, options) { return metadataElements(await resolved(metadata, options)); }
const values = (elements, name) => elements.filter(({ type, props }) => type === 'meta' && (props.name === name || props.property === name)).map(({ props }) => props.content);
const links = (elements, rel) => elements.filter(({ type, props }) => type === 'link' && props.rel === rel).map(({ props: { children, ...props } }) => props);

test('verification, manifest, Apple Web App and auxiliary metadata emit complete repeated tags', async () => {
  const elements = await tags({
    metadataBase: new URL('https://example.com/base'), manifest: '/manifest.webmanifest',
    verification: { google: ['one', 'two'], yahoo: 'yahoo', yandex: 'yandex', me: ['mailto:me@example.com'], other: { 'custom-verifier': ['a', 'b', null, ''] } },
    appleWebApp: { title: 'My app', startupImage: ['/launch.png', { url: '/wide.png', media: '(min-width: 800px)' }], statusBarStyle: 'black-translucent' },
    itunes: { appId: '123', appArgument: './install' }, facebook: { appId: 'fb', admins: ['a', 'b'] }, pinterest: { richPin: false },
    abstract: 'Summary', classification: 'News', archives: ['/archive'], assets: '/assets', bookmarks: ['/one', '/two'],
    pagination: { previous: '/previous', next: new URL('https://other.example/?lang=en') },
    formatDetection: { telephone: false, email: true, address: false, extra: false },
  });
  assert.deepEqual(values(elements, 'google-site-verification'), ['one', 'two']);
  assert.deepEqual(values(elements, 'y_key'), ['yahoo']);
  assert.deepEqual(values(elements, 'yandex-verification'), ['yandex']);
  assert.deepEqual(values(elements, 'me'), ['mailto:me@example.com']);
  assert.deepEqual(values(elements, 'custom-verifier'), ['a', 'b']);
  assert.deepEqual(links(elements, 'manifest'), [{ rel: 'manifest', href: '/manifest.webmanifest' }]);
  assert.deepEqual(values(elements, 'mobile-web-app-capable'), ['yes']);
  assert.deepEqual(values(elements, 'apple-mobile-web-app-title'), ['My app']);
  assert.deepEqual(values(elements, 'apple-mobile-web-app-status-bar-style'), ['black-translucent']);
  assert.equal(links(elements, 'apple-touch-startup-image')[1].media, '(min-width: 800px)');
  assert.equal(links(elements, 'apple-touch-startup-image')[0].href, '/launch.png');
  assert.deepEqual(values(elements, 'apple-itunes-app'), ['app-id=123, app-argument=https://example.com/base/news/story/install']);
  assert.deepEqual(values(elements, 'fb:admins'), ['a', 'b']);
  assert.deepEqual(values(elements, 'fb:app_id'), ['fb']);
  assert.deepEqual(values(elements, 'pinterest-rich-pin'), ['false']);
  assert.deepEqual(values(elements, 'abstract'), ['Summary']);
  assert.deepEqual(values(elements, 'classification'), ['News']);
  assert.deepEqual(values(elements, 'format-detection'), ['telephone=no, address=no']);
  assert.deepEqual(links(elements, 'bookmarks').map(item => item.href), ['/one', '/two']);
  assert.equal(links(elements, 'archives')[0].href, '/archive');
  assert.equal(links(elements, 'assets')[0].href, '/assets');
  assert.equal(links(elements, 'prev')[0].href, 'https://example.com/base/previous');
  assert.equal(links(elements, 'next')[0].href, 'https://other.example/news/story?lang=en');
});

test('Apple boolean/default capabilities and app-link platform descriptors preserve false and custom protocols', async () => {
  assert.deepEqual(values(await tags({ appleWebApp: true }), 'mobile-web-app-capable'), ['yes']);
  assert.deepEqual(values(await tags({ appleWebApp: true }), 'apple-mobile-web-app-status-bar-style'), []);
  assert.deepEqual(values(await tags({ appleWebApp: {} }), 'apple-mobile-web-app-status-bar-style'), ['default']);
  assert.deepEqual(values(await tags({ appleWebApp: false }), 'mobile-web-app-capable'), []);
  assert.deepEqual(values(await tags({ appleWebApp: { capable: false } }), 'mobile-web-app-capable'), []);
  const elements = await tags({ appLinks: {
    ios: [{ url: new URL('myapp://story'), app_store_id: '42', app_name: 'My App' }, { url: 'myapp://other' }],
    iphone: { url: 'phone://story', app_store_id: 123 }, ipad: { url: 'pad://story' },
    android: { package: 'com.example.app', class: 'MainActivity', url: 'android://story', app_name: 'Android App' },
    windows: { url: 'windows://story', app_id: 'win', app_name: 'Windows App' },
    windows_phone: { url: 'winphone://story', app_id: 'phone' }, windows_universal: { url: 'universal://story', app_id: 'uni' },
    web: { url: 'https://example.com/story', should_fallback: false },
  } });
  assert.deepEqual(values(elements, 'al:ios:url'), ['myapp://story', 'myapp://other']);
  assert.deepEqual(values(elements, 'al:ios:app_store_id'), ['42']);
  assert.deepEqual(values(elements, 'al:android:package'), ['com.example.app']);
  assert.deepEqual(values(elements, 'al:android:class'), ['MainActivity']);
  assert.deepEqual(values(elements, 'al:windows:app_name'), ['Windows App']);
  assert.deepEqual(values(elements, 'al:windows_phone:app_id'), ['phone']);
  assert.deepEqual(values(elements, 'al:windows_universal:app_id'), ['uni']);
  assert.deepEqual(values(elements, 'al:web:should_fallback'), ['false']);
});

test('alternate URL composition includes base subpaths, current paths and repeated titled media/type links', async () => {
  const elements = await tags({ metadataBase: 'https://example.com/base/', alternates: {
    canonical: { url: './' }, languages: { en: '/en', de: [{ url: '/de', title: 'Deutsch' }, { url: 'https://other.example/de' }] },
    media: { '(max-width: 600px)': [{ url: './mobile', title: 'Small' }] },
    types: { 'application/rss+xml': [{ url: '/feed.xml', title: 'RSS' }] },
  } });
  assert.equal(links(elements, 'canonical')[0].href, 'https://example.com/base/news/story');
  assert.deepEqual(links(elements, 'alternate').map(({ href, title, hrefLang, media, type }) => [href, title, hrefLang, media, type]), [
    ['https://example.com/base/en', undefined, 'en', undefined, undefined],
    ['https://example.com/base/de', 'Deutsch', 'de', undefined, undefined],
    ['https://other.example/de', undefined, 'de', undefined, undefined],
    ['https://example.com/base/news/story/mobile', 'Small', undefined, '(max-width: 600px)', undefined],
    ['https://example.com/base/feed.xml', 'RSS', undefined, undefined, 'application/rss+xml'],
  ]);
  assert.equal(links(await tags({ metadataBase: 'https://example.com', alternates: { canonical: '/' } }), 'canonical')[0].href, 'https://example.com');
  const withUrl = await tags({ alternates: { canonical: new URL('https://example.com/base?tag=one') } });
  assert.equal(links(withUrl, 'canonical')[0].href, 'https://example.com/news/story?tag=one');
  await assert.rejects(resolved({ metadataBase: 'invalid' }), /metadataBase is not a valid URL/);
});

test('URLs are resolved where exported and parent snapshots cannot mutate reused module metadata', async () => {
  const root = { metadata: { metadataBase: new URL('https://one.example/base'), openGraph: { images: '/image.jpg' }, alternates: { canonical: '/original' }, other: { first: ['a'], shared: 'root' } } };
  const entry = { segments: [{ layout: root }, {}], page: { generateMetadata: async (_, parent) => {
    const previous = await parent;
    assert.deepEqual(previous.openGraph.images, [{ url: 'https://one.example/base/image.jpg' }]);
    previous.openGraph.images.push({ url: 'https://injected.example/' });
    previous.other.first.push('mutated');
    return { metadataBase: new URL('https://two.example/child'), other: { second: 'b', shared: 'page' } };
  } } };
  for (let attempt = 0; attempt < 2; attempt++) {
    const metadata = await resolveMetadata(entry, props);
    assert.deepEqual(metadata.openGraph.images, [{ url: 'https://one.example/base/image.jpg' }]);
    assert.equal(metadata.alternates.canonical.url, 'https://one.example/base/original');
    assert.deepEqual(metadata.other, { first: ['a'], shared: 'page', second: 'b' });
  }
  assert.equal(root.metadata.openGraph.images, '/image.jpg');
  assert.deepEqual(root.metadata.other.first, ['a']);
});

test('social title templates, shallow replacement and postprocessing match metadata inheritance', async () => {
  const root = { layout: { metadata: {
    title: { default: 'Site', template: '%s | Site' }, description: 'Default description',
    openGraph: { title: { default: 'OG root', template: '%s | OG' }, description: 'Old description', images: 'https://example.com/old.jpg' },
    twitter: { title: { default: 'TW root', template: '%s | TW' } },
  } } };
  const metadata = await resolveMetadata({ segments: [root, {}], page: { metadata: {
    title: 'Story', openGraph: { title: 'Article', images: 'https://example.com/new.jpg' }, twitter: { title: { absolute: 'Exact tweet' } },
  } } }, props);
  assert.equal(metadata.openGraph.title.absolute, 'Article | OG');
  assert.equal(metadata.twitter.title.absolute, 'Exact tweet');
  assert.equal(metadata.openGraph.description, 'Default description');
  assert.equal(metadata.twitter.description, 'Default description');
  assert.equal(metadata.twitter.card, 'summary'); // card chosen before image fallback, as in Next.
  assert.deepEqual(metadata.twitter.images, [{ url: 'https://example.com/new.jpg' }]);
  const automatic = await resolved({ title: 'Page', description: 'Page description', openGraph: { images: 'https://example.com/image.jpg' } });
  assert.equal(automatic.twitter.card, 'summary_large_image');
  assert.equal(automatic.twitter.title.absolute, 'Page');
  assert.equal(automatic.openGraph.title.absolute, 'Page');
  assert.equal((await resolved({ twitter: {} })).twitter.card, 'summary');
  assert.equal((await resolved({ title: 'Page' })).twitter, undefined);
  assert.equal((await resolveMetadata({ segments: [root], page: { metadata: { openGraph: { title: 'Sibling' } } } }, props)).openGraph.title.absolute, 'Sibling');
});

test('Open Graph emits audio/video descriptors and article fields with repeated values', async () => {
  const elements = await tags({ metadataBase: 'https://example.com/base', openGraph: {
    type: 'article', title: 'Article', ttl: 0, emails: ['a@example.com', 'b@example.com'], phoneNumbers: '123', faxNumbers: '456', alternateLocale: ['fr', 'de'],
    publishedTime: '2026-09-01', modifiedTime: '2026-09-02', expirationTime: '2027-01-01', authors: ['https://author.example/', 'https://other.example/'], section: 'News', tags: ['a', 'b'],
    images: [{ url: '/image.jpg', secureUrl: 'https://cdn.example/secure.jpg', width: 800, height: 600, type: 'image/jpeg', alt: 'Image' }],
    videos: [{ url: 'https://media.example/movie.mp4', secureUrl: 'https://secure.example/movie.mp4', width: 640, height: 480, type: 'video/mp4' }],
    audio: [{ url: 'https://media.example/audio.mp3', secureUrl: 'https://secure.example/audio.mp3', type: 'audio/mpeg' }],
  } });
  for (const [name, expected] of Object.entries({
    'og:image': ['https://example.com/base/image.jpg'], 'og:image:secure_url': ['https://cdn.example/secure.jpg'], 'og:image:alt': ['Image'],
    'og:video:width': ['640'], 'og:video:height': ['480'], 'og:video:type': ['video/mp4'], 'og:audio:type': ['audio/mpeg'],
    'og:audio:secure_url': ['https://secure.example/audio.mp3'], 'og:ttl': ['0'], 'og:email': ['a@example.com', 'b@example.com'], 'og:phone_number': ['123'], 'og:fax_number': ['456'],
    'og:locale:alternate': ['fr', 'de'], 'article:author': ['https://author.example/', 'https://other.example/'], 'article:tag': ['a', 'b'],
    'article:published_time': ['2026-09-01'], 'article:modified_time': ['2026-09-02'], 'article:expiration_time': ['2027-01-01'], 'article:section': ['News'],
  })) assert.deepEqual(values(elements, name), expected, name);
});

test('Open Graph supports every book/profile/music/video type and descriptor variant', async () => {
  const cases = [
    [{ type: 'book', isbn: 'ISBN', releaseDate: '2026', authors: 'author', tags: ['tag'] }, { 'book:isbn': ['ISBN'], 'book:release_date': ['2026'], 'book:author': ['author'], 'book:tag': ['tag'] }],
    [{ type: 'profile', firstName: 'Ada', lastName: 'Lovelace', username: 'ada', gender: 'female' }, { 'profile:first_name': ['Ada'], 'profile:last_name': ['Lovelace'], 'profile:username': ['ada'], 'profile:gender': ['female'] }],
    [{ type: 'music.song', duration: 0, albums: [{ url: 'https://example.com/album', disc: 0, track: 2 }], musicians: ['artist'] }, { 'music:duration': ['0'], 'music:album': ['https://example.com/album'], 'music:album:disc': ['0'], 'music:album:track': ['2'], 'music:musician': ['artist'] }],
    [{ type: 'music.album', songs: ['song', { url: 'other-song', track: 1 }], musicians: ['artist'], releaseDate: '2026' }, { 'music:song': ['song', 'other-song'], 'music:song:track': ['1'], 'music:musician': ['artist'], 'music:release_date': ['2026'] }],
    [{ type: 'music.playlist', songs: 'song', creators: ['creator'] }, { 'music:song': ['song'], 'music:creator': ['creator'] }],
    [{ type: 'music.radio_station', creators: 'creator' }, { 'music:creator': ['creator'] }],
    [{ type: 'video.movie', actors: ['actor', { url: 'other-actor', role: 'Lead' }], directors: 'director', writers: 'writer', duration: 0, releaseDate: '2026', tags: 'tag' }, { 'video:actor': ['actor', 'other-actor'], 'video:actor:role': ['Lead'], 'video:director': ['director'], 'video:writer': ['writer'], 'video:duration': ['0'], 'video:release_date': ['2026'], 'video:tag': ['tag'] }],
    [{ type: 'video.episode', series: new URL('https://example.com/series') }, { 'video:series': ['https://example.com/series'] }],
    [{ type: 'website' }, {}], [{ type: 'video.tv_show' }, {}], [{ type: 'video.other' }, {}],
  ];
  for (const [openGraph, expected] of cases) {
    const elements = await tags({ openGraph });
    assert.deepEqual(values(elements, 'og:type'), [openGraph.type]);
    for (const [name, expectedValues] of Object.entries(expected)) assert.deepEqual(values(elements, name), expectedValues, name);
  }
  await assert.rejects(tags({ openGraph: { type: 'invalid' } }), /Invalid OpenGraph type/);
});

test('Twitter player/app cards include all platforms and image descriptor fields', async () => {
  const elements = await tags({ twitter: {
    card: 'player', siteId: '123', creatorId: '456', players: [{ playerUrl: new URL('https://example.com/player'), streamUrl: 'https://example.com/stream', width: 640, height: 360 }, { playerUrl: 'https://example.com/other', streamUrl: 'https://example.com/other-stream', width: 400, height: 300 }],
    images: [{ url: 'https://example.com/image.jpg', secureUrl: 'https://example.com/secure.jpg', type: 'image/jpeg', width: 800, height: 600, alt: 'Cover' }],
  } });
  assert.deepEqual(values(elements, 'twitter:site:id'), ['123']);
  assert.deepEqual(values(elements, 'twitter:creator:id'), ['456']);
  assert.deepEqual(values(elements, 'twitter:player'), ['https://example.com/player', 'https://example.com/other']);
  assert.deepEqual(values(elements, 'twitter:player:stream'), ['https://example.com/stream', 'https://example.com/other-stream']);
  assert.deepEqual(values(elements, 'twitter:player:width'), ['640', '400']);
  assert.deepEqual(values(elements, 'twitter:player:height'), ['360', '300']);
  assert.deepEqual(values(elements, 'twitter:image:secure_url'), ['https://example.com/secure.jpg']);
  assert.deepEqual(values(elements, 'twitter:image:type'), ['image/jpeg']);
  assert.deepEqual(values(elements, 'twitter:image:width'), ['800']);
  assert.deepEqual(values(elements, 'twitter:image:height'), ['600']);
  const apps = await tags({ twitter: { card: 'app', app: { name: 'App', id: { iphone: 123, ipad: '456', googleplay: 'com.example.app' }, url: { iphone: 'app://phone', ipad: 'app://pad', googleplay: new URL('app://android') } } } });
  for (const [platform, id, url] of [['iphone', '123', 'app://phone'], ['ipad', '456', 'app://pad'], ['googleplay', 'com.example.app', 'app://android']]) {
    assert.deepEqual(values(apps, `twitter:app:name:${platform}`), ['App']);
    assert.deepEqual(values(apps, `twitter:app:id:${platform}`), [id]);
    assert.deepEqual(values(apps, `twitter:app:url:${platform}`), [url]);
  }
});

test('extended metadata is escaped, null clears fields and relative ordinary links stay relative', async () => {
  const elements = await tags({ metadataBase: 'https://example.com/base', verification: { other: { 'custom"tag': '<script>private()</script>' } },
    icons: { icon: '/icon.svg', other: [{ rel: 'mask-icon', url: '/mask.svg', color: '#000' }] }, authors: [{ name: 'Author', url: '/author' }],
    appleWebApp: { title: '"><script>evil()</script>' },
  });
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, ...elements));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;private\(\)&lt;\/script&gt;/);
  assert.equal(links(elements, 'icon')[0].href, '/icon.svg');
  assert.equal(links(elements, 'mask-icon')[0].color, '#000');
  assert.equal(links(elements, 'author')[0].href, '/author');
  const cleared = await resolveMetadata({ segments: [{ layout: { metadata: { verification: { google: 'old' }, openGraph: { title: 'old' }, alternates: { canonical: '/old' } } } }], page: { metadata: { verification: null, openGraph: null, alternates: null } } }, props);
  assert.deepEqual(values(metadataElements(cleared), 'google-site-verification'), []);
  assert.deepEqual(values(metadataElements(cleared), 'og:title'), []);
  assert.deepEqual(links(metadataElements(cleared), 'canonical'), []);
});

test('canonical pathname fallback encodes dynamic and catch-all segments and ignores route groups', async () => {
  const metadata = await resolveMetadata({ segments: [{ segment: '(group)' }, { segment: 'blog' }, { segment: '[...slug]' }], page: { metadata: { metadataBase: 'https://example.com', alternates: { canonical: './' } } } }, { params: Promise.resolve({ slug: ['two words', 'café'] }), searchParams: Promise.resolve({}) });
  assert.equal(metadata.alternates.canonical.url, 'https://example.com/blog/two%20words/caf%C3%A9');
});
