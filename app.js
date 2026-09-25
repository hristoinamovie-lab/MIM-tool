// Menina Movie — Frame Tool prototype
// No dependencies. Pure Canvas 2D compositing.
// Linear Dodge (Add) in Photoshop == globalCompositeOperation "lighter" in Canvas.
// Layer order per framed slot (bottom -> top): bg (normal, optional) -> photo (clipped to window) -> border (normal, optional) -> frame (lighter/Add) -> logo (normal)

const EXT_BY_TYPE = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" };

const slots = {
  wide:   { canvas: null, ctx: null, w: 1200, h: 675,  img: null, frameImg: null, bgImg: null, borderImg: null, logoImg: null, bleed: 0, scale: 1, offX: 0, offY: 0, baseScale: 1, label: "kadar-1200x675",  hasFrame: true,  window: null },
  tall:   { canvas: null, ctx: null, w: 1080, h: 1350, img: null, frameImg: null, bgImg: null, borderImg: null, logoImg: null, bleed: 0, scale: 1, offX: 0, offY: 0, baseScale: 1, label: "kadar-1080x1350", hasFrame: true,  window: null },
  poster: { canvas: null, ctx: null, w: 600,  h: 900,  img: null, frameImg: null, bgImg: null, borderImg: null, logoImg: null, bleed: 0, scale: 1, offX: 0, offY: 0, baseScale: 1, label: "poster-600x900",  hasFrame: false, window: null }
};

let sharedImage = null;

function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

// The rectangle the photo is fitted, panned and clipped to. When an opaque border
// layer sits on top of the photo, the photo is extended `bleed` px underneath it so
// no seam row can ever show between the photo and the border.
function windowRect(slot) {
  const win = slot.window || { x: 0, y: 0, w: slot.w, h: slot.h };
  const b = slot.bleed || 0;
  return { x: win.x - b, y: win.y - b, w: win.w + 2 * b, h: win.h + 2 * b };
}

// Finds the largest fully-transparent axis-aligned rectangle in the frame's alpha
// channel — that rectangle is treated as the "photo window" the photo should be
// cropped/panned inside, so a solid bg layer (and the frame's own border) stays visible.
function detectWindowRect(frameImg, canvasW, canvasH) {
  const DS = 260; // downsample long side for speed + to smooth away stray semi-transparent pixels
  const scale = DS / Math.max(canvasW, canvasH);
  const sw = Math.max(1, Math.round(canvasW * scale));
  const sh = Math.max(1, Math.round(canvasH * scale));

  const off = document.createElement("canvas");
  off.width = sw; off.height = sh;
  const octx = off.getContext("2d");
  octx.drawImage(frameImg, 0, 0, sw, sh);
  const data = octx.getImageData(0, 0, sw, sh).data;

  const empty = new Uint8Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) empty[i] = data[i * 4 + 3] < 60 ? 1 : 0;

  const heights = new Int32Array(sw);
  let best = { area: 0, x: 0, y: 0, w: 0, h: 0 };

  for (let row = 0; row < sh; row++) {
    for (let col = 0; col < sw; col++) {
      heights[col] = empty[row * sw + col] ? heights[col] + 1 : 0;
    }
    // largest rectangle in histogram, with position tracking
    const stack = []; // indices
    for (let col = 0; col <= sw; col++) {
      const h = col === sw ? 0 : heights[col];
      while (stack.length && heights[stack[stack.length - 1]] >= h) {
        const top = stack.pop();
        const height = heights[top];
        const left = stack.length ? stack[stack.length - 1] + 1 : 0;
        const width = col - left;
        const area = height * width;
        if (area > best.area) {
          best = { area, x: left, y: row - height + 1, w: width, h: height };
        }
      }
      stack.push(col);
    }
  }

  const canvasArea = canvasW * canvasH;
  const rectAreaAtFullRes = best.area / (scale * scale);
  if (best.area === 0 || rectAreaAtFullRes < 0.35 * canvasArea) return null; // detection too unreliable, fall back to full-bleed

  const inv = 1 / scale;
  return {
    x: Math.round(best.x * inv),
    y: Math.round(best.y * inv),
    w: Math.round(best.w * inv),
    h: Math.round(best.h * inv)
  };
}

// Some browsers (older Safari in particular) silently fall back to PNG when asked
// for a canvas.toBlob type they don't support — which produces huge "over 1MB"
// files with no error. Detect that up front and drop WebP from the picker if so.
async function detectWebpSupport() {
  const c = document.createElement("canvas");
  c.width = c.height = 2;
  const blob = await toBlobAsync(c, "image/webp", 0.8);
  return !!blob && blob.type === "image/webp";
}

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Loads the PSD-derived layers for a slot. `files` = { bg?, border?, frame, logo }.
// `win` is the exact photo window read from the PSD (transparent hole of the border,
// or the Mask shape for templates without a border layer).
async function preloadRealAssets(slot, files, win, bleed) {
  try {
    const [bg, border, frame, logo] = await Promise.all([
      files.bg ? loadImg(files.bg) : null,
      files.border ? loadImg(files.border) : null,
      loadImg(files.frame),
      loadImg(files.logo)
    ]);
    slot.bgImg = bg;
    slot.borderImg = border;
    slot.frameImg = frame;
    slot.logoImg = logo;
    slot.window = win;
    slot.bleed = bleed;
    centerImage(slot);
    render(slot);
  } catch (err) { /* demo assets optional */ }
}

function init() {
  for (const key of Object.keys(slots)) {
    const card = $(`.editor-card[data-slot="${key}"]`);
    if (!card) continue;
    const slot = slots[key];
    slot.canvas = card.querySelector(".preview-canvas");
    slot.ctx = slot.canvas.getContext("2d");
    slot.wrap = card.querySelector(".canvas-wrap");
    slot.card = card;

    setupDrag(slot);

    const zoomSlider = card.querySelector(".zoomSlider");
    const zoomVal = card.querySelector(".zoomVal");
    zoomSlider.addEventListener("input", () => {
      slot.scale = parseFloat(zoomSlider.value);
      zoomVal.textContent = Math.round(slot.scale * 100) + "%";
      clampOffset(slot);
      render(slot);
    });

    const resetBtn = card.querySelector(".resetBtn");
    resetBtn.addEventListener("click", () => {
      slot.scale = 1;
      zoomSlider.value = "1";
      zoomVal.textContent = "100%";
      centerImage(slot);
      render(slot);
    });

    // Optional per-layer overrides (inside the "Смяна на слоевете" section).
    const bindLayerInput = (selector, apply) => {
      const input = card.querySelector(selector);
      if (!input) return;
      input.addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        apply(await loadImg(URL.createObjectURL(file)));
        centerImage(slot);
        render(slot);
      });
    };
    bindLayerInput(".bgInput",     (img) => { slot.bgImg = img; });
    bindLayerInput(".frameInput",  (img) => { slot.frameImg = img; });
    bindLayerInput(".logoInput",   (img) => { slot.logoImg = img; });
    // An uploaded border defines the photo window itself: its transparent hole.
    bindLayerInput(".borderInput", (img) => {
      slot.borderImg = img;
      const hole = detectWindowRect(img, slot.w, slot.h);
      if (hole) { slot.window = hole; slot.bleed = 4; }
    });
  }

  // Real layers exported from the client's PSD templates.
  // 16:9: opaque border (hole = x50 y50 1100x575) sits over the photo, so the photo bleeds 4px under it.
  preloadRealAssets(slots.wide, {
    border: "assets/border-1200x675.png",
    frame:  "assets/frame-1200x675-real.png",
    logo:   "assets/logo-1200x675-real.png"
  }, { x: 50, y: 50, w: 1100, h: 575 }, 4);
  // 4:5: gold bg under the photo; glow lines already reach the mask edge (x64 y202 960x1100).
  preloadRealAssets(slots.tall, {
    bg:    "assets/bg-1080x1350-real.png",
    frame: "assets/frame-1080x1350-real.png",
    logo:  "assets/logo-1080x1350-real.png"
  }, { x: 64, y: 202, w: 960, h: 1100 }, 0);

  $("#loadUrlBtn").addEventListener("click", loadFromUrl);
  $("#imgFileInput").addEventListener("change", loadFromFile);
  $("#imgUrlInput").addEventListener("keydown", (e) => { if (e.key === "Enter") loadFromUrl(); });

  $("#exportBtn").addEventListener("click", exportAll);

  $("#formatSelect").addEventListener("change", () => {
    Object.values(slots).forEach(scheduleSizeUpdate);
  });

  detectWebpSupport().then((supported) => {
    if (supported) return;
    const select = $("#formatSelect");
    const webpOption = select.querySelector('option[value="image/webp"]');
    if (webpOption) webpOption.remove();
    select.value = "image/jpeg";
    const note = $("#formatNote");
    if (note) note.textContent = "WebP не се поддържа в този браузър — ползва се JPEG.";
    Object.values(slots).forEach(scheduleSizeUpdate);
  });
}

function setStatus(el, msg, kind) {
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}

function loadFromUrl() {
  const url = $("#imgUrlInput").value.trim();
  const statusEl = $("#sourceStatus");
  if (!url) { setStatus(statusEl, "Въведи линк към снимка.", "error"); return; }
  setStatus(statusEl, "Зареждане...", "");
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    sharedImage = img;
    setStatus(statusEl, `Заредено: ${img.naturalWidth}×${img.naturalHeight}px`, "ok");
    applySharedImageToAllSlots();
  };
  img.onerror = () => {
    setStatus(statusEl, "Неуспешно зареждане по линк (възможно CORS ограничение) — пробвай да качиш файла директно.", "error");
  };
  img.src = url;
}

function loadFromFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = $("#sourceStatus");
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    sharedImage = img;
    setStatus(statusEl, `Заредено: ${file.name} (${img.naturalWidth}×${img.naturalHeight}px)`, "ok");
    applySharedImageToAllSlots();
  };
  img.onerror = () => setStatus(statusEl, "Файлът не можа да се зареди.", "error");
  img.src = url;
}

function applySharedImageToAllSlots() {
  for (const key of Object.keys(slots)) {
    const slot = slots[key];
    slot.img = sharedImage;
    slot.scale = 1;
    const zoomSlider = slot.card.querySelector(".zoomSlider");
    const zoomVal = slot.card.querySelector(".zoomVal");
    zoomSlider.value = "1";
    zoomVal.textContent = "100%";
    centerImage(slot);
    render(slot);
  }
}

function centerImage(slot) {
  if (!slot.img) return;
  const win = windowRect(slot);
  const iw = slot.img.naturalWidth, ih = slot.img.naturalHeight;
  slot.baseScale = Math.max(win.w / iw, win.h / ih);
  const drawW = iw * slot.baseScale * slot.scale;
  const drawH = ih * slot.baseScale * slot.scale;
  slot.offX = win.x + (win.w - drawW) / 2;
  slot.offY = win.y + (win.h - drawH) / 2;
}

function clampOffset(slot) {
  if (!slot.img) return;
  const win = windowRect(slot);
  const iw = slot.img.naturalWidth, ih = slot.img.naturalHeight;
  const drawW = iw * slot.baseScale * slot.scale;
  const drawH = ih * slot.baseScale * slot.scale;
  const minX = win.x + win.w - drawW, maxX = win.x;
  const minY = win.y + win.h - drawH, maxY = win.y;
  slot.offX = Math.min(maxX, Math.max(minX, slot.offX));
  slot.offY = Math.min(maxY, Math.max(minY, slot.offY));
}

function render(slot) {
  const ctx = slot.ctx;
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, slot.w, slot.h);

  if (slot.hasFrame && slot.bgImg) {
    ctx.drawImage(slot.bgImg, 0, 0, slot.w, slot.h);
  }

  if (slot.img) {
    const win = windowRect(slot);
    const iw = slot.img.naturalWidth, ih = slot.img.naturalHeight;
    const drawW = iw * slot.baseScale * slot.scale;
    const drawH = ih * slot.baseScale * slot.scale;
    if (slot.hasFrame) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(win.x, win.y, win.w, win.h);
      ctx.clip();
      ctx.drawImage(slot.img, slot.offX, slot.offY, drawW, drawH);
      ctx.restore();
    } else {
      ctx.drawImage(slot.img, slot.offX, slot.offY, drawW, drawH);
    }
  }

  if (slot.hasFrame && slot.borderImg) {
    ctx.drawImage(slot.borderImg, 0, 0, slot.w, slot.h);
  }

  if (slot.hasFrame && slot.frameImg) {
    ctx.globalCompositeOperation = "lighter"; // Linear Dodge (Add)
    ctx.drawImage(slot.frameImg, 0, 0, slot.w, slot.h);
    ctx.globalCompositeOperation = "source-over";
  }

  if (slot.hasFrame && slot.logoImg) {
    ctx.drawImage(slot.logoImg, 0, 0, slot.w, slot.h);
  }

  scheduleSizeUpdate(slot);
}

function setupDrag(slot) {
  const wrap = slot.wrap;
  let dragging = false, startX = 0, startY = 0, startOffX = 0, startOffY = 0;

  wrap.addEventListener("pointerdown", (e) => {
    if (!slot.img) return;
    dragging = true;
    wrap.classList.add("dragging");
    wrap.setPointerCapture(e.pointerId);
    startX = e.clientX; startY = e.clientY;
    startOffX = slot.offX; startOffY = slot.offY;
  });

  wrap.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rectScale = slot.w / wrap.clientWidth; // css px -> canvas px
    slot.offX = startOffX + (e.clientX - startX) * rectScale;
    slot.offY = startOffY + (e.clientY - startY) * rectScale;
    clampOffset(slot);
    render(slot);
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    wrap.classList.remove("dragging");
  }
  wrap.addEventListener("pointerup", endDrag);
  wrap.addEventListener("pointercancel", endDrag);

  wrap.addEventListener("wheel", (e) => {
    if (!slot.img) return;
    e.preventDefault();
    const delta = -e.deltaY * 0.001;
    const zoomSlider = slot.card.querySelector(".zoomSlider");
    let newScale = slot.scale + delta;
    newScale = Math.min(3, Math.max(1, newScale));
    slot.scale = newScale;
    zoomSlider.value = String(newScale);
    slot.card.querySelector(".zoomVal").textContent = Math.round(newScale * 100) + "%";
    clampOffset(slot);
    render(slot);
  }, { passive: false });
}

const TARGET_MIN_KB = 90;
const TARGET_MAX_KB = 400;

function toBlobAsync(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

// Binary-searches the encoder quality so the exported file lands inside
// [TARGET_MIN_KB, TARGET_MAX_KB]. PNG is lossless (no quality knob), so it's
// exported as-is and just reported back. Returns { blob, quality, hitTarget }.
async function encodeToTarget(canvas, format) {
  if (format === "image/png") {
    const blob = await toBlobAsync(canvas, format);
    return { blob, quality: null, hitTarget: blob.size <= TARGET_MAX_KB * 1024 && blob.size >= TARGET_MIN_KB * 1024 };
  }

  const maxBytes = TARGET_MAX_KB * 1024;
  const minBytes = TARGET_MIN_KB * 1024;

  let blob = await toBlobAsync(canvas, format, 1.0);
  if (blob.size <= maxBytes) {
    return { blob, quality: 1.0, hitTarget: blob.size >= minBytes };
  }

  let lo = 0.25, hi = 1.0;
  let best = null, bestQuality = null;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    blob = await toBlobAsync(canvas, format, mid);
    if (blob.size > maxBytes) {
      hi = mid;
    } else {
      best = blob; bestQuality = mid; lo = mid;
      if (blob.size >= minBytes) break;
    }
  }
  if (best) return { blob: best, quality: bestQuality, hitTarget: best.size >= minBytes };

  // Couldn't get under the max even at the lowest tried quality — return that as a best effort.
  blob = await toBlobAsync(canvas, format, lo);
  return { blob, quality: lo, hitTarget: false };
}

function scheduleSizeUpdate(slot) {
  if (!slot.card) return;
  clearTimeout(slot.sizeTimer);
  slot.sizeTimer = setTimeout(() => updateSizeInfo(slot), 350);
}

async function updateSizeInfo(slot) {
  const el = slot.card.querySelector(".sizeInfo");
  if (!el) return;
  if (!slot.img) { el.textContent = ""; el.className = "sizeInfo status"; return; }

  const format = $("#formatSelect").value;
  el.textContent = "пресмятане на размера…";
  el.className = "sizeInfo status";

  const { blob, hitTarget } = await encodeToTarget(slot.canvas, format);
  // if the user switched photos/format while this was running, don't show a stale result
  if ($("#formatSelect").value !== format) return;

  const kb = Math.round(blob.size / 1024);
  el.textContent = `Очакван размер: ≈ ${kb} KB${hitTarget ? "" : " (извън 90–400KB)"}`;
  el.className = "sizeInfo status" + (hitTarget ? " ok" : "");
}

async function exportAll() {
  const statusEl = $("#exportStatus");
  const format = $("#formatSelect").value;
  const ext = EXT_BY_TYPE[format];

  const ready = Object.values(slots).filter(s => s.img && s.card.querySelector(".includeCheckbox").checked);
  if (ready.length === 0) {
    const anyImg = Object.values(slots).some(s => s.img);
    setStatus(statusEl, anyImg ? "Няма отметнат формат за експорт." : "Няма заредена снимка за експорт.", "error");
    return;
  }

  setStatus(statusEl, "Експортиране...", "");
  let failed = 0;
  const notes = [];

  for (const slot of ready) {
    const { blob, hitTarget } = await encodeToTarget(slot.canvas, format);
    if (!blob) { failed++; continue; }

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `menina-${slot.label}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();

    const kb = Math.round(blob.size / 1024);
    notes.push(`${slot.label}: ${kb}KB${hitTarget ? "" : " (извън 90–400KB диапазона)"}`);
  }

  setStatus(statusEl,
    failed ? `Готово с грешки: ${failed} файл(а) не успяха (вероятно CORS от URL източник — качи снимката като файл).`
           : `Готово — ${notes.join(" · ")}`,
    failed ? "error" : "ok");
}

init();
