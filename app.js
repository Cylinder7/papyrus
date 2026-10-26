/* ============================================================
   Papyrus Text Replacer — app.js
   Fully client-side: OCR (Tesseract.js) -> cover text with
   sampled background -> re-render text in Papyrus on canvas.
   No backend, no API keys. Everything stays on the device.
   ============================================================ */
(() => {
  'use strict';

  /* ------------------------- constants ------------------------- */
  const FONT_DEFAULT = "'Papyrus', cursive";
  const MIN_BBOX_HEIGHT = 8;      // px at full resolution — smaller detections are skipped silently
  const MIN_BBOX_WIDTH = 2;
  const MIN_FONT_SIZE = 8;        // px floor for the fitted font size
  const WIDTH_TOLERANCE = 1.10;   // fitted text may span up to 110% of the original bbox width
  const RING_PX = 3;              // thickness of the background-sampling ring around each bbox
  const BG_VARIANCE = 16;         // avg RGB distance from ring median before switching to per-row lerp
  const TEXT_COLOR_DIST = 90;     // euclidean RGB distance from bg for a pixel to count as "text"
  const OCR_MAX_DIM = 4000;       // above this, OCR runs on a downscaled copy (rendering stays full-res)
  const OCR_SMALL_DIM = 900;      // below this, the OCR copy is gently upscaled for accuracy
  const OCR_SMALL_TARGET = 1600;
  const CANVAS_MAX_DIM = 8192;    // hard cap for the working canvas (browser limits)
  const EDITOR_MAX_ROWS = 300;

  const STATUS_LABELS = {
    'loading tesseract core': 'Loading OCR engine…',
    'initializing tesseract': 'Initializing OCR engine…',
    'loading language traineddata': 'Loading English language data (first run downloads it once)…',
    'loading language traineddata (from cache)': 'Loading English language data…',
    'initializing api': 'Preparing OCR…',
    'recognizing text': 'Recognizing text…',
  };

  /* --------------------------- dom ----------------------------- */
  const $ = (id) => document.getElementById(id);
  const els = {
    dropZone: $('dropZone'), fileInput: $('fileInput'),
    stageUpload: $('stageUpload'), stageWork: $('stageWork'),
    fontChip: $('fontChip'), fontChipText: $('fontChipText'),
    confSlider: $('confSlider'), confValue: $('confValue'),
    modeWord: $('modeWord'), modeLine: $('modeLine'), fontSelect: $('fontSelect'),
    reRunBtn: $('reRunBtn'),
    progressCard: $('progressCard'), progressLabel: $('progressLabel'),
    progressPct: $('progressPct'), progressBar: $('progressBar'),
    noTextNote: $('noTextNote'),
    origImg: $('origImg'), resultCanvas: $('resultCanvas'),
    downloadBtn: $('downloadBtn'), resetBtn: $('resetBtn'), dimsNote: $('dimsNote'),
    editorDetails: $('editorDetails'), editorList: $('editorList'),
    detCount: $('detCount'), applyEditsBtn: $('applyEditsBtn'),
    toasts: $('toasts'),
  };

  const state = {
    status: 'idle',               // idle | busy | done | error
    fileName: null,
    origCanvas: null, origCtx: null,
    workCanvas: null, workCtx: null,
    ocrScale: 1,
    rawWords: [],
    groupsWord: [], groupsLine: [],
    objectUrl: null,
    worker: null,
    papyrusOK: false,
    errorMsg: null,
  };

  /* debugging/testing hook */
  window.__papyrusApp = { state, handleFile, renderReplacements };

  /* ----------------------- tiny helpers ------------------------ */
  function toast(msg, type = 'info', ms = 5000) {
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.textContent = msg;
    els.toasts.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 350);
    }, ms);
  }

  function setProgress(label, frac) {
    els.progressCard.hidden = false;
    els.progressLabel.textContent = label;
    if (frac == null) {
      els.progressBar.classList.add('indeterminate');
      els.progressBar.style.width = '100%';
      els.progressPct.textContent = '';
    } else {
      els.progressBar.classList.remove('indeterminate');
      const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
      els.progressBar.style.width = pct + '%';
      els.progressPct.textContent = pct + '%';
    }
  }

  function hideProgress() { els.progressCard.hidden = true; }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  const dist2 = (a, b) => {
    const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    return dr * dr + dg * dg + db * db;
  };

  function medianColor(pixels) {
    if (!pixels.length) return null;
    const ch = (i) => {
      const arr = pixels.map((p) => p[i]).sort((a, b) => a - b);
      return arr[arr.length >> 1];
    };
    return [ch(0), ch(1), ch(2)];
  }

  function avgColor(list) {
    let r = 0, g = 0, b = 0;
    for (const p of list) { r += p[0]; g += p[1]; b += p[2]; }
    const n = list.length;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  }

  function pushTo(map, key, val) {
    let a = map.get(key);
    if (!a) { a = []; map.set(key, a); }
    a.push(val);
  }

  /* ----------------------- papyrus font ------------------------ */
  /* Metric-based availability check: if the family resolves, its
     glyph widths differ from the generic fallback fonts.           */
  function fontMetricsAvailable(family) {
    const ctx = makeCanvas(20, 20).getContext('2d');
    const sample = 'mmmmmmmmmmlli W@Papyrus 123';
    for (const ref of ['monospace', 'serif', 'sans-serif']) {
      ctx.font = `72px ${ref}`;
      const wRef = ctx.measureText(sample).width;
      ctx.font = `72px "${family}", ${ref}`;
      const wTest = ctx.measureText(sample).width;
      if (Math.abs(wTest - wRef) > 0.5) return true;
    }
    return false;
  }

  async function ensurePapyrusFont() {
    try {
      await document.fonts.load("64px 'Papyrus'", 'Papyrus 123');
    } catch (_) { /* fetch failure — fall through to the metric check */ }
    state.papyrusOK = fontMetricsAvailable('Papyrus');
    els.fontChip.classList.toggle('chip-ok', state.papyrusOK);
    els.fontChip.classList.toggle('chip-warn', !state.papyrusOK);
    els.fontChipText.textContent = state.papyrusOK
      ? 'Papyrus font loaded'
      : 'Papyrus unavailable — cursive fallback';
    if (!state.papyrusOK) {
      toast('Could not load the Papyrus webfont. Text will be rendered with a cursive fallback instead.', 'warn', 8000);
    }
    return state.papyrusOK;
  }

  /* ----------------------- image loading ----------------------- */
  function decodeImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image decode failed')); };
      img.src = url;
    });
  }

  async function handleFile(file) {
    if (!file) return;
    if (state.status === 'busy') {
      toast('Still processing the previous image — one moment.', 'info', 3000);
      return;
    }
    const okType = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
      /\.(png|jpe?g|webp)$/i.test(file.name || '');
    if (!okType) {
      toast('Unsupported file type — please choose a PNG, JPG or WEBP image.', 'error');
      return;
    }
    if (file.size > 40 * 1024 * 1024) {
      toast('That file is over 40 MB — please use a smaller image.', 'error');
      return;
    }
    if (typeof Tesseract === 'undefined') {
      toast('The OCR engine (Tesseract.js) failed to load from its CDN. Check your internet connection and reload the page.', 'error', 9000);
      return;
    }

    state.status = 'busy';
    state.errorMsg = null;
    els.downloadBtn.disabled = true;
    els.noTextNote.hidden = true;

    let img;
    try {
      img = await decodeImage(file);
    } catch (_) {
      toast('Could not read that image file — it may be corrupt or an unsupported format.', 'error');
      state.status = 'error';
      return;
    }
    const natW = img.naturalWidth, natH = img.naturalHeight;
    if (!natW || !natH) {
      toast('Invalid image.', 'error');
      state.status = 'error';
      return;
    }

    let scale = 1;
    if (Math.max(natW, natH) > CANVAS_MAX_DIM) {
      scale = CANVAS_MAX_DIM / Math.max(natW, natH);
      toast('Very large image — processing at reduced resolution for stability.', 'warn', 7000);
    }
    const W = Math.max(1, Math.round(natW * scale));
    const H = Math.max(1, Math.round(natH * scale));

    state.fileName = (file.name || 'image').replace(/\.[^.]+$/, '');
    state.origCanvas = makeCanvas(W, H);
    state.origCtx = state.origCanvas.getContext('2d', { willReadFrequently: true });
    state.origCtx.drawImage(img, 0, 0, W, H);
    state.workCanvas = makeCanvas(W, H);
    state.workCtx = state.workCanvas.getContext('2d', { willReadFrequently: true });
    state.rawWords = [];
    state.groupsWord = [];
    state.groupsLine = [];

    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = URL.createObjectURL(file);
    els.origImg.src = state.objectUrl;
    els.resultCanvas.width = W;
    els.resultCanvas.height = H;
    els.dimsNote.textContent = `${W} × ${H} px`;
    els.editorList.textContent = '';
    els.detCount.textContent = '0';
    els.editorDetails.hidden = true;
    els.editorDetails.open = false;

    els.stageUpload.hidden = true;
    els.stageWork.hidden = false;
    setProgress('Starting…', null);

    try {
      await ensurePapyrusFont();
      await runOcr();
    } catch (err) {
      console.error(err);
      state.errorMsg = String((err && err.message) || err);
      state.status = 'error';
      setProgress('Something went wrong', null);
      toast('Processing failed: ' + state.errorMsg + ' — if this mentions a network error, check your connection (the OCR engine loads from a CDN on first use).', 'error', 10000);
    }
  }

  /* ---------------------------- ocr ---------------------------- */
  async function getWorker() {
    if (state.worker) return state.worker;
    state.worker = await Tesseract.createWorker('eng', 1, {
      logger: (m) => {
        if (!m || !m.status) return;
        const label = STATUS_LABELS[m.status] || m.status;
        setProgress(label, typeof m.progress === 'number' ? m.progress : null);
      },
    });
    return state.worker;
  }

  function buildOcrCanvas(src) {
    const maxDim = Math.max(src.width, src.height);
    let s = 1;
    if (maxDim > OCR_MAX_DIM) s = OCR_MAX_DIM / maxDim;
    else if (maxDim < OCR_SMALL_DIM) s = Math.min(OCR_SMALL_TARGET / maxDim, 3);
    if (Math.abs(s - 1) < 0.001) return { canvas: src, scale: 1 };
    const c = makeCanvas(Math.round(src.width * s), Math.round(src.height * s));
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(src, 0, 0, c.width, c.height);
    return { canvas: c, scale: c.width / src.width };
  }

  async function runOcr() {
    state.status = 'busy';
    const worker = await getWorker();
    const { canvas: ocrCanvas, scale } = buildOcrCanvas(state.origCanvas);
    state.ocrScale = scale;
    setProgress('Recognizing text…', 0);

    const { data } = await worker.recognize(ocrCanvas, {}, { text: true, blocks: true });

    state.rawWords = extractWords(data, scale);
    state.groupsWord = state.rawWords.map((w, i) => ({ ...w, uid: 'w' + i, include: true, size: null }));
    state.groupsLine = extractLines(data, scale).map((l, i) => ({ ...l, uid: 'l' + i, include: true, size: null }));
    if (!state.groupsLine.length && state.groupsWord.length) {
      state.groupsLine = linesFromWords(state.groupsWord);
    }

    if (!state.rawWords.length) {
      els.noTextNote.hidden = false;
      els.detCount.textContent = '0';
      els.editorDetails.hidden = true;
      state.workCtx.drawImage(state.origCanvas, 0, 0);
      blitResult();
      setProgress('Done', 1);
      setTimeout(hideProgress, 900);
      state.status = 'done';
      toast('No text detected in this image.', 'warn', 7000);
      return;
    }

    buildEditor();
    renderReplacements();
    setProgress('Done', 1);
    setTimeout(hideProgress, 900);
    state.status = 'done';
    toast(`Found ${state.rawWords.length} text region${state.rawWords.length === 1 ? '' : 's'} — rendered in Papyrus.`, 'success', 4000);
  }

  /* Tesseract v6 returns a blocks hierarchy; v5 also has data.words.
     Support both shapes.                                          */
  function collectFromBlocks(data, want) {
    const out = [];
    const blocks = data && Array.isArray(data.blocks) ? data.blocks : [];
    for (const b of blocks) {
      const paras = Array.isArray(b.paragraphs) ? b.paragraphs : [];
      for (const p of paras) {
        const lines = Array.isArray(p.lines) ? p.lines : [];
        for (const l of lines) {
          if (want === 'lines') out.push(l);
          const words = Array.isArray(l.words) ? l.words : [];
          if (want === 'words') for (const w of words) out.push(w);
        }
      }
    }
    return out;
  }

  function scaledBbox(bb, scale) {
    return {
      x0: Math.round((bb.x0 || 0) / scale), y0: Math.round((bb.y0 || 0) / scale),
      x1: Math.round((bb.x1 || 0) / scale), y1: Math.round((bb.y1 || 0) / scale),
    };
  }

  function extractWords(data, scale) {
    const raw = (Array.isArray(data && data.words) && data.words.length)
      ? data.words
      : collectFromBlocks(data, 'words');
    const out = [];
    for (const w of raw) {
      const text = String(w.text || '').replace(/\s+/g, ' ').trim();
      if (!text || !/[\p{L}\p{N}]/u.test(text)) continue;
      const bbox = scaledBbox(w.bbox || {}, scale);
      if (bbox.x1 - bbox.x0 < MIN_BBOX_WIDTH || bbox.y1 - bbox.y0 < MIN_BBOX_HEIGHT) continue;
      const conf = typeof w.confidence === 'number' ? w.confidence : 0;
      out.push({ text, conf, bbox });
    }
    return out;
  }

  function extractLines(data, scale) {
    const raw = collectFromBlocks(data, 'lines');
    const out = [];
    for (const l of raw) {
      const words = Array.isArray(l.words) ? l.words : [];
      const text = (String(l.text || '') || words.map((w) => w.text).join(' '))
        .replace(/\s+/g, ' ').trim();
      if (!text || !/[\p{L}\p{N}]/u.test(text)) continue;
      const bbox = scaledBbox(l.bbox || {}, scale);
      if (bbox.x1 - bbox.x0 < MIN_BBOX_WIDTH || bbox.y1 - bbox.y0 < MIN_BBOX_HEIGHT) continue;
      let conf = typeof l.confidence === 'number' ? l.confidence : null;
      if (conf == null && words.length) {
        conf = words.reduce((s, w) => s + (typeof w.confidence === 'number' ? w.confidence : 0), 0) / words.length;
      }
      out.push({ text, conf: conf || 0, bbox });
    }
    return out;
  }

  /* Fallback line builder if Tesseract gave words but no line objects. */
  function linesFromWords(words) {
    const sorted = [...words].sort((a, b) => (a.bbox.y0 - b.bbox.y0) || (a.bbox.x0 - b.bbox.x0));
    const rows = [];
    for (const w of sorted) {
      const wm = (w.bbox.y0 + w.bbox.y1) / 2;
      const wh = w.bbox.y1 - w.bbox.y0;
      const row = rows.find((r) => {
        const rm = (r.bbox.y0 + r.bbox.y1) / 2;
        const rh = r.bbox.y1 - r.bbox.y0;
        return Math.abs(rm - wm) < Math.max(rh, wh) * 0.6;
      });
      if (row) {
        row.words.push(w);
        row.bbox.x0 = Math.min(row.bbox.x0, w.bbox.x0);
        row.bbox.y0 = Math.min(row.bbox.y0, w.bbox.y0);
        row.bbox.x1 = Math.max(row.bbox.x1, w.bbox.x1);
        row.bbox.y1 = Math.max(row.bbox.y1, w.bbox.y1);
      } else {
        rows.push({ words: [w], bbox: { ...w.bbox } });
      }
    }
    return rows.map((r, i) => ({
      uid: 'f' + i,
      text: r.words.map((w) => w.text).join(' '),
      conf: r.words.reduce((s, w) => s + w.conf, 0) / r.words.length,
      bbox: r.bbox,
      include: true,
      size: null,
    }));
  }

  /* --------------------- background covering -------------------- */
  /* Samples a RING_PX ring around the bbox. Low variance -> flat
     median fill. High variance -> per-row horizontal gradient
     between left/right edge colors (simple inpainting).           */
  function coverBackground(ctx, bbox) {
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const bx0 = Math.max(0, Math.floor(bbox.x0)), by0 = Math.max(0, Math.floor(bbox.y0));
    const bx1 = Math.min(W, Math.ceil(bbox.x1)), by1 = Math.min(H, Math.ceil(bbox.y1));
    if (bx1 <= bx0 || by1 <= by0) return null;

    const rx0 = Math.max(0, bx0 - RING_PX), ry0 = Math.max(0, by0 - RING_PX);
    const rx1 = Math.min(W, bx1 + RING_PX), ry1 = Math.min(H, by1 + RING_PX);
    const d = ctx.getImageData(rx0, ry0, rx1 - rx0, ry1 - ry0).data;
    const iw = rx1 - rx0;
    const at = (x, y) => {
      const i = ((y - ry0) * iw + (x - rx0)) * 4;
      return [d[i], d[i + 1], d[i + 2], d[i + 3]];
    };

    const ring = [];
    const leftPerRow = new Map(), rightPerRow = new Map();
    for (let y = by0; y < by1; y++) {
      for (let k = 1; k <= RING_PX; k++) {
        if (bx0 - k >= rx0) { const p = at(bx0 - k, y); if (p[3] > 127) { ring.push(p); pushTo(leftPerRow, y, p); } }
        if (bx1 - 1 + k < rx1) { const p = at(bx1 - 1 + k, y); if (p[3] > 127) { ring.push(p); pushTo(rightPerRow, y, p); } }
      }
    }
    for (let x = bx0; x < bx1; x++) {
      for (let k = 1; k <= RING_PX; k++) {
        if (by0 - k >= ry0) { const p = at(x, by0 - k); if (p[3] > 127) ring.push(p); }
        if (by1 - 1 + k < ry1) { const p = at(x, by1 - 1 + k); if (p[3] > 127) ring.push(p); }
      }
    }

    /* decide the fill color */
    let bg = medianColor(ring);
    if (!bg) {
      /* bbox is flush against the canvas edge with no visible ring —
         fall back to the median of the bbox interior itself */
      const inside = [];
      for (let y = by0; y < by1; y += 2) {
        for (let x = bx0; x < bx1; x += 2) {
          const p = at(x, y);
          if (p[3] > 127) inside.push(p);
        }
      }
      bg = medianColor(inside);
      if (!bg) return null;
    }

    let variance = 0;
    if (ring.length) {
      let acc = 0;
      for (const p of ring) acc += Math.sqrt(dist2(p, bg));
      variance = acc / ring.length;
    }

    /* cover rect expanded by 1px to catch anti-aliased fringes */
    const cx0 = Math.max(0, bx0 - 1), cy0 = Math.max(0, by0 - 1);
    const cx1 = Math.min(W, bx1 + 1), cy1 = Math.min(H, by1 + 1);

    if (variance < BG_VARIANCE || (!leftPerRow.size && !rightPerRow.size)) {
      ctx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
      ctx.fillRect(cx0, cy0, cx1 - cx0, cy1 - cy0);
      return bg;
    }

    /* non-uniform background: per-row lerp between edge colors */
    const topStrip = [], bottomStrip = [];
    for (let x = bx0; x < bx1; x++) {
      for (let k = 1; k <= RING_PX; k++) {
        if (by0 - k >= ry0) { const p = at(x, by0 - k); if (p[3] > 127) topStrip.push(p); }
        if (by1 - 1 + k < ry1) { const p = at(x, by1 - 1 + k); if (p[3] > 127) bottomStrip.push(p); }
      }
    }
    const topColor = medianColor(topStrip) || bg;
    const bottomColor = medianColor(bottomStrip) || bg;

    for (let y = cy0; y < cy1; y++) {
      const L = leftPerRow.has(y) ? avgColor(leftPerRow.get(y)) : null;
      const R = rightPerRow.has(y) ? avgColor(rightPerRow.get(y)) : null;
      if (L && R) {
        const grad = ctx.createLinearGradient(bx0, y, bx1, y);
        grad.addColorStop(0, `rgb(${L[0]},${L[1]},${L[2]})`);
        grad.addColorStop(1, `rgb(${R[0]},${R[1]},${R[2]})`);
        ctx.fillStyle = grad;
      } else if (L || R) {
        const c = L || R;
        ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      } else {
        const c = y < by0 ? topColor : bottomColor;
        ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      }
      ctx.fillRect(cx0, y, cx1 - cx0, 1);
    }
    return bg;
  }

  /* ---------------------- text color matching ------------------- */
  function sampleTextColor(octx, bbox, bg) {
    const W = octx.canvas.width, H = octx.canvas.height;
    const x0 = Math.max(0, Math.floor(bbox.x0)), y0 = Math.max(0, Math.floor(bbox.y0));
    const x1 = Math.min(W, Math.ceil(bbox.x1)), y1 = Math.min(H, Math.ceil(bbox.y1));
    if (x1 <= x0 || y1 <= y0) return fallbackInk(bg || [255, 255, 255]);

    const d = octx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    const thresh = TEXT_COLOR_DIST * TEXT_COLOR_DIST;
    let r = 0, g = 0, b = 0, n = 0;
    let best = null, bestD = -1;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      const p = [d[i], d[i + 1], d[i + 2]];
      const dd = dist2(p, bg);
      if (dd > thresh) { r += p[0]; g += p[1]; b += p[2]; n++; }
      if (dd > bestD) { bestD = dd; best = p; }
    }
    if (n >= 3) return `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
    if (best && bestD > 45 * 45) return `rgb(${best[0]},${best[1]},${best[2]})`;
    return fallbackInk(bg);
  }

  function fallbackInk(bg) {
    const lum = 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2];
    return lum > 140 ? 'rgb(34,34,34)' : 'rgb(238,238,238)';
  }

  /* --------------------- font size + drawing -------------------- */
  function fitFontSize(ctx, text, family, bbox) {
    const targetW = (bbox.x1 - bbox.x0) * WIDTH_TOLERANCE;
    let size = Math.max(MIN_FONT_SIZE, Math.floor((bbox.y1 - bbox.y0) * 0.8));
    ctx.font = `${size}px ${family}`;
    let width = ctx.measureText(text).width;
    while (width > targetW && size > MIN_FONT_SIZE) {
      size -= 1;
      ctx.font = `${size}px ${family}`;
      width = ctx.measureText(text).width;
    }
    return { size, width };
  }

  function drawText(ctx, text, family, size, color, bbox) {
    ctx.save();
    ctx.font = `${size}px ${family}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = color;
    const m = ctx.measureText(text);
    const asc = (typeof m.actualBoundingBoxAscent === 'number' && m.actualBoundingBoxAscent > 0)
      ? m.actualBoundingBoxAscent : size * 0.8;
    const desc = (typeof m.actualBoundingBoxDescent === 'number')
      ? m.actualBoundingBoxDescent : size * 0.2;
    const bw = bbox.x1 - bbox.x0, bh = bbox.y1 - bbox.y0;
    const x = bbox.x0 + Math.max(0, (bw - m.width) / 2);
    const y = bbox.y0 + Math.max(0, (bh - (asc + desc)) / 2) + asc;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  /* -------------------------- rendering ------------------------- */
  function currentMode() { return els.modeLine.checked ? 'line' : 'word'; }

  function currentGroups() {
    const thr = Number(els.confSlider.value);
    const src = currentMode() === 'line' ? state.groupsLine : state.groupsWord;
    return src.filter((g) => g.include && g.conf >= thr && g.text && g.text.trim());
  }

  function renderReplacements() {
    if (!state.origCanvas || !state.workCtx) return;
    const wctx = state.workCtx;
    wctx.clearRect(0, 0, state.workCanvas.width, state.workCanvas.height);
    wctx.drawImage(state.origCanvas, 0, 0);

    const groups = currentGroups();
    if (!groups.length) {
      blitResult();
      els.downloadBtn.disabled = true;
      updateEditorMeta();
      return;
    }

    const family = els.fontSelect.value || FONT_DEFAULT;

    /* pass 1 — cover every bbox with sampled background */
    for (const g of groups) g.bg = coverBackground(wctx, g.bbox);

    /* pass 2 — draw Papyrus text on top of the clean background */
    for (const g of groups) {
      if (!g.text.trim()) continue;
      const color = sampleTextColor(state.origCtx, g.bbox, g.bg || [255, 255, 255]);
      const { size } = fitFontSize(wctx, g.text, family, g.bbox);
      g.size = size;
      drawText(wctx, g.text, family, size, color, g.bbox);
    }

    blitResult();
    els.downloadBtn.disabled = false;
    updateEditorMeta();
  }

  function blitResult() {
    const vc = els.resultCanvas;
    if (vc.width !== state.workCanvas.width || vc.height !== state.workCanvas.height) {
      vc.width = state.workCanvas.width;
      vc.height = state.workCanvas.height;
    }
    vc.getContext('2d').drawImage(state.workCanvas, 0, 0);
  }

  /* --------------------------- editor --------------------------- */
  function metaText(g) {
    const conf = Math.round(g.conf);
    const size = g.size != null ? `${g.size}px` : `${g.bbox.x1 - g.bbox.x0}×${g.bbox.y1 - g.bbox.y0}`;
    return `${conf}% · ${size}`;
  }

  function buildEditor() {
    const list = currentMode() === 'line' ? state.groupsLine : state.groupsWord;
    els.editorList.textContent = '';
    els.detCount.textContent = String(list.length);
    els.editorDetails.hidden = list.length === 0;

    const rows = Math.min(list.length, EDITOR_MAX_ROWS);
    for (let i = 0; i < rows; i++) {
      const g = list[i];

      const row = document.createElement('label');
      row.className = 'editor-row';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = g.include;
      cb.title = 'Include this detection';
      cb.addEventListener('change', () => { g.include = cb.checked; });

      const txt = document.createElement('input');
      txt.type = 'text';
      txt.className = 'editor-text';
      txt.value = g.text;
      txt.addEventListener('input', () => { g.text = txt.value; });

      const meta = document.createElement('span');
      meta.className = 'editor-meta';
      meta.dataset.uid = g.uid;
      meta.textContent = metaText(g);

      row.append(cb, txt, meta);
      els.editorList.appendChild(row);
    }
    if (list.length > rows) {
      const more = document.createElement('p');
      more.className = 'hint';
      more.textContent = `+ ${list.length - rows} more detections not listed (they are still rendered).`;
      els.editorList.appendChild(more);
    }
  }

  function updateEditorMeta() {
    const list = currentMode() === 'line' ? state.groupsLine : state.groupsWord;
    for (const g of list) {
      const meta = els.editorList.querySelector(`.editor-meta[data-uid="${g.uid}"]`);
      if (meta) meta.textContent = metaText(g);
    }
  }

  /* ------------------------- download --------------------------- */
  function downloadPng() {
    if (!state.workCanvas) return;
    state.workCanvas.toBlob((blob) => {
      if (!blob) { toast('Could not export the PNG.', 'error'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${state.fileName || 'image'}-papyrus.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('PNG downloaded.', 'success', 3000);
    }, 'image/png');
  }

  /* --------------------------- reset ---------------------------- */
  function resetAll() {
    state.status = 'idle';
    state.fileName = null;
    state.rawWords = [];
    state.groupsWord = [];
    state.groupsLine = [];
    state.origCanvas = state.origCtx = null;
    state.workCanvas = state.workCtx = null;
    if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }
    els.origImg.removeAttribute('src');
    els.resultCanvas.width = 0;
    els.resultCanvas.height = 0;
    els.dimsNote.textContent = '';
    els.editorList.textContent = '';
    els.detCount.textContent = '0';
    els.editorDetails.hidden = true;
    els.editorDetails.open = false;
    els.noTextNote.hidden = true;
    els.downloadBtn.disabled = true;
    hideProgress();
    els.fileInput.value = '';
    els.stageWork.hidden = true;
    els.stageUpload.hidden = false;
  }

  /* ----------------------- event wiring ------------------------- */
  els.dropZone.addEventListener('click', () => els.fileInput.click());
  els.dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
  });
  els.fileInput.addEventListener('change', () => {
    const f = els.fileInput.files && els.fileInput.files[0];
    if (f) handleFile(f);
  });

  /* drag & drop anywhere on the page */
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    els.dropZone.classList.add('drag');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) els.dropZone.classList.remove('drag');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    els.dropZone.classList.remove('drag');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  /* paste support */
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) {
          e.preventDefault();
          handleFile(new File([f], f.name || 'pasted-image.png', { type: f.type }));
        }
        return;
      }
    }
  });

  els.confSlider.addEventListener('input', () => {
    els.confValue.textContent = els.confSlider.value;
    renderReplacements();
  });
  els.modeWord.addEventListener('change', () => { buildEditor(); renderReplacements(); });
  els.modeLine.addEventListener('change', () => { buildEditor(); renderReplacements(); });
  els.fontSelect.addEventListener('change', () => renderReplacements());
  els.reRunBtn.addEventListener('click', () => renderReplacements());
  els.applyEditsBtn.addEventListener('click', () => {
    renderReplacements();
    toast('Re-rendered with your edits.', 'success', 2500);
  });
  els.downloadBtn.addEventListener('click', downloadPng);
  els.resetBtn.addEventListener('click', resetAll);

  /* font status as soon as the page opens */
  ensurePapyrusFont();
})();
