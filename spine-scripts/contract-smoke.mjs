import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const html=fs.readFileSync(path.join(here,'index.html'),'utf8');
const app=fs.readFileSync(path.join(here,'app.js'),'utf8');
const inputTag=id=>{
  const match=html.match(new RegExp('<input id="'+id+'"[^>]*>'));
  assert.ok(match,'missing input '+id);
  return match[0];
};

assert.ok(html.includes('ag-psd@14.5.2'),'browser parser version must be pinned');
assert.ok(html.includes('Parser provenance:'),'visible parser provenance note is required');
assert.ok(html.includes('Adobe Photoshop is not invoked'),'UI must not imply Photoshop execution');
assert.ok(html.includes('Pixel parity with Photoshop is unverified'),'Photoshop pixel parity must remain unclaimed');
assert.ok(html.includes('Real PSB compatibility remains experimental'),'PSB support must remain qualified');
assert.ok(html.includes('app.js?v=20261123b'),'app.js cache key must match the reviewed source');
assert.ok(!html.includes('GitHub + Photoshop'),'misleading Photoshop branding must be absent');
assert.ok(!/checked/.test(inputTag('ignoreHidden')),'hidden layers must be retained by default');
assert.ok(!/checked/.test(inputTag('ignoreBackground')),'background layer must be retained by default');
assert.ok(!/checked/.test(inputTag('trimWhitespace')),'source geometry must not be trimmed by default');
assert.match(inputTag('padding'),/value="0"/,'default export padding must be zero');
assert.ok(html.includes('Layered PSD reconstruction unavailable'),'browser pipeline must not offer a fake PSD export');

for(const field of ['sourceName','sourceIndex','sourceRecordId','sourceLayers','sourceFileName','compositeAudit'])
  assert.ok(app.includes(field),'missing source provenance field '+field);
assert.ok(app.includes('sourceName exactly'),'AI instructions must preserve original names verbatim');
assert.ok(app.includes('never rename, merge or invent source layers'),'AI instructions must prohibit source layer renaming/merging');
assert.ok(app.includes('source-layer-map'),'UI must disclose source-layer metadata output');
assert.ok(app.includes('no non-static numeric transform keyframes'),'static plans must be rejected before ZIP export');
assert.ok(app.includes('compositeAudit={status:mismatchPixels===0?\'exact\':\'mismatch\''),'layer reconstruction must be audited against the embedded composite');
for(const feature of ['layer.adjustment','layer.text','layer.smartObject','layer.mask','layer.vectorMask','layer.effects','layer.clipping','layer.blendMode','layer.opacity'])
  assert.ok(app.includes(feature),'unsupported PSD feature must fail closed: '+feature);
assert.ok(app.includes('if(layer.visible)renderContext.drawImage'),'hidden source layers must not be painted into the visible composite');
assert.ok(app.includes('API.exporter')&&app.includes('spine-generator.spine-animator-f8692224.workers.dev'),'export must use the selected generator Worker');
assert.ok(app.includes('API.planner')&&app.includes('spine-plan-api.spine-animator-f8692224.workers.dev'),'planning must use the selected planner Worker');
assert.ok(app.includes('Not release-ready'),'UI must not claim production completion');
assert.ok(app.includes('Spine Editor 4.3.26'),'native editor validation requirement must remain visible');

console.log(JSON.stringify({ok:true,checks:28,scope:'spine-scripts static contract only'}));
