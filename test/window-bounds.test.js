'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { MIN_W, MIN_H, clampWindowBounds } = require('../lib/window-bounds');

function fakeDisplay(id, x, y, width, height, scaleFactor = 1) {
  return {
    id,
    scaleFactor,
    bounds: { x, y, width, height },
    workArea: { x, y, width, height }
  };
}

describe('clampWindowBounds', () => {
  const primary = fakeDisplay(1, 0, 0, 1920, 1080, 1.5);
  const secondary = fakeDisplay(2, 1920, 0, 1920, 1080, 1.25);
  const displays = [primary, secondary];

  it('centers default size on primary when no bounds', () => {
    const r = clampWindowBounds(null, { displays, primary });
    assert.ok(r.width <= primary.workArea.width);
    assert.ok(r.height <= primary.workArea.height);
    assert.ok(r.x >= primary.workArea.x);
    assert.ok(r.y >= primary.workArea.y);
  });

  it('resets DPI-inflated sizes that exceed workArea', () => {
    const r = clampWindowBounds(
      { x: -200, y: 0, width: 4000, height: 2500 },
      { displays, primary }
    );
    assert.ok(r.width <= primary.workArea.width);
    assert.ok(r.height <= primary.workArea.height);
    assert.ok(r.width >= MIN_W);
    assert.ok(r.height >= MIN_H);
  });

  it('enforces the chrome-safe minimum width', () => {
    const r = clampWindowBounds(
      { x: 100, y: 100, width: 640, height: 400 },
      { displays, primary }
    );
    assert.equal(r.width, MIN_W);
    assert.equal(r.height, MIN_H);
  });

  it('keeps a valid restored window on the same display', () => {
    const r = clampWindowBounds(
      { x: 200, y: 100, width: 1100, height: 700 },
      { displays, primary }
    );
    assert.equal(r.width, 1100);
    assert.equal(r.height, 700);
    assert.equal(r.x, 200);
    assert.equal(r.y, 100);
  });

  it('honors preferredDisplayId', () => {
    const r = clampWindowBounds(
      { x: 100, y: 100, width: 1000, height: 700 },
      { displays, primary, preferredDisplayId: 2 }
    );
    assert.equal(r.displayId, 2);
    assert.ok(r.x >= secondary.workArea.x);
  });

  it('restores last displayId when preferred is auto', () => {
    const r = clampWindowBounds(
      { x: 100, y: 100, width: 1000, height: 700, displayId: 2 },
      { displays, primary, preferredDisplayId: 'auto' }
    );
    assert.equal(r.displayId, 2);
    assert.ok(r.x >= secondary.workArea.x);
  });

  it('preferredDisplayId wins over saved displayId', () => {
    const r = clampWindowBounds(
      { x: 2100, y: 100, width: 1000, height: 700, displayId: 2 },
      { displays, primary, preferredDisplayId: 1 }
    );
    assert.equal(r.displayId, 1);
    assert.ok(r.x < secondary.workArea.x);
  });
});
