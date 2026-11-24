/* Public, frontend-only interface. Private 2Spine animation and Linux Spine code is NOT included. */
(() => {
  'use strict';
  const $ = id => document.getElementById(({ create: 'generate', file: 'source-file', url: 'source-url', preview: 'source-preview' })[id] || id);
  const STUDIO = 'https://spine-studio.spine-animator-f8692224.workers.dev';
  const PLAN_API = 'https://spine-plan-api.spine-animator-f8692224.workers.dev';
  const EXPORTER = 'https://spine-generator.spine-animator-f8692224.workers.dev';
  let downloadURL = null;
  let webmPreviewURL = null;
  let spinePlayerLoader = null;
  const LIMIT = 180 * 1024 * 1024;
  function message(text) { $('status').textContent = text; }
  function clearDownload() {
    if (downloadURL) URL.revokeObjectURL(downloadURL);
    downloadURL = null;
    $('download').hidden = true;
  }
  async function fetchLimited(url, init, limit = LIMIT, stage = 'Remote request', timeoutMs = 15000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, credentials: 'omit', mode: 'cors',
        redirect: 'error', signal: controller.signal });
      if (!response.ok) {
        let reason = '', remoteCode = '';
        if (/json/i.test(response.headers.get('content-type') || '')) {
          try {
            const detail = await response.json();
            reason = detail?.error?.message || (typeof detail?.error === 'string' ? detail.error : '') || detail?.message || '';
            remoteCode = detail?.error?.code || detail?.code || detail?.errorCode || '';
          } catch (_) {}
        }
        const error = new Error(stage + ': HTTP ' + response.status +
          (reason ? ' — ' + String(reason).slice(0, 240) : ''));
        error.status = response.status;
        error.remoteCode = String(remoteCode || '');
        error.cfRay = response.headers.get('cf-ray') || '';
        throw error;
      }
      const expected = Number(response.headers.get('content-length'));
      if (expected > limit) throw Error(stage + ': response is too large');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > limit) throw Error(stage + ': response is too large');
      return { response, bytes };
    } catch (error) {
      if (error?.name === 'AbortError') {
        const timeout = Error(stage + ': ' + Math.round(timeoutMs / 1000) + '-second network timeout');
        timeout.code = 'NETWORK_TIMEOUT';
        timeout.cause = error;
        throw timeout;
      }
      if (error?.name === 'TypeError' || /failed to fetch|networkerror|load failed|fetch failed/i.test(String(error?.message || ''))) {
        const network = Error(stage + ': network/CORS/DNS/TLS connection failed (' + String(error?.message || 'fetch failed').slice(0, 160) + ')');
        network.code = 'NETWORK_ERROR';
        network.cause = error;
        throw network;
      }
      throw error;
    } finally { clearTimeout(timeout); }
  }
  const TRANSIENT_PLANNER_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
  function isTransientPlannerError(error) {
    const remoteCode = String(error?.remoteCode || '');
    const errorMessage = String(error?.message || '');
    if (['ANALYSIS_SCHEMA', 'SCENE_SCHEMA', 'VISION_RESPONSE', 'VISION_PLAN', 'VISION_QUOTA', 'VISION_UNAVAILABLE', 'VISION_CONFIGURATION'].includes(remoteCode) ||
        /ANALYSIS_SCHEMA|SCENE_SCHEMA|Scene: nodes must contain|Invalid visual subject|Visual model analysis did not pass structural validation|Visual model scene did not pass structural validation/i.test(errorMessage)) return false;
    return error?.code === 'NETWORK_ERROR' || error?.code === 'NETWORK_TIMEOUT' ||
      TRANSIENT_PLANNER_HTTP.has(error?.status);
  }
  async function fetchPlannerWithRetry(body) {
    const requestId = crypto.randomUUID();
    const startUrl = PLAN_API + '/api/plan-async';
    const statusUrl = PLAN_API + '/api/plan-status?id=';
    let start = null;
    let lastError = null;

    // Reuse one request ID across retries: the API's idempotency record prevents
    // duplicate Workflow instances if the first response is lost in transit.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const queued = await fetchLimited(startUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-request-id': requestId },
          body
        }, 1024 * 1024, 'AI planner queue', 45000);
        try { start = JSON.parse(new TextDecoder().decode(queued.bytes)); }
        catch (_) { throw Error('AI planner queue returned malformed JSON'); }
        if (!start || typeof start.jobId !== 'string' ||
            !/^[a-f0-9-]{36}$/i.test(start.jobId))
          throw Error(start?.error?.message || 'AI planner queue did not return a valid job ID');
        break;
      } catch (error) {
        lastError = error;
        if (attempt >= 2 || !isTransientPlannerError(error)) throw error;
        message('AI planner queue interrupted; retrying safely with the same request ID…');
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    }
    if (!start?.jobId) throw lastError || Error('AI planner did not accept the job');

    const deadline = Date.now() + 20 * 60 * 1000 + 30 * 1000;
    let lastStatusError = null;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2500));
      try {
        const statusResponse = await fetchLimited(
          statusUrl + encodeURIComponent(start.jobId),
          { method: 'GET' }, 1024 * 1024, 'AI planner status', 15000
        );
        let status;
        try { status = JSON.parse(new TextDecoder().decode(statusResponse.bytes)); }
        catch (_) { throw Error('AI planner status returned malformed JSON'); }
        lastStatusError = null;
        if (status?.status === 'complete' && status.plan && typeof status.plan === 'object')
          return { bytes: new TextEncoder().encode(JSON.stringify(status.plan)).buffer };
        if (status?.status === 'failed' || status?.error)
          throw Error(status.error?.message || 'AI planning workflow failed');
        if (!['queued', 'running', 'pending', 'waiting', 'executing'].includes(status?.status))
          throw Error('AI planner returned an unknown job state: ' + String(status?.status || 'missing'));
        message('AI planning… ' + Math.floor((Date.now() - (deadline - 9 * 60 * 1000)) / 1000) + 's');
      } catch (error) {
        if (!isTransientPlannerError(error)) throw error;
        lastStatusError = error;
        message('AI planner status temporarily unavailable; keeping the same job and retrying…');
      }
    }
    throw Error('AI planning exceeded the 20-minute retry window' +
      (lastStatusError ? ': ' + String(lastStatusError.message || lastStatusError).slice(0, 180) : ''));
  }
  async function inspectSpineZip(bytes, plannedClips, source) {
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 22)
      throw Error('ZIP archive is truncated.');
    const view = new DataView(bytes);
    const minEocd = Math.max(0, bytes.byteLength - 22 - 65535);
    let eocd = -1;
    for (let p = bytes.byteLength - 22; p >= minEocd; p--) {
      if (view.getUint32(p, true) === 0x06054b50) { eocd = p; break; }
    }
    if (eocd < 0) throw Error('ZIP end-of-central-directory record is missing.');
    const disk = view.getUint16(eocd + 4, true);
    const centralDisk = view.getUint16(eocd + 6, true);
    const diskEntries = view.getUint16(eocd + 8, true);
    const entries = view.getUint16(eocd + 10, true);
    const centralSize = view.getUint32(eocd + 12, true);
    const centralOffset = view.getUint32(eocd + 16, true);
    const commentLength = view.getUint16(eocd + 20, true);
    if (disk !== 0 || centralDisk !== 0 || diskEntries !== entries || !entries || entries > 1024 ||
        entries === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff ||
        centralOffset + centralSize !== eocd || eocd + 22 + commentLength !== bytes.byteLength)
      throw Error('ZIP directory metadata is inconsistent or unsupported.');
    const decoder = new TextDecoder();
    const files = new Map();
    const localOffsets = new Set();
    const ranges = [];
    const crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    function crc32(data) {
      let c = 0xffffffff;
      for (let i = 0; i < data.length; i++) c = (c >>> 8) ^ crcTable[(c ^ data[i]) & 255];
      return (c ^ 0xffffffff) >>> 0;
    }
    async function unpack(method, packed) {
      if (method === 0) return packed;
      if (method === 8 && typeof DecompressionStream === 'function') {
        const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      }
      throw Error('Unsupported ZIP compression method: ' + method);
    }
    let cursor = centralOffset;
    for (let i = 0; i < entries; i++) {
      if (cursor + 46 > eocd || view.getUint32(cursor, true) !== 0x02014b50)
        throw Error('ZIP central directory entry is corrupt.');
      const flags = view.getUint16(cursor + 8, true);
      const method = view.getUint16(cursor + 10, true);
      const expectedCrc = view.getUint32(cursor + 16, true);
      const compressedSize = view.getUint32(cursor + 20, true);
      const uncompressedSize = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const entryCommentLength = view.getUint16(cursor + 32, true);
      const startDisk = view.getUint16(cursor + 34, true);
      const localOffset = view.getUint32(cursor + 42, true);
      if ((flags & 1) || startDisk !== 0 || compressedSize === 0xffffffff ||
          uncompressedSize === 0xffffffff || localOffset === 0xffffffff ||
          cursor + 46 + nameLength + extraLength + entryCommentLength > eocd)
        throw Error('Encrypted, multi-disk or ZIP64 entries are not supported.');
      const name = decoder.decode(new Uint8Array(bytes, cursor + 46, nameLength));
      if (!name || name.startsWith('/') || name.includes('\\') ||
          name.split('/').some(part => part === '..' || part === '') ||
          files.has(name) || localOffsets.has(localOffset))
        throw Error('ZIP contains an unsafe or duplicate path.');
      if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== 0x04034b50)
        throw Error('ZIP local file header is corrupt: ' + name);
      const localFlags = view.getUint16(localOffset + 6, true);
      const localMethod = view.getUint16(localOffset + 8, true);
      const localCrc = view.getUint32(localOffset + 14, true);
      const localCompressed = view.getUint32(localOffset + 18, true);
      const localUncompressed = view.getUint32(localOffset + 22, true);
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const localName = decoder.decode(new Uint8Array(bytes, localOffset + 30, localNameLength));
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (localName !== name || localFlags !== flags || localMethod !== method ||
          dataEnd > centralOffset || dataEnd > bytes.byteLength ||
          (!(flags & 8) && (localCrc !== expectedCrc ||
            localCompressed !== compressedSize || localUncompressed !== uncompressedSize)))
        throw Error('ZIP local and central records disagree: ' + name);
      const packed = new Uint8Array(bytes, dataStart, compressedSize);
      const raw = await unpack(method, packed);
      if (raw.byteLength !== uncompressedSize || crc32(raw) !== expectedCrc)
        throw Error('ZIP entry size or CRC32 check failed: ' + name);
      files.set(name, raw);
      localOffsets.add(localOffset);
      ranges.push([localOffset, dataEnd, name]);
      cursor += 46 + nameLength + extraLength + entryCommentLength;
    }
    if (cursor !== centralOffset + centralSize)
      throw Error('ZIP central directory size does not match its entries.');
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++)
      if (ranges[i][0] < ranges[i - 1][1])
        throw Error('ZIP local entries overlap: ' + ranges[i][2]);
    for (const name of ['skeleton.json', 'skeleton.atlas', 'manifest.json', 'source-layer-map.json'])
      if (!files.has(name)) {
        const names = Array.from(files.keys());
        const manifestInfo = files.has('manifest.json') ? decoder.decode(files.get('manifest.json')).slice(0,360) : 'missing';
        throw Error('ZIP is missing required file: ' + name +
          ' (entryCount: ' + names.length + '; entries: ' + names.join(', ') + '; manifest: ' + manifestInfo + ')');
      }
    if (!source || !Array.isArray(source.layers) || !Array.isArray(plannedClips) || !plannedClips.length)
      throw Error('Source layer inventory or planned clip list is missing.');
    const skeleton = JSON.parse(decoder.decode(files.get('skeleton.json')));
    const manifest = JSON.parse(decoder.decode(files.get('manifest.json')));
    const sourceLayerMap = JSON.parse(decoder.decode(files.get('source-layer-map.json')));
    if (!skeleton.skeleton || !/^4\.3(?:\.|$)/.test(String(skeleton.skeleton.spine || '')) ||
        !Array.isArray(skeleton.bones) || !skeleton.bones.length ||
        !Array.isArray(skeleton.slots) || !skeleton.slots.length ||
        !skeleton.animations || typeof skeleton.animations !== 'object')
      throw Error('ZIP does not contain a valid Spine 4.3 skeleton.');
    if (manifest.backend !== '2spine-cloud-executor' || manifest.spine !== '4.3.26' ||
        manifest.layerCount !== source.layers.length || manifest.clipCount !== plannedClips.length ||
        manifest.validation?.setupPreserved !== true ||
        manifest.validation?.drawOrderPreserved !== true ||
        manifest.validation?.frameZeroPreserved !== true ||
        manifest.sourceLayerNamesPreserved !== true ||
        !Array.isArray(sourceLayerMap.sourceLayers) || sourceLayerMap.sourceLayers.length !== source.layers.length ||
        sourceLayerMap.sourceLayers.some((layer,index) => !layer || layer.id !== source.layers[index].id ||
          layer.sourceName !== source.layers[index].sourceName || layer.sourceIndex !== index) ||
        manifest.renderEvidence?.status !== 'not-rendered' || manifest.renderEvidence?.frameCount !== 0 ||
        manifest.artisticApproval !== 'pending' || manifest.releaseReady !== false ||
        manifest.nativeSpineEditorFile !== false)
      throw Error('ZIP manifest does not certify the expected source-preserving pending export.');
    // Reduce the exporter's dense 30 FPS bake to a bounded, data-driven set
    // of keys. Static channels are unnecessary in Spine; moving channels are
    // simplified with Ramer-Douglas-Peucker under property-specific tolerances.
    const keyframeOptimization = (() => {
      // Small synthetic ZIPs used by the local browser smoke test intentionally
      // omit production sceneBake metadata. Keep their validation path unchanged.
      if (!manifest.sceneBake || typeof manifest.sceneBake !== 'object') return null;
      const tolerances = { translate: 0.25, rotate: 0.25, scale: 0.005, shear: 0.25,
        rgba: 1 / 255, rgb: 1 / 255, rgba2: 1 / 255, rgb2: 1 / 255 };
      const maxKeysPerTimeline = 12;
      const maxTotalKeys = Math.min(6000,
        Math.max(300, source.layers.length * plannedClips.length * 5 * maxKeysPerTimeline));
      const countKeys = () => {
        let total = 0;
        for (const animation of Object.values(skeleton.animations || {})) {
          for (const groupName of ['bones', 'slots']) {
            for (const timelines of Object.values(animation[groupName] || {}))
              for (const frames of Object.values(timelines || {}))
                if (Array.isArray(frames)) total += frames.length;
          }
          if (Array.isArray(animation.drawOrder)) total += animation.drawOrder.length;
        }
        return total;
      };
      const sourceKeys = countKeys();
      function frameVector(frame, property) {
        if (property === 'attachment')
          return [String(frame.name ?? frame.attachment ?? '')];
        if (['rgba', 'rgb', 'rgba2', 'rgb2'].includes(property)) {
          const values = [];
          for (const field of ['color', 'light', 'dark']) {
            const raw = frame[field];
            if (typeof raw !== 'string') continue;
            const hex = raw.replace(/^#/, '');
            if (!/^[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(hex)) continue;
            for (let i = 0; i < hex.length; i += 2)
              values.push(parseInt(hex.slice(i, i + 2), 16) / 255);
          }
          return values.length ? values : null;
        }
        const values = Object.entries(frame)
          .filter(([key, value]) => !['time', 'curve', 'c2', 'c3'].includes(key) &&
            typeof value === 'number' && Number.isFinite(value))
          .map(([, value]) => value);
        return values.length ? values : null;
      }
      function simplifyTimeline(frames, property) {
        if (!Array.isArray(frames) || frames.length < 2)
          return { frames: null, removed: Array.isArray(frames) ? frames.length : 0 };
        const vectors = frames.map(frame => frameVector(frame, property));
        if (vectors.some(vector => !vector) ||
            vectors.some(vector => vector.length !== vectors[0].length))
          return { frames, removed: 0 };
        const same = property === 'attachment'
          ? vectors.every(vector => JSON.stringify(vector) === JSON.stringify(vectors[0]))
          : vectors.every(vector => vector.every((value, index) =>
            Math.abs(value - vectors[0][index]) <= 1e-9));
        if (same) return { frames: null, removed: frames.length };
        if (frames.some(frame => frame.curve !== undefined ||
            frame.c2 !== undefined || frame.c3 !== undefined))
          return { frames, removed: 0 };
        if (property === 'attachment') {
          const reduced = frames.filter((frame, index) => index === 0 ||
            JSON.stringify(frameVector(frame, property)) !==
              JSON.stringify(frameVector(frames[index - 1], property)));
          return { frames: reduced, removed: frames.length - reduced.length };
        }
        const times = frames.map((frame, index) =>
          Number.isFinite(frame.time) ? frame.time : (index === 0 ? 0 : NaN));
        if (times.some(time => !Number.isFinite(time)) ||
            times.some((time, index) => index > 0 && time <= times[index - 1]))
          return { frames, removed: 0 };
        function rdp(tolerance) {
          const keep = new Set([0, frames.length - 1]);
          function reduce(start, end) {
            if (end <= start + 1) return;
            const first = vectors[start], last = vectors[end];
            const span = times[end] - times[start];
            let maximumError = tolerance, maximumIndex = -1;
            for (let index = start + 1; index < end; index++) {
              const ratio = (times[index] - times[start]) / span;
              let error = 0;
              for (let component = 0; component < first.length; component++) {
                const expected = first[component] +
                  (last[component] - first[component]) * ratio;
                error = Math.max(error, Math.abs(vectors[index][component] - expected));
              }
              if (error > maximumError) {
                maximumError = error;
                maximumIndex = index;
              }
            }
            if (maximumIndex >= 0) {
              keep.add(maximumIndex);
              reduce(start, maximumIndex);
              reduce(maximumIndex, end);
            }
          }
          reduce(0, frames.length - 1);
          return Array.from(keep).sort((a, b) => a - b);
        }
        let tolerance = tolerances[property] ?? 0.001;
        let indices = rdp(tolerance);
        for (let attempt = 0; indices.length > maxKeysPerTimeline && attempt < 48; attempt++) {
          tolerance *= 2;
          indices = rdp(tolerance);
        }
        if (indices.length > maxKeysPerTimeline)
          throw Error('Spine keyframe budget exceeded for ' + property +
            ': ' + indices.length + ' keys (limit ' + maxKeysPerTimeline + ')');
        return { frames: indices.map(index => frames[index]),
          removed: frames.length - indices.length };
      }
      let removedTimelines = 0;
      for (const animation of Object.values(skeleton.animations || {})) {
        for (const groupName of ['bones', 'slots']) {
          const group = animation[groupName];
          if (!group || typeof group !== 'object') continue;
          for (const [name, timelines] of Object.entries(group)) {
            for (const [property, frames] of Object.entries(timelines)) {
              const reduced = simplifyTimeline(frames, property);
              if (!reduced.frames) {
                delete timelines[property];
                removedTimelines++;
              } else timelines[property] = reduced.frames;
            }
            if (!Object.keys(timelines).length) delete group[name];
          }
          if (!Object.keys(group).length) delete animation[groupName];
        }
      }
      const retainedKeys = countKeys();
      if (retainedKeys > maxTotalKeys)
        throw Error('Spine animation exceeds the total keyframe budget: ' +
          retainedKeys + ' > ' + maxTotalKeys);
      const summary = {
        algorithm: 'Ramer-Douglas-Peucker',
        sourceKeys,
        retainedKeys,
        removedKeys: sourceKeys - retainedKeys,
        reductionPercent: sourceKeys ? Number(((sourceKeys - retainedKeys) / sourceKeys * 100).toFixed(2)) : 0,
        maxKeysPerTimeline,
        maxTotalKeys,
        removedStaticTimelines: removedTimelines,
        tolerances: { translatePx: tolerances.translate, rotationDegrees: tolerances.rotate,
          scale: tolerances.scale, shearDegrees: tolerances.shear, colorChannel: tolerances.rgba }
      };
      if (!manifest.sceneBake || typeof manifest.sceneBake !== 'object')
        throw Error('ZIP manifest is missing scene bake metadata.');
      manifest.sceneBake.keyCount = retainedKeys;
      manifest.sceneBake.keyframeOptimization = summary;
      if (manifest.sceneBake.motionAudit && typeof manifest.sceneBake.motionAudit === 'object')
        manifest.sceneBake.motionAudit.note =
          String(manifest.sceneBake.motionAudit.note || '') +
          ' Export keys were simplified with bounded RDP tolerances; this is not artistic approval.';
      files.set('skeleton.json', new TextEncoder().encode(JSON.stringify(skeleton)));
      files.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
      return summary;
    })();
    function packStoredZip(entries) {
      const encoder = new TextEncoder();
      const localParts = [], centralParts = [];
      let localOffset = 0, centralSize = 0;
      for (const [name, raw] of entries) {
        const nameBytes = encoder.encode(name);
        const data = raw instanceof Uint8Array ? raw :
          new Uint8Array(raw.buffer || raw, raw.byteOffset || 0, raw.byteLength || raw.length);
        if (!nameBytes.length || nameBytes.length > 65535 || data.byteLength > 0xffffffff)
          throw Error('Optimized ZIP entry exceeds supported size: ' + name);
        const crc = crc32(data);
        const local = new Uint8Array(30 + nameBytes.length + data.byteLength);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);
        lv.setUint16(6, 0, true);
        lv.setUint16(8, 0, true);
        lv.setUint16(10, 0, true);
        lv.setUint16(12, 0, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, data.byteLength, true);
        lv.setUint32(22, data.byteLength, true);
        lv.setUint16(26, nameBytes.length, true);
        lv.setUint16(28, 0, true);
        local.set(nameBytes, 30);
        local.set(data, 30 + nameBytes.length);
        localParts.push(local);
        const central = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(central.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, 0, true);
        cv.setUint16(14, 0, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, data.byteLength, true);
        cv.setUint32(24, data.byteLength, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint16(30, 0, true);
        cv.setUint16(32, 0, true);
        cv.setUint16(34, 0, true);
        cv.setUint16(36, 0, true);
        cv.setUint32(38, 0, true);
        cv.setUint32(42, localOffset, true);
        central.set(nameBytes, 46);
        centralParts.push(central);
        localOffset += local.byteLength;
        centralSize += central.byteLength;
      }
      if (entries.size > 65535 || localOffset > 0xffffffff || centralSize > 0xffffffff)
        throw Error('Optimized ZIP exceeds classic ZIP directory limits.');
      const end = new Uint8Array(22);
      const ev = new DataView(end.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(4, 0, true);
      ev.setUint16(6, 0, true);
      ev.setUint16(8, entries.size, true);
      ev.setUint16(10, entries.size, true);
      ev.setUint32(12, centralSize, true);
      ev.setUint32(16, localOffset, true);
      ev.setUint16(20, 0, true);
      const output = new Uint8Array(localOffset + centralSize + end.byteLength);
      let offset = 0;
      for (const part of localParts) { output.set(part, offset); offset += part.byteLength; }
      for (const part of centralParts) { output.set(part, offset); offset += part.byteLength; }
      output.set(end, offset);
      return output.buffer;
    }
    const expectedAnimations = plannedClips.map(clip => clip.id).sort();
    const animationEntries = Object.entries(skeleton.animations);
    const actualAnimations = animationEntries.map(entry => entry[0]).sort();
    if (expectedAnimations.length !== actualAnimations.length ||
        expectedAnimations.some((name, index) => name !== actualAnimations[index]))
      throw Error('ZIP animation names do not match the AI-authored clips.');
    const atlasText = decoder.decode(files.get('skeleton.atlas'));
    const textureNames = Array.from(files.keys()).filter(name => /^images\/.+\.png$/i.test(name)).sort();
    const expectedTextures = source.layers.map(layer => 'images/' + layer.id + '.png').sort();
    if (textureNames.length !== expectedTextures.length ||
        expectedTextures.some((name, index) => name !== textureNames[index]))
      throw Error('ZIP texture inventory does not match the original PSD layers.');
    for (const layer of source.layers) {
      const name = 'images/' + layer.id + '.png';
      const png = files.get(name);
      if (!png || png.length < 24 ||
          [137, 80, 78, 71, 13, 10, 26, 10].some((value, index) => png[index] !== value))
        throw Error('ZIP contains an invalid source texture: ' + layer.id);
      const pngView = new DataView(png.buffer, png.byteOffset, png.byteLength);
      const pngWidth = pngView.getUint32(16, false);
      const pngHeight = pngView.getUint32(20, false);
      if (String.fromCharCode(...png.slice(12, 16)) !== 'IHDR' ||
          pngWidth !== layer.bounds.width || pngHeight !== layer.bounds.height)
        throw Error('ZIP texture dimensions changed for source layer: ' + layer.id);
      if (!atlasText.includes(name) || !atlasText.includes('\n' + layer.id + '\n'))
        throw Error('Spine atlas is missing source layer region: ' + layer.id);
    }
    function scan(value, path, depth, found) {
      if (!value || typeof value !== 'object' || depth > 16) return;
      if (Array.isArray(value)) {
        // A visual animation can move bones OR animate slot appearance.
        // The exporter writes opacity as Spine 4.3 slot.rgba timelines;
        // rejecting those as static incorrectly discards glow/fade clips.
        const transformTimeline = /\.bones\.[^.]+\.(translate|rotate|scale|shear)$/.test(path);
        const slotTimeline = /\.slots\.[^.]+\.(rgba|rgb|rgba2|rgb2|attachment)$/.test(path);
        if (transformTimeline || slotTimeline) {
          const frames = value.map((frame, index) => frame && typeof frame === 'object' &&
            !Array.isArray(frame) && (Number.isFinite(frame.time) || index === 0)
            ? { ...frame, time: Number.isFinite(frame.time) ? frame.time : 0 } : null).filter(Boolean);
          const poses = new Set(frames.map(frame => JSON.stringify(Object.fromEntries(
            Object.entries(frame).filter(([key]) => !['time', 'curve', 'c2', 'c3'].includes(key))
          ))));
          const distinctTimes = new Set(frames.map(frame => frame.time)).size;
          if (frames.length >= 2 && distinctTimes >= 2 && poses.size >= 2)
            found.push({ path, keys: frames.length, distinctTimes });
        }
        for (let i = 0; i < value.length; i++) scan(value[i], path + '[' + i + ']', depth + 1, found);
        return;
      }
      for (const [key, child] of Object.entries(value))
        scan(child, path ? path + '.' + key : key, depth + 1, found);
    }
    const moving = [];
    for (const [name, animation] of animationEntries) {
      const before = moving.length;
      scan(animation, name, 0, moving);
      if (moving.length === before)
        throw Error('Static Spine animation rejected: "' + name + '" has no changing transform keys.');
    }
    const optimizedBytes = packStoredZip(files);
    return { report: { animationNames: actualAnimations, movingTimelines: moving,
      zipEntries: files.size, textureFiles: textureNames, manifest, keyframeOptimization },
      bytes: optimizedBytes, files };
  }

  function aiSchemaError(message) {
    const error = Error(message);
    error.code = 'AI_SCHEMA_INVALID';
    throw error;
  }
  function validateVisualAnalysis(analysis, source) {
    if (!analysis || typeof analysis !== 'object' || !analysis.subject ||
        typeof analysis.subject.kind !== 'string' || !analysis.subject.kind.trim() ||
        !Number.isFinite(analysis.subject.confidence) || analysis.subject.confidence < 0 ||
        analysis.subject.confidence > 1 || !Array.isArray(analysis.parts) || analysis.parts.length > 10000)
      aiSchemaError('AI visual analysis schema is invalid: subject.kind, subject.confidence and parts[] are required');
    const partIds = new Set();
    for (const part of analysis.parts) {
      if (!part || typeof part.id !== 'string' || !part.id.trim() || partIds.has(part.id) ||
          typeof part.kind !== 'string' || !part.kind.trim() ||
          !Number.isFinite(part.confidence) || part.confidence < 0 || part.confidence > 1 ||
          !Array.isArray(part.layerIds) || !Array.isArray(part.chains) ||
          part.chains.length > 10000)
        aiSchemaError('AI visual analysis contains an invalid part record');
      partIds.add(part.id);
      if (part.layerIds.some(id => !source.layers.some(layer => layer.id === id)))
        aiSchemaError('AI visual analysis references an unknown PSD layer');
      for (const chain of part.chains) {
        if (!chain || !Array.isArray(chain.points) || chain.points.length < 2 || chain.points.length > 10000 ||
            chain.points.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
              point.x < 0 || point.y < 0 || point.x > source.width || point.y > source.height))
          aiSchemaError('AI visual analysis contains an invalid or out-of-bounds chain');
      }
    }
  }
  function validateAIPlan(plan, source) {
    if (!plan || typeof plan !== 'object' || !plan.scene ||
        !Array.isArray(plan.scene.nodes) || !plan.scene.nodes.length ||
        !Array.isArray(plan.scene.clips) || !plan.scene.clips.length)
      aiSchemaError('AI returned no complete scene with non-empty animation clips');
    const scene = plan.scene;
    const nodes = new Map(scene.nodes.map(node => [node?.id, node]));
    if (nodes.size !== scene.nodes.length || scene.nodes.some(node => !node ||
        typeof node.id !== 'string' || !node.id.trim()))
      aiSchemaError('AI scene contains missing or duplicate node IDs');
    const order = Array.isArray(scene.drawOrder) ? scene.drawOrder : scene.nodes.map(node => node.id);
    if (order.length !== scene.nodes.length || new Set(order).size !== scene.nodes.length ||
        order.some(id => !nodes.has(id)))
      aiSchemaError('AI scene draw order is incomplete or contains unknown nodes');
    const assets = order.map(id => nodes.get(id)).filter(node => node.asset).map(node => node.asset);
    if (assets.length !== source.layers.length ||
        assets.some((id, index) => id !== source.layers[index].id))
      aiSchemaError('AI scene changed the exact source layer inventory or draw order');
    const validation = plan.validation;
    if (!validation || validation.initialPosePreserved !== true ||
        validation.drawOrderPreserved !== true || validation.sourceLayers !== source.layers.length)
      aiSchemaError('AI scene did not certify the original frame-zero pose, draw order and source layer count');
    const clipIds = new Set();
    for (const clip of scene.clips) {
      if (!clip || typeof clip.id !== 'string' || !clip.id.trim() || clipIds.has(clip.id) ||
          clip.id === 'technical_bounce_unapproved' ||
          !Number.isFinite(clip.duration) || clip.duration <= 0 || clip.duration > 86400 ||
          !Array.isArray(clip.tracks) || !clip.tracks.length)
        aiSchemaError('AI clip is missing a unique ID, valid duration or authored node tracks');
      clipIds.add(clip.id);
      let moving = false;
      for (const track of clip.tracks) {
        if (!track || !nodes.has(track.target) ||
            !['x', 'y', 'z', 'rotation', 'scaleX', 'scaleY', 'opacity', 'depth'].includes(track.property) ||
            !Array.isArray(track.keys) || track.keys.length < 2 || track.keys.length > 10000)
          aiSchemaError('AI clip contains an invalid track or fewer than two keyframes');
        let previous = -1;
        const values = new Set();
        for (const key of track.keys) {
          if (!key || !Number.isFinite(key.time) || key.time < 0 || key.time > clip.duration ||
              key.time <= previous || !Number.isFinite(key.value) ||
              (key.interpolation !== undefined && !['linear', 'stepped'].includes(key.interpolation)) ||
              key.curve !== undefined)
            aiSchemaError('AI clip contains invalid, unordered or unsupported keyframe data');
          previous = key.time;
          values.add(key.value);
        }
        if (values.size > 1) moving = true;
      }
      if (!moving) aiSchemaError('AI clip "' + clip.id + '" is static and has no changing numeric node pose');
    }
    if (plan.analysis !== undefined && plan.analysis !== null) validateVisualAnalysis(plan.analysis, source);
    return true;
  }
  async function requestAIPlan(body, source) {
    let current = body;
    for (let repair = 0; repair < 2; repair++) {
      try {
        const result = await fetchPlannerWithRetry(current);
        let plan;
        try { plan = JSON.parse(new TextDecoder().decode(result.bytes)); }
        catch (_) { aiSchemaError('AI planner returned malformed JSON'); }
        validateAIPlan(plan, source);
        return plan;
      } catch (error) {
        const remoteCode = String(error?.remoteCode || '');
        const errorMessage = String(error?.message || '');
        // Missing scene/nodes and source-preservation violations are repairable AI plan failures, not transport retries.
        // The workflow retains the real PSD E2E diagnostics and ZIP for independent inspection.
        const schemaFailure = error?.code === 'AI_SCHEMA_INVALID' ||
          ['ANALYSIS_SCHEMA', 'SCENE_SCHEMA', 'VISION_RESPONSE', 'VISION_PLAN'].includes(remoteCode) ||
          /ANALYSIS_SCHEMA|SCENE_SCHEMA|Scene: nodes must contain|Invalid visual subject|visual analysis schema|Visual model analysis did not pass structural validation|Visual model scene did not pass structural validation|Visual model changed|Visual model altered|Visual model omitted/i.test(errorMessage);
        if (!schemaFailure || repair >= 1) throw error;
        const corrected = JSON.parse(current);
        corrected.instructions = String(corrected.instructions || '') +
          ' REPAIR THE PREVIOUS AI RESPONSE. Return a complete valid scene and visual analysis. ' +
          'The top-level response MUST include scene:{nodes:[...],clips:[...]}; scene.nodes must contain 1..2000 nodes and scene.clips at least one animated clip. ' +
          'analysis.subject must be an object {kind: non-empty string, confidence: finite 0..1}; ' +
          'use kind unknown and confidence 0 when uncertain, never a string subject. ' +
          'analysis.parts must be an array; every part has id, kind, confidence, layerIds and chains arrays. ' +
          'Every clip must contain moving numeric node tracks with at least two distinct keyframes. ' +
          'Preserve exact source layers, frame zero and draw order. Do not emit a technical fallback.';
        corrected.description = String(corrected.description || '') +
          '\n\nCorrective validation request: ' + String(error.message || error).slice(0, 500) +
          '. Return a corrected AI-authored scene; do not relax source-preservation or animation checks.';
        current = JSON.stringify(corrected);
        if (current.length > 19 * 1024 * 1024)
          throw Error('AI repair request exceeds the 19 MB planning limit');
        message('AI response did not match the strict scene schema; requesting one corrected AI plan…');
      }
    }
    throw Error('AI planner could not produce a valid scene after one schema repair');
  }

  function sourceURL(text) {
    const value = typeof text === 'string' ? text.trim() : '';
    if (!value) throw Error('No PSD file selected. Attach a .psd file or paste a public HTTPS link.');
    let u;
    try { u = new URL(value); }
    catch (_) { throw Error('The PSD link is not a valid absolute URL. Paste a complete HTTPS link or attach the PSD file.'); }
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash)
      throw Error('Provide a public HTTPS PSD or supported file-share link');
    if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
      throw Error('Private network URLs are not supported');
    if (['drive.google.com', 'drive.usercontent.google.com'].includes(u.hostname)) {
      const fileLink = u.hostname === 'drive.google.com' &&
        /^\/file\/d\/[A-Za-z0-9_-]{10,128}(?:\/(?:view|preview|edit))?\/?$/.test(u.pathname);
      const directLink = ['/uc', '/open', '/download'].includes(u.pathname) &&
        /^[A-Za-z0-9_-]{10,128}$/.test(u.searchParams.get('id') || '');
      if (!fileLink && !directLink) throw Error('Provide a Google Drive file link, not a folder');
      return u;
    }
    if (u.hostname === 'storage.to') {
      if (!/^\/[A-Za-z0-9]{4,64}$/.test(u.pathname) || u.search)
        throw Error('Provide a public storage.to file-share link');
      return u;
    }
    if (!/\.psd$/i.test(u.pathname)) throw Error('Provide a direct PSD, Google Drive or storage.to link');
    return u;
  }
  const PUBLIC_MIRROR_SHA256 = 'b5f50a5dc500ee2c45d1c817213995ab092a33b754febc903aa5e861b20757d4';
  async function checkMirror(bytes) {
    if (bytes.byteLength !== 40062699) throw Error('Mirror size does not match archived original');
    if (!crypto.subtle?.digest) throw Error('Browser cannot verify mirror SHA-256');
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      b => b.toString(16).padStart(2, '0')).join('');
    if (hash !== PUBLIC_MIRROR_SHA256) throw Error('Mirror content is not the verified original');
    return bytes;
  }
  async function getBytes() {
    const file = $('file')?.files?.[0] || null;
    if (file) {
      if (typeof file.arrayBuffer !== 'function') throw Error('The selected PSD file cannot be read by this browser');
      if (!Number.isFinite(file.size) || file.size > LIMIT) throw Error('PSD is larger than 180 MB or has an invalid size');
      if (file.size < 26) throw Error('Selected PSD is empty or truncated');
      const bytes = await file.arrayBuffer();
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== file.size)
        throw Error('The selected PSD could not be read completely');
      return bytes;
    }
    const link = $('url').value.trim();
    if (!link) throw Error('Attach a PSD file or paste a public HTTPS link before creating animation.');
    const u = sourceURL(link);
    const suffix = '/api/psd-source?url=' + encodeURIComponent(u.href);
    const routes = [];
    if (['files.catbox.moe', 'litter.catbox.moe'].includes(u.hostname)) {
      routes.push(['PSD cache', 'https://spine-psd-cache.spine-animator-f8692224.workers.dev' + suffix]);
      routes.push(['PSD generator', EXPORTER + suffix]);
      // A local browser may reach Catbox even when Cloudflare cannot.
      routes.push(['Direct Catbox', u.href]);
      if (u.hostname === 'files.catbox.moe')
        routes.push(['Alternate Catbox', 'https://litter.catbox.moe' + u.pathname]);
    } else if (['drive.google.com', 'drive.usercontent.google.com'].includes(u.hostname)) {
      routes.push(['Google Drive', 'https://spine-drive-source.spine-animator-f8692224.workers.dev' + suffix]);
    } else if (u.hostname === 'storage.to') {
      routes.push(['Public storage.to', STUDIO + '/api/source?url=' + encodeURIComponent(u.href)]);
    } else {
      routes.push(['PSD download', u.href]);
    }
    const failures = [];
    for (const [name, endpoint] of routes) {
      message('Loading PSD via ' + name + '…');
      try {
        const bytes = (await fetchLimited(endpoint, { method: 'GET' }, LIMIT, name, 45000)).bytes;
        const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 6));
        if (head.length !== 6 || String.fromCharCode(...head.slice(0, 4)) !== '8BPS' ||
            head[4] !== 0 || head[5] !== 1)
          throw Error(name + ': server returned an empty or invalid PSD');
        return bytes;
      } catch (error) { failures.push(error.message); }
    }
    // These mirrors were previously recorded for Cherry. Never substitute them
    // for nf4g80 unless the ENTIRE 40 MB file matches the archived digest.
    if (u.hostname === 'files.catbox.moe' && u.pathname === '/nf4g80.psd') {
      for (const mirror of ['https://storage.to/CVheHAUuY', 'https://storage.to/GzLxDhgMT']) {
        try {
          message('Checking original Cherry backup…');
          const endpoint = STUDIO + '/api/source?url=' + encodeURIComponent(mirror);
          const bytes = (await fetchLimited(endpoint, { method: 'GET' }, LIMIT, 'Cherry backup', 45000)).bytes;
          return await checkMirror(bytes);
        } catch (error) { failures.push(error.message); }
      }
    }
    throw Error('Source unavailable or empty. Choose the original PSD using File, or paste a working public Drive/storage.to link. Routes: ' +
      failures.slice(0, 5).join(' | ').slice(0, 600));
  }
  function canvasOf(img) {
    if (!img) return null;
    if (img instanceof HTMLCanvasElement) return img;
    const width = Number(img.width), height = Number(img.height);
    if (!(width > 0 && height > 0)) return null;
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    if (img.data && img.data.length === width * height * 4)
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), width, height), 0, 0);
    else if (img.canvas instanceof HTMLCanvasElement) c.getContext('2d').drawImage(img.canvas, 0, 0);
    else return null;
    return c;
  }
  function createLayerIdentity(layerName, usedIds) {
    const sourceName = typeof layerName === 'string' ? layerName : String(layerName ?? 'layer');
    if (sourceName.length > 512) throw Error('PSD source layer names must not exceed 512 characters');
    let id = String(sourceName || 'layer').replace(/[^\w.-]/g, '_').slice(0,70) || 'layer';
    const base = id; let suffix = 1;
    while (usedIds.has(id)) id = base + '_' + suffix++;
    usedIds.add(id);
    return { id, sourceName };
  }
  if (window.__SA_TEST_MODE__ === true)
    window.__SA_TEST_HOOKS__ = Object.freeze({ createLayerIdentity });

  function parse(buffer) {
    const signature = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4));
    if (signature.length !== 4 || String.fromCharCode(...signature) !== '8BPS')
      throw Error('Invalid PSD header');
    const parser = window.agPsd || window['ag-psd'];
    if (!parser?.readPsd) throw Error('PSD parser failed to load');
    const psd = parser.readPsd(buffer, { useImageData: true, skipThumbnail: true });
    if (!(psd.width > 0 && psd.height > 0) || psd.width * psd.height > 25000000)
      throw Error('Unsupported PSD dimensions');
    // ag-psd may expose a reduced preview in imageData while the parsed
    // document canvas and layer bounds retain full-resolution coordinates.
    // Never send a preview to the planner: its scene origin must match the
    // original PSD canvas used by the ZIP exporter.
    const compositeCandidates = [psd.imageData, psd.canvas, psd]
      .map(canvasOf).filter(Boolean);
    const composite = compositeCandidates.find(candidate =>
      candidate.width === psd.width && candidate.height === psd.height);
    if (!composite) {
      const sizes = compositeCandidates.map(candidate =>
        candidate.width + '×' + candidate.height).join(', ') || 'none';
      throw Error('PSD composite dimensions do not match original canvas ' +
        psd.width + '×' + psd.height + ' (candidates: ' + sizes + ')');
    }
    const layers = [], sheetItems = [], names = new Set();
    function walk(container, visible = true, opacity = 1) {
      for (const layer of (container.children || []).slice().reverse()) {
        const enabled = visible && layer.hidden !== true;
        if (!enabled) continue;
        if (layer.blendMode && !['normal', 'pass through'].includes(layer.blendMode))
          throw Error('Rasterize unsupported blend mode: ' + layer.blendMode);
        let alpha = layer.opacity === undefined ? 1 : Number(layer.opacity);
        if (alpha > 1) alpha /= 255;
        alpha = Math.max(0, Math.min(1, alpha * opacity));
        if (layer.children && layer.children.length) { walk(layer, enabled, alpha); continue; }
        const original = canvasOf(layer.imageData || layer.canvas || layer);
        if (!original) continue;
        const canvas = document.createElement('canvas');
        canvas.width = original.width; canvas.height = original.height;
        const context = canvas.getContext('2d');
        context.globalAlpha = alpha; context.drawImage(original, 0, 0);
        const { id, sourceName } = createLayerIdentity(layer.name, names);
        const sourceIndex = layers.length;
        const layerImage = canvas.toDataURL('image/png');
        layers.push({ id, sourceName, sourceIndex, image: layerImage,
          bounds: { x: Number(layer.left || 0), y: Number(layer.top || 0),
            width: canvas.width, height: canvas.height } });
        sheetItems.push({ id, canvas });
      }
    }
    walk(psd);
    if (!layers.length || layers.length > 250) throw Error('PSD needs 1..250 visible raster layers');
    let layerSheet = null;
    if (layers.length > 7) {
      const columns = Math.min(10, Math.max(4, Math.ceil(Math.sqrt(layers.length * 1.5))));
      const cellWidth = 180, cellHeight = 150;
      const rows = Math.ceil(sheetItems.length / columns);
      const sheet = document.createElement('canvas');
      sheet.width = columns * cellWidth;
      sheet.height = rows * cellHeight;
      const ctx = sheet.getContext('2d');
      ctx.fillStyle = '#e5e7eb';
      ctx.fillRect(0, 0, sheet.width, sheet.height);
      for (let index = 0; index < sheetItems.length; index++) {
        const item = sheetItems[index];
        const x = (index % columns) * cellWidth;
        const y = Math.floor(index / columns) * cellHeight;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x + 4, y + 4, cellWidth - 8, cellHeight - 8);
        const ix = x + 10, iy = y + 10, iw = cellWidth - 20, ih = cellHeight - 44;
        const tile = 12;
        for (let ty = 0; ty < ih; ty += tile) {
          for (let tx = 0; tx < iw; tx += tile) {
            ctx.fillStyle = ((Math.floor(tx / tile) + Math.floor(ty / tile)) % 2) ? '#e5e7eb' : '#f8fafc';
            ctx.fillRect(ix + tx, iy + ty, Math.min(tile, iw - tx), Math.min(tile, ih - ty));
          }
        }
        const scale = Math.min(iw / item.canvas.width, ih / item.canvas.height, 1);
        const dw = item.canvas.width * scale, dh = item.canvas.height * scale;
        ctx.drawImage(item.canvas, ix + (iw - dw) / 2, iy + (ih - dh) / 2, dw, dh);
        ctx.fillStyle = '#111827';
        ctx.font = '12px monospace';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(index + 1).padStart(2, '0') + ' ' + item.id, x + 10, y + cellHeight - 22, cellWidth - 20);
      }
      layerSheet = sheet.toDataURL('image/png');
    }
    return { width: psd.width, height: psd.height, composite, layers, layerSheet };
  }
  // The AI model may time out on complex PSDs. This explicitly labelled
  // technical motion preserves every original source layer at frame zero.
  // It is not an artistic animation or a substitute for the user's prompt.
  function loadSpinePlayer() {
    if (window.spine && typeof window.spine.SpinePlayer === 'function') return Promise.resolve();
    if (spinePlayerLoader) return spinePlayerLoader;
    spinePlayerLoader = new Promise((resolve, reject) => {
      if (!window.__saSpinePlayerCssLoaded) {
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = 'https://cdn.jsdelivr.net/npm/@esotericsoftware/spine-player@4.3.13/dist/spine-player.css';
        document.head.appendChild(css);
        window.__saSpinePlayerCssLoaded = true;
      }
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@esotericsoftware/spine-player@4.3.13/dist/iife/spine-player.js';
      script.async = true;
      script.onload = () => {
        if (window.spine && typeof window.spine.SpinePlayer === 'function') resolve();
        else reject(Error('Spine 4.3 runtime loaded without SpinePlayer'));
      };
      script.onerror = () => reject(Error('Spine 4.3 runtime CDN could not be loaded'));
      document.head.appendChild(script);
    }).catch(error => {
      spinePlayerLoader = null;
      throw error;
    });
    return spinePlayerLoader;
  }

  async function renderSpineWebmPreview(files, requestedAnimation) {
    const Recorder = typeof MediaRecorder === 'function' ? MediaRecorder : window.MediaRecorder;
    if (typeof Recorder !== 'function') throw Error('This browser does not support WebM recording');
    if (!(files instanceof Map)) throw Error('Verified Spine ZIP contents are unavailable');
    const decoder = new TextDecoder();
    const skeletonBytes = files.get('skeleton.json');
    const atlasBytes = files.get('skeleton.atlas');
    if (!skeletonBytes || !atlasBytes) throw Error('Spine ZIP is missing its skeleton or atlas');
    const skeleton = JSON.parse(decoder.decode(skeletonBytes));
    const animationNames = Object.keys(skeleton.animations || {});
    const animationName = animationNames.includes(requestedAnimation) ? requestedAnimation : animationNames[0];
    if (!animationName) throw Error('Spine project contains no animation to preview');
    const atlasText = decoder.decode(atlasBytes);
    const atlasLines = atlasText.split(/\r?\n/);
    const pageNames = [];
    for (let i = 0; i < atlasLines.length; i++) {
      const line = atlasLines[i];
      if (!line || /^\s/.test(line) || !/\.(png|jpe?g|webp)$/i.test(line.trim())) continue;
      const nextMetadata = atlasLines.slice(i + 1).find(candidate => candidate.trim());
      if (nextMetadata && /^\s*(size|format|filter|repeat):/i.test(nextMetadata.trim()))
        pageNames.push(line.trim());
    }
    const imageNames = [...files.keys()].filter(name => /\.(png|jpe?g|webp)$/i.test(name)).sort();
    if (!pageNames.length) throw Error('Spine atlas has no resolvable texture page references');
    const temporaryUrls = [];
    function objectUrl(bytes, type) {
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      temporaryUrls.push(url);
      return url;
    }
    function findPage(name) {
      if (files.has(name)) return name;
      const basename = name.split('/').pop();
      const matches = imageNames.filter(file => file === basename || file.endsWith('/' + basename));
      return matches.length === 1 ? matches[0] : '';
    }
    const pageAssets = pageNames.map(page => {
      if (page.split(/[\\/]/).includes('..')) throw Error('Spine atlas contains an unsafe texture path');
      const file = findPage(page);
      if (!file) throw Error('Spine atlas texture page is missing: ' + page);
      const extension = file.split('.').pop().toLowerCase();
      const mime = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' :
        extension === 'webp' ? 'image/webp' : 'image/png';
      return { page, file, mime };
    });
    const skeletonUrl = objectUrl(skeletonBytes, 'application/json');
    const atlasUrl = objectUrl(atlasBytes, 'text/plain');
    const rawDataURIs = {
      'skeleton.json': skeletonUrl,
      'skeleton.atlas': atlasUrl
    };
    const basenameCounts = new Map();
    const stemCounts = new Map();
    for (const asset of pageAssets) {
      const basename = asset.file.split('/').pop();
      const stem = basename.replace(/\.(png|jpe?g|webp)$/i, '');
      basenameCounts.set(basename, (basenameCounts.get(basename) || 0) + 1);
      stemCounts.set(stem, (stemCounts.get(stem) || 0) + 1);
    }
    for (const asset of pageAssets) {
      const url = objectUrl(files.get(asset.file), asset.mime);
      rawDataURIs[asset.page] = url;
      rawDataURIs['./' + asset.page] = url;
      const basename = asset.file.split('/').pop();
      const stem = basename.replace(/\.(png|jpe?g|webp)$/i, '');
      if (basenameCounts.get(basename) === 1) {
        rawDataURIs[basename] = url;
        rawDataURIs['./' + basename] = url;
      }
      if (stemCounts.get(stem) === 1) {
        rawDataURIs[stem] = url;
        rawDataURIs['./' + stem] = url;
        rawDataURIs['images/' + stem] = url;
        rawDataURIs['./images/' + stem] = url;
      }
    }
    const container = document.createElement('div');
    container.id = 'sa-spine-render-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    container.style.cssText = 'position:fixed;left:-10000px;top:0;width:640px;height:360px;overflow:hidden;pointer-events:none;z-index:-1;';
    document.body.appendChild(container);
    let player = null;
    let stream = null;
    try {
      await loadSpinePlayer();
      player = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('Spine Player did not finish loading within 45 seconds')), 45000);
        try {
          new window.spine.SpinePlayer(container.id, {
            skeleton: 'skeleton.json',
            atlas: 'skeleton.atlas',
            rawDataURIs,
            animation: animationName,
            showControls: false,
            premultipliedAlpha: false,
            preserveDrawingBuffer: true,
            alpha: true,
            backgroundColor: '#00000000',
            viewport: { padLeft: '0%', padRight: '0%', padTop: '0%', padBottom: '0%' },
            success: instance => {
              clearTimeout(timeout);
              resolve(instance);
            },
            error: (instance, error) => {
              clearTimeout(timeout);
              reject(Error('Spine Player failed: ' + String(error || 'unknown runtime error').slice(0, 300)));
            }
          });
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });
      const runtimeData = player.skeleton && player.skeleton.data || player.skeletonData;
      const runtimeNames = Array.isArray(runtimeData?.animations)
        ? runtimeData.animations.map(item => item && item.name).filter(Boolean) : animationNames;
      if (!runtimeNames.includes(animationName)) throw Error('Selected animation is not available in Spine 4.3 runtime');
      if (!player.animationState || typeof player.animationState.setAnimation !== 'function')
        throw Error('Spine Player did not expose its animation state');
      player.animationState.clearTracks();
      player.animationState.setAnimation(0, animationName, true);
      player.paused = false;
      await new Promise(resolve => setTimeout(resolve, 1000));
      let canvas = player.canvas;
      let previousWidth = 0, previousHeight = 0, stableSizeChecks = 0;
      for (let attempt = 0; attempt < 20; attempt++) {
        canvas = player.canvas;
        const width = Number(canvas?.width) || 0;
        const height = Number(canvas?.height) || 0;
        if (width > 0 && width === previousWidth && height === previousHeight) {
          stableSizeChecks++;
          if (stableSizeChecks >= 2) break;
        } else {
          stableSizeChecks = 0;
        }
        previousWidth = width;
        previousHeight = height;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!canvas || stableSizeChecks < 2 || !(canvas.width > 0 && canvas.height > 0) ||
          typeof canvas.captureStream !== 'function')
        throw Error('Spine Player canvas did not reach a stable capturable size');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (gl && typeof gl.readPixels === 'function') {
        try {
          const bufferWidth = gl.drawingBufferWidth || canvas.width;
          const bufferHeight = gl.drawingBufferHeight || canvas.height;
          const width = Math.min(48, bufferWidth);
          const height = Math.min(48, bufferHeight);
          let visible = false;
          for (let gy = 0; gy < 3 && !visible; gy++) {
            for (let gx = 0; gx < 3 && !visible; gx++) {
              const x = Math.max(0, Math.round((bufferWidth - width) * gx / 2));
              const y = Math.max(0, Math.round((bufferHeight - height) * gy / 2));
              const pixels = new Uint8Array(width * height * 4);
              gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
              for (let i = 0; i < pixels.length; i += 4) {
                if (pixels[i + 3] > 0 && (pixels[i] > 0 || pixels[i + 1] > 0 || pixels[i + 2] > 0)) {
                  visible = true;
                  break;
                }
              }
            }
          }
          if (!visible) throw Error('Spine runtime rendered a blank frame');
        } catch (error) {
          if (/blank frame/.test(String(error?.message || error))) throw error;
        }
      }
      const animationObject = typeof runtimeData?.findAnimation === 'function'
        ? runtimeData.findAnimation(animationName)
        : runtimeData?.animations?.find(item => item && item.name === animationName);
      const track = player.animationState.getCurrent ? player.animationState.getCurrent(0) : null;
      const sourceDuration = Number(animationObject?.duration) || Number(track?.animation?.duration) || 0;
      const captureDuration = Math.min(6, Math.max(0.5, sourceDuration || 2));
      player.animationState.clearTracks();
      player.animationState.setAnimation(0, animationName, true);
      player.paused = false;
      await new Promise(resolve => setTimeout(resolve, 100));
      stream = canvas.captureStream(30);
      const mimeCandidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
      const mimeType = typeof Recorder.isTypeSupported === 'function'
        ? mimeCandidates.find(type => Recorder.isTypeSupported(type)) || '' : '';
      const recorder = mimeType ? new Recorder(stream, { mimeType }) : new Recorder(stream);
      const blob = await new Promise((resolve, reject) => {
        const chunks = [];
        recorder.ondataavailable = event => {
          if (event.data && event.data.size > 0) chunks.push(event.data);
        };
        recorder.onerror = event => reject(Error('WebM recording failed: ' +
          String(event?.error?.message || event?.message || 'MediaRecorder error')));
        recorder.onstop = () => resolve(new Blob(chunks, {
          type: recorder.mimeType || mimeType || 'video/webm'
        }));
        try {
          recorder.start(250);
          setTimeout(() => {
            if (recorder.state === 'recording') recorder.stop();
          }, captureDuration * 1000);
        } catch (error) {
          reject(error);
        }
      });
      if (blob.size < 512 || !/^video\/webm/i.test(blob.type || 'video/webm'))
        throw Error('Spine Player returned an empty or invalid WebM recording');
      return { blob, width: canvas.width, height: canvas.height, duration: captureDuration };
    } finally {
      if (stream && typeof stream.getTracks === 'function')
        for (const track of stream.getTracks()) try { track.stop(); } catch {}
      if (player && typeof player.dispose === 'function') try { player.dispose(); } catch {}
      if (container && typeof container.remove === 'function') container.remove();
      for (const url of temporaryUrls) try { URL.revokeObjectURL(url); } catch {}
    }
  }

  async function create() {
    clearDownload();
    $('create').disabled = true;
    let stage = 'input validation';
    try {
      const motion = $('prompt').value.trim();
      if (!motion || motion.length > 20000) throw Error('Enter a motion description (up to 20,000 characters)');
      stage = 'PSD input';
      message('Loading PSD…');
      const rawPSD = await getBytes();
      stage = 'PSD parsing';
      const source = parse(rawPSD);
      source.loadedBytes = rawPSD.byteLength;
      $('layer-count').textContent = String(source.layers.length);
      $('source-size').textContent = source.width + ' × ' + source.height;
      $('source-mode').textContent = 'PSD';
      $('source-name').textContent = $('file').files[0]?.name || $('url').value.trim().split('/').pop().split('?')[0] || 'PSD';
      $('source-bytes').textContent = (source.loadedBytes || 0).toLocaleString('en-US');
      const preview = $('preview');
      preview.width = source.width; preview.height = source.height;
      preview.getContext('2d').drawImage(source.composite, 0, 0);
      preview.hidden = false;
      const request = JSON.stringify({ image: source.composite.toDataURL('image/png'),
        canvas: { width: source.width, height: source.height },
        layers: source.layers.map(({id,image,bounds}) => ({ id, image, bounds })),
        layerSheet: source.layerSheet || undefined, description: motion,
        instructions: 'Preserve original draw order and all source layer pixels. Keep frame-zero setup pose. This MUST be a genuinely animated Spine scene, never static keys: author real translate/rotate/scale/shear or mesh-deform timelines with at least two different numeric poses at distinct timestamps in every requested motion clip. Include anticipation, action, follow-through, settle and return where appropriate. Do not emit duplicate keys or empty animations. Verify evaluated poses differ over time while frame zero matches the source. Do not fake 360-degree depth. If returning visual analysis, analysis.subject MUST be an object with a non-empty kind string and finite confidence from 0 to 1; use kind unknown and confidence 0 when semantics are uncertain. analysis.parts MUST be an array; every part needs id, kind, confidence, layerIds and chains arrays. Every chain must have at least two finite in-bounds points. Never return subject as a plain string. If a labeled layer contact sheet is attached, use it only to identify source layers; never include the sheet as a source asset.' });
      if (request.length > 19 * 1024 * 1024) throw Error('PSD exceeds cloud planning limit');
      stage = 'AI planning';
      message('Cloud animation in progress…');
      let plan;
      try {
        plan = await requestAIPlan(request, source);
      } catch (error) {
        // Network failures, invalid AI schemas and source-preservation failures
        // all fail closed. A schema mismatch gets one explicit AI repair request;
        // no technical or template ZIP is ever created.
        throw Error('AI planning failed closed: ' + (error?.message || String(error)) +
          '. No technical fallback ZIP was created.');
      }
      const exportBody = JSON.stringify({ canvas: { width: source.width, height: source.height },
        scene: plan.scene, layers: source.layers,
        sourceLayers: source.layers.map(layer => ({ id: layer.id, sourceName: layer.sourceName,
          sourceIndex: layer.sourceIndex, kind: 'raster', visible: true, opacity: 255,
          bounds: layer.bounds })) });
      if (exportBody.length > 19 * 1024 * 1024) throw Error('Export payload is too large');
      stage = 'Spine ZIP export';
      message('Exporting Spine ZIP…');
      const result = await fetchLimited(EXPORTER + '/api/build', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: exportBody
      }, 200 * 1024 * 1024, 'Spine ZIP exporter', 45000);
      const sig = new Uint8Array(result.bytes, 0, 4);
      if (sig.length < 4 || sig[0] !== 80 || sig[1] !== 75 || sig[2] !== 3 || sig[3] !== 4)
        throw Error('Server did not return a valid ZIP header');
      const optimizedAudit = await inspectSpineZip(result.bytes, plan.scene.clips, source);
      result.bytes = optimizedAudit.bytes;
      const animationAudit = optimizedAudit.report;
      console.info('SPINE_ANIMATION_CONTENT_AUDIT', animationAudit);
      downloadURL = URL.createObjectURL(new Blob([result.bytes], { type: 'application/zip' }));
      $('download').href = downloadURL;
      $('download').hidden = false;
      message('ZIP ready. Rendering Spine 4.3 WebM preview…');
      try {
        const selectedAnimation = animationAudit.animationNames[0];
        const preview = await renderSpineWebmPreview(optimizedAudit.files, selectedAnimation);
        await attachWebmPreview({
          ...preview,
          files: optimizedAudit.files,
          animationNames: animationAudit.animationNames,
          selectedAnimation
        });
        message('ZIP ready. WebM preview ready. Check import in Spine Editor 4.3.26 before production.');
      } catch (previewError) {
        message('ZIP ready. WebM preview unavailable: ' +
          String(previewError?.message || previewError).slice(0, 220));
      }
    } catch (error) {
      const detail = error?.name === 'AbortError' ? '15-second network timeout' :
        (error?.message || String(error));
      message('Generation failed [' + stage + ']: ' + detail);
    } finally {
      $('create').disabled = false;
    }
  }
  $('create').addEventListener('click', create);
  $('prompt').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); create(); } });
  $('file').addEventListener('change', () => { $('url').value = ''; clearDownload(); });
  $('url').addEventListener('change', () => { $('file').value = ''; clearDownload(); });
  $('prompt').addEventListener('input', clearDownload);

  // Conversation layer: preserves the existing PSD/Spine execution path.
  const chatHistory = $('chat-history');
  const chatWelcome = $('chat-welcome');
  let chatStatusBubble = null;
  let chatResultBubble = null;
  let pendingWebmPreview = null;
  let chatPreviewVideo = null;
  let chatPreviewDownloadLink = null;
  let chatPreviewAnimationSelect = null;
  let chatPreviewSpeedSelect = null;
  let chatPreviewScale = null;
  function chatAppend(text, kind) {
    const value = String(text || '').trim();
    if (!value || !chatHistory) return null;
    // Attaching a source must not collapse the welcome block before the
    // user's next pointer gesture; that layout shift can move Animate mid-click.
    if (kind !== 'attachment') {
      document.body.classList.add('has-chat-content');
      if (chatWelcome) chatWelcome.hidden = true;
    }
    const node = document.createElement('div');
    node.className = kind === 'attachment' ? 'chat-attachment-message' :
      kind === 'assistant' ? 'chat-assistant-message' : 'chat-user-message';
    node.textContent = value;
    chatHistory.appendChild(node);
    // Appending a source attachment must not smooth-scroll the viewport: that moves
    // the composer under an in-flight pointer gesture and can drop the Animate click.
    if (kind !== 'attachment') node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return node;
  }
  const chatPrompt = $('prompt');
  const chatCreate = $('create');
  const chatFile = $('file');
  const chatUrl = $('url');
  const chatStatus = $('status');
  const chatDownload = $('download');
  let lastChatPrompt = '';
  let lastChatSubmittedAt = 0;
  function clearChatResult() {
    if (chatResultBubble) { chatResultBubble.remove(); chatResultBubble = null; }
    if (chatStatusBubble) { chatStatusBubble.remove(); chatStatusBubble = null; }
    if (webmPreviewURL) { URL.revokeObjectURL(webmPreviewURL); webmPreviewURL = null; }
    pendingWebmPreview = null;
    chatPreviewVideo = null;
    chatPreviewDownloadLink = null;
    chatPreviewAnimationSelect = null;
    chatPreviewSpeedSelect = null;
    chatPreviewScale = null;
  }
  async function attachWebmPreview(payload) {
    if (!payload || !payload.blob) return;
    pendingWebmPreview = payload;
    if (!chatResultBubble) return;
    if (!chatPreviewVideo) {
      const panel = document.createElement('div');
      panel.style.cssText = 'display:flex;flex-direction:column;gap:9px;width:100%;margin-top:12px;';
      const controls = document.createElement('div');
      controls.style.cssText = 'display:flex;align-items:center;gap:9px;flex-wrap:wrap;';
      if (Array.isArray(payload.animationNames) && payload.animationNames.length > 1) {
        const animationLabel = document.createElement('label');
        animationLabel.textContent = 'Animation';
        animationLabel.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;';
        const select = document.createElement('select');
        select.style.cssText = 'max-width:220px;background:#101012;color:#f3f1ee;border:1px solid #454047;border-radius:8px;padding:6px;';
        for (const name of payload.animationNames) {
          const option = document.createElement('option');
          option.value = name;
          option.textContent = name;
          select.appendChild(option);
        }
        select.value = payload.selectedAnimation || payload.animationNames[0];
        select.addEventListener('change', async () => {
          const current = pendingWebmPreview;
          if (!current || !current.files) return;
          select.disabled = true;
          message('Rendering WebM preview: ' + select.value + '…');
          try {
            const selectedAnimation = select.value;
            const next = await renderSpineWebmPreview(current.files, selectedAnimation);
            await attachWebmPreview({
              ...next,
              files: current.files,
              animationNames: current.animationNames,
              selectedAnimation
            });
            message('ZIP ready. WebM preview ready: ' + selectedAnimation + '.');
          } catch (error) {
            message('ZIP ready. WebM preview failed: ' + String(error?.message || error).slice(0, 220));
          } finally {
            select.disabled = false;
          }
        });
        animationLabel.appendChild(select);
        controls.appendChild(animationLabel);
        chatPreviewAnimationSelect = select;
      }
      const speedLabel = document.createElement('label');
      speedLabel.textContent = 'Speed';
      speedLabel.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;';
      const speed = document.createElement('select');
      speed.style.cssText = 'background:#101012;color:#f3f1ee;border:1px solid #454047;border-radius:8px;padding:6px;';
      for (const rate of ['0.5', '0.75', '1', '1.25', '1.5', '2']) {
        const option = document.createElement('option');
        option.value = rate;
        option.textContent = rate + '×';
        speed.appendChild(option);
      }
      speed.value = '1';
      speed.addEventListener('change', () => {
        if (chatPreviewVideo) chatPreviewVideo.playbackRate = Number(speed.value);
      });
      speedLabel.appendChild(speed);
      controls.appendChild(speedLabel);
      chatPreviewSpeedSelect = speed;
      const scaleLabel = document.createElement('label');
      scaleLabel.textContent = 'Scale';
      scaleLabel.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;';
      const scale = document.createElement('input');
      scale.type = 'range';
      scale.min = '75';
      scale.max = '150';
      scale.step = '5';
      scale.value = '100';
      scale.setAttribute('aria-label', 'Preview scale');
      scale.addEventListener('input', () => {
        if (chatPreviewVideo) chatPreviewVideo.style.transform = 'scale(' + (Number(scale.value) / 100) + ')';
      });
      scaleLabel.appendChild(scale);
      controls.appendChild(scaleLabel);
      chatPreviewScale = scale;
      const video = document.createElement('video');
      video.controls = true;
      video.loop = true;
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.style.cssText = 'display:block;width:100%;max-height:420px;object-fit:contain;background:#080808;border:1px solid #2c2c31;border-radius:12px;transform-origin:center;';
      const link = document.createElement('a');
      link.className = 'chat-result-link';
      link.textContent = 'Download WebM preview';
      link.style.cssText = 'display:inline-block;margin-top:2px;';
      panel.appendChild(controls);
      panel.appendChild(video);
      panel.appendChild(link);
      chatResultBubble.appendChild(panel);
      chatPreviewVideo = video;
      chatPreviewDownloadLink = link;
    }
    if (webmPreviewURL) URL.revokeObjectURL(webmPreviewURL);
    webmPreviewURL = URL.createObjectURL(payload.blob);
    chatPreviewVideo.src = webmPreviewURL;
    await new Promise((resolve, reject) => {
      const video = chatPreviewVideo;
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.removeEventListener('loadeddata', onReady);
        video.removeEventListener('error', onError);
        callback(value);
      };
      const onReady = () => finish(resolve);
      const onError = () => finish(reject, Error('WebM video decode failed' +
        (video.error?.code ? ' (MediaError ' + video.error.code + ')' : '')));
      const timer = setTimeout(() => finish(reject, Error('WebM preview did not decode within 15 seconds')),
        15000);
      video.addEventListener('loadeddata', onReady);
      video.addEventListener('error', onError);
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) onReady();
      else video.load();
    });
    chatPreviewVideo.style.aspectRatio = Math.max(1, Number(payload.width) || 16) + ' / ' +
      Math.max(1, Number(payload.height) || 9);
    chatPreviewVideo.playbackRate = chatPreviewSpeedSelect ? Number(chatPreviewSpeedSelect.value) : 1;
    chatPreviewVideo.style.transform = 'scale(' +
      (chatPreviewScale ? Number(chatPreviewScale.value) / 100 : 1) + ')';
    if (chatPreviewDownloadLink) {
      const safeName = String(payload.selectedAnimation || 'preview').replace(/[^a-z0-9._-]+/gi, '-');
      chatPreviewDownloadLink.href = webmPreviewURL;
      chatPreviewDownloadLink.download = 'spine-' + safeName + '-preview.webm';
    }
    if (chatPreviewAnimationSelect && payload.selectedAnimation)
      chatPreviewAnimationSelect.value = payload.selectedAnimation;
    const play = chatPreviewVideo.play();
    if (play && typeof play.catch === 'function') play.catch(() => {});
  }
  function submitChatPrompt() {
    const value = chatPrompt?.value?.trim();
    const now = Date.now();
    if (!value || (value === lastChatPrompt && now - lastChatSubmittedAt < 1200)) return;
    lastChatPrompt = value;
    lastChatSubmittedAt = now;
    clearChatResult();
    chatAppend(value, 'user');
  }
  if (chatCreate) chatCreate.addEventListener('click', submitChatPrompt, true);
  if (chatPrompt) chatPrompt.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') submitChatPrompt();
  }, true);
  if (chatFile) chatFile.addEventListener('change', () => {
    const file = chatFile.files && chatFile.files[0];
    if (file) { clearChatResult(); chatAppend('Attached PSD: ' + file.name, 'attachment'); }
  });
  if (chatUrl) chatUrl.addEventListener('change', () => {
    const value = chatUrl.value.trim();
    if (value) { clearChatResult(); chatAppend('Source link: ' + value, 'attachment'); }
  });
  if (chatStatus && typeof MutationObserver === 'function') {
    const observer = new MutationObserver(() => {
      const value = chatStatus.textContent.trim();
      if (!value) return;
      document.body.classList.add('has-chat-content');
      if (!chatStatusBubble) {
        chatStatusBubble = document.createElement('div');
        chatStatusBubble.className = 'chat-assistant-message chat-progress-message';
        chatHistory.appendChild(chatStatusBubble);
      }
      chatStatusBubble.textContent = value;
    });
    observer.observe(chatStatus, { childList: true, characterData: true, subtree: true });
  }
  if (chatDownload && typeof MutationObserver === 'function') {
    const observer = new MutationObserver(() => {
      if (chatDownload.hidden || !chatDownload.href || chatResultBubble) return;
      chatResultBubble = document.createElement('div');
      chatResultBubble.className = 'chat-assistant-message chat-result-message';
      const label = document.createElement('strong');
      label.textContent = 'Spine project package ready';
      const link = document.createElement('a');
      link.href = chatDownload.href;
      link.textContent = 'Download Spine project';
      link.className = 'chat-result-link';
      link.setAttribute('download', chatDownload.getAttribute('download') || 'spine-project.zip');
      chatResultBubble.append(label, document.createTextNode(' '), link);
      chatHistory.appendChild(chatResultBubble);
      if (pendingWebmPreview) attachWebmPreview(pendingWebmPreview);
    });
    observer.observe(chatDownload, { attributes: true, attributeFilter: ['href', 'hidden', 'download'] });
  }
})();
