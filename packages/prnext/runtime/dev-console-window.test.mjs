import test from 'node:test';
import assert from 'node:assert/strict';
import { fitConsoleRect, resizeConsoleRect } from './dev-console-window.mjs';

const bounds = { x: 8, y: 8, width: 984, height: 684 }, minimum = { width: 320, height: 200 };
const rect = { x: 200, y: 180, width: 500, height: 300 };

test('moving keeps the complete console inside the visible viewport', () => {
  assert.deepEqual(fitConsoleRect({ ...rect, x: -100, y: -50 }, bounds, minimum), { ...rect, x: 8, y: 8 });
  assert.deepEqual(fitConsoleRect({ ...rect, x: 2000, y: 1500 }, bounds, minimum), { ...rect, x: 492, y: 392 });
});

for (const edge of ['n','e','s','w','ne','se','sw','nw']) test(`resizing ${edge} preserves the opposite edges`, () => {
  const result = resizeConsoleRect(rect, edge, 20, 30, bounds, minimum);
  assert.equal(result.x, edge.includes('w') ? 220 : 200);
  assert.equal(result.y, edge.includes('n') ? 210 : 180);
  assert.equal(result.x + result.width, edge.includes('e') ? 720 : 700);
  assert.equal(result.y + result.height, edge.includes('s') ? 510 : 480);
  for (const dx of [-5000,5000]) for (const dy of [-5000,5000]) {
    const limited = resizeConsoleRect(rect, edge, dx, dy, bounds, minimum);
    assert.ok(limited.x >= bounds.x && limited.y >= bounds.y);
    assert.ok(limited.x + limited.width <= bounds.x + bounds.width);
    assert.ok(limited.y + limited.height <= bounds.y + bounds.height);
    assert.ok(limited.width >= minimum.width && limited.height >= minimum.height);
  }
});

test('a resized or zoomed viewport can be smaller than the normal minimum', () => {
  const small = { x: 18, y: 108, width: 264, height: 144 };
  assert.deepEqual(fitConsoleRect(rect, small, minimum), small);
  for (const edge of ['ne','se','sw','nw']) assert.deepEqual(resizeConsoleRect(rect, edge, -500, 500, small, minimum), small);
});
