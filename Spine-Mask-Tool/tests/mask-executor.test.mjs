import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../core.js', import.meta.url), 'utf8');
const { imageMask, availableRegions, exportJson, normalizeSpineImagePath } = await import(
  'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
);

test('normalizes absolute Spine texture paths for portable project ZIPs without mutating source JSON', () => {
  const original = {
    skeleton: { spine: '4.3.26', images: '/Users/imac/Data/Animation/DS/sym_crown/images/' },
    bones: [{ name: 'root' }],
    slots: [{ name: 'wild_txt', bone: 'root', attachment: 'wild_txt' }],
    skins: { default: { wild_txt: { wild_txt: { type: 'region', path: 'wild_txt' } } } }
  };
  const before = JSON.stringify(original);
  const portable = normalizeSpineImagePath(original);
  assert.equal(portable.skeleton.images, './images/');
  assert.equal(JSON.stringify(original), before, 'source skeleton was mutated');
  assert.notEqual(portable, original);
});

test('builds one valid clipping polygon from disconnected artwork with counters', () => {
  const width = 112, height = 56;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const pixel = (x, y) => { rgba[(y * width + x) * 4 + 3] = 255; };

  for (let y = 5; y <= 49; y++) for (let x = 6; x <= 39; x++) {
    if (!((x > 14 && x < 33 && y > 11 && y < 24) ||
          (x > 14 && x < 33 && y > 30 && y < 44))) pixel(x, y);
  }
  for (let y = 7; y <= 47; y++) for (let x = 55; x <= 96; x++) {
    if (!(x > 63 && x < 89 && y > 16 && y < 39)) pixel(x, y);
  }
  for (let y = 1; y <= 3; y++) for (let x = 106; x <= 109; x++) pixel(x, y);

  const result = imageMask({ width, height, data: rgba }, { bridgeWidth: 2, minArea: 2 });
  assert.equal(result.stats.shapes, 3);
  assert.equal(result.stats.bridges, 2);
  assert.equal(result.stats.slits, 3);
  assert.equal(result.stats.mobileQualityPassed, true);
  assert.ok(result.points.length <= 240, '30-skeleton vertex budget exceeded');
  assert.ok(result.stats.totalSceneClippingVertices <= 7200, 'aggregate vertex budget exceeded');

  const skeleton = {
    skeleton: { spine: '4.3.26' },
    bones: [{ name: 'root' }],
    slots: [{ name: 'image', bone: 'root', attachment: 'image' }],
    skins: [{ name: 'default', attachments: {
      image: { image: { type: 'region', path: 'image', width, height } }
    } }],
    animations: { idle: {} }
  };
  const before = JSON.stringify(skeleton);
  const exported = exportJson(skeleton, availableRegions(skeleton)[0], result.points, width, height);
  assert.equal(JSON.stringify(skeleton), before, 'source skeleton was mutated');
  assert.equal(exported.json.slots[0].attachment, 'clip');
  assert.equal(exported.json.slots[1].name, 'image');
  assert.equal(exported.json.skins[0].attachments[exported.slot].clip.end, 'image');
  assert.equal(exported.json.skins[0].attachments[exported.slot].clip.vertexCount, result.stats.vertices);
  assert.ok(exported.json.animations.idle, 'animation was not preserved');
});

test('keeps bright faces, counters and shadow exclusions in automatic highlight mode', () => {
  const width = 118, height = 68;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const shade = (x, y, red, green, blue) => {
    const p = (y * width + x) * 4;
    rgba[p] = red; rgba[p + 1] = green; rgba[p + 2] = blue; rgba[p + 3] = 255;
  };

  for (let y = 8; y < 57; y++) for (let x = 5; x < 53; x++) shade(x, y, 86, 31, 6);
  for (let y = 12; y < 50; y++) for (let x = 9; x < 48; x++) shade(x, y, 255, 177, 18);
  for (let y = 9; y < 56; y++) for (let x = 65; x < 113; x++) shade(x, y, 93, 34, 5);
  for (let y = 14; y < 48; y++) for (let x = 69; x < 108; x++) {
    if (!(x > 81 && x < 95 && y > 23 && y < 38)) shade(x, y, 249, 190, 32);
  }

  const result = imageMask({ width, height, data: rgba }, { highlightFaces: true });
  const at = (x, y) => y * width + x;
  assert.equal(result.stats.highlightApplied, true);
  assert.equal(result.stats.mobileQualityPassed, true);
  assert.ok(result.stats.vertices <= 240);
  assert.ok(result.stats.darkLeakPercent <= 3);
  assert.ok(result.stats.missingLightPercent <= 7);
  assert.equal(result.stats.innerHolesPreserved, true);
  assert.equal(result.visibleAlpha[at(5, 9)], 0, 'dark shadow leaked into the mask');
  assert.equal(result.visibleAlpha[at(10, 15)], 255, 'bright face was removed');
  assert.equal(result.visibleAlpha[at(84, 28)], 0, 'inner counter was filled');
  assert.equal(result.visibleAlpha[at(58, 20)], 0, 'invisible routing bridge became visible');
});


test('traces a compact text-like layer with many counters and fragmented highlights', () => {
  const width = 182, height = 66;
  const data = new Uint8ClampedArray(width * height * 4);
  const paint = (x0, y0, w, h, rgba) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      data.set(rgba, (y * width + x) * 4);
    }
  };

  // A connected dark text backing with transparent counters, like a compact
  // lettering attachment. The bright flecks deliberately fragment the
  // optional highlight-only pass; the alpha silhouette must remain usable.
  paint(2, 2, 178, 62, [18, 16, 14, 255]);
  for (let row = 0; row < 7; row++) for (let column = 0; column < 7; column++) {
    paint(18 + column * 24, 8 + row * 8, 3, 3, [0, 0, 0, 0]);
  }
  let flecks = 0;
  for (let row = 0; row < 7 && flecks < 151; row++) {
    for (let column = 0; column < 22 && flecks < 151; column++) {
      paint(5 + column * 8, 5 + row * 8, 2, 2, [255, 240, 190, 255]);
      flecks++;
    }
  }

  const result = imageMask({ width, height, data }, { highlightFaces: true });
  assert.ok(result.points.length >= 3, 'text layer produced no polygon');
  assert.ok(result.points.length <= 240, '30-skeleton vertex budget exceeded');
  assert.equal(result.stats.mobileQualityPassed, true);
  assert.equal(result.stats.innerHolesPreserved, true);
  assert.equal(result.visibleAlpha[9 * width + 19], 0, 'transparent counter was filled');
  assert.equal(result.visibleAlpha[3 * width + 3], 255, 'outer text silhouette was lost');
});

test('preserves original PSD layer names while assigning collision-safe technical IDs', async () => {
  const { runInNewContext } = await import('node:vm');
  const app = fs.readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
  const start = app.indexOf('  function createLayerIdentity(');
  const end = app.indexOf('\n  if (window.__SA_TEST_MODE__ === true)', start);

  assert.notEqual(start, -1, 'production layer identity helper is missing');
  assert.notEqual(end, -1, 'production layer identity test hook boundary is missing');

  const context = Object.create(null);
  runInNewContext(
    app.slice(start, end) + '\nglobalThis.createLayerIdentity = createLayerIdentity;',
    context
  );

  const createLayerIdentity = context.createLayerIdentity;
  const usedIds = new Set();

  const firstOrn = createLayerIdentity('orn', usedIds);
  const secondOrn = createLayerIdentity('orn', usedIds);
  assert.equal(firstOrn.id, 'orn');
  assert.equal(secondOrn.id, 'orn_1');
  assert.equal(firstOrn.sourceName, 'orn');
  assert.equal(secondOrn.sourceName, 'orn');

  const slashName = createLayerIdentity('arm/orn', usedIds);
  const normalizedCollision = createLayerIdentity('arm_orn', usedIds);
  assert.equal(slashName.id, 'arm_orn');
  assert.equal(normalizedCollision.id, 'arm_orn_1');
  assert.equal(slashName.sourceName, 'arm/orn');
  assert.equal(normalizedCollision.sourceName, 'arm_orn');

  const longA = 'x'.repeat(70) + 'A';
  const longB = 'x'.repeat(70) + 'B';
  const firstLong = createLayerIdentity(longA, usedIds);
  const secondLong = createLayerIdentity(longB, usedIds);
  assert.equal(firstLong.id, 'x'.repeat(70));
  assert.equal(secondLong.id, 'x'.repeat(70) + '_1');
  assert.equal(firstLong.sourceName, longA);
  assert.equal(secondLong.sourceName, longB);

  assert.throws(() => createLayerIdentity('x'.repeat(513), usedIds),
    /must not exceed 512 characters/);
});

test('falls back to the full alpha silhouette when light-edge geometry fragments beyond the clip limit', () => {
  const width = 220, height = 160;
  const data = new Uint8ClampedArray(width * height * 4);
  const paint = (x0, y0, w, h, rgba) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      data.set(rgba, (y * width + x) * 4);
    }
  };

  // The source silhouette is one opaque rectangle. The light-edge pass sees
  // 151 isolated highlights plus a separate mid-tone patch (>150 components).
  paint(10, 10, 200, 140, [30, 25, 20, 255]);
  paint(15, 15, 30, 30, [120, 100, 70, 255]);
  let dots = 0;
  for (let row = 0; row < 14 && dots < 151; row++) {
    for (let column = 0; column < 11 && dots < 151; column++) {
      paint(70 + column * 12, 30 + row * 8, 5, 5, [255, 255, 255, 255]);
      dots++;
    }
  }

  const result = imageMask({ width, height, data }, { highlightFaces: true });
  assert.equal(result.stats.highlightRequested, true);
  assert.equal(result.stats.highlightApplied, false);
  assert.equal(result.stats.highlightReason, 'geometry_fallback');
  assert.equal(result.stats.shapes, 1);
  assert.ok(result.points.length >= 3 && result.points.length <= 240);
});
