import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { dedupeHead } from '../compat/head.cjs';

const meta = props => React.createElement('meta', props);

test('keyed page viewport replaces the unkeyed default', () => {
  const custom = meta({ name: 'viewport', content: 'width=640', key: 'viewport' });
  assert.deepEqual(dedupeHead([meta({ name: 'viewport', content: 'width=device-width' }), custom]), [custom]);
});

test('charset is unique regardless of value or explicit key', () => {
  const custom = meta({ charSet: 'iso-8859-1', key: 'custom-charset' });
  assert.deepEqual(dedupeHead([meta({ charSet: 'utf-8' }), custom]), [custom]);
});

test('distinct keyed name tags and repeated Open Graph properties survive', () => {
  const entries = [meta({ name: 'description', content: 'first', key: 'first' }),
    meta({ name: 'description', content: 'second', key: 'second' }),
    meta({ property: 'og:image', content: '/one.png' }), meta({ property: 'og:image', content: '/two.png' })];
  assert.deepEqual(dedupeHead(entries), entries);
});

test('explicit keys deduplicate across types while title and base are always unique', () => {
  const kept = [meta({ name: 'last', key: 'shared' }),
    React.createElement('title', { key: 'new-title' }, 'new'), React.createElement('base', { key: 'new-base', href: '/new' })];
  assert.deepEqual(dedupeHead([React.createElement('link', { key: 'shared', href: '/old' }),
    React.createElement('title', { key: 'old-title' }, 'old'), React.createElement('base', { key: 'old-base', href: '/old' }), ...kept]), kept);
});

test('HTTP equivalent metadata categories are unique even with different keys', () => {
  const custom = meta({ httpEquiv: 'content-language', content: 'fr', key: 'second' });
  assert.deepEqual(dedupeHead([meta({ httpEquiv: 'content-language', content: 'en', key: 'first' }), custom]), [custom]);
});

test('React Children.toArray keys retain the same deduplication rules', () => {
  const entries = React.Children.toArray([meta({ name: 'description', content: 'old', key: 'description' }),
    meta({ name: 'description', content: 'new', key: 'description' })]);
  assert.deepEqual(dedupeHead(entries), [entries[1]]);
});
