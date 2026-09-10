// Menina Movie — Frame Tool prototype
// No dependencies. Pure Canvas 2D compositing.
// Linear Dodge (Add) in Photoshop == globalCompositeOperation "lighter" in Canvas.
// Layer order per framed slot (bottom -> top): bg (normal) -> photo (clipped to window, normal) -> frame (lighter/Add) -> logo (normal)

const EXT_BY_TYPE = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" };

const slots = {
  wide:   { canvas: null, ctx: null, w: 1200, h: 675,  img: null, frameImg: null, bgImg: null, logoImg: null, scale: 1, offX: 0, offY: 0, baseScale: 1, label: "kadar-1200x675",  hasFrame: true,  window: null },
  tall:   { canvas: null, ctx: null, w: 1080, h: 1350, img: null, frameImg: null, bgImg: null, logoImg: null, scale: 1, offX: 0, offY: 0, baseScale: 1, label: "kadar-1080x1350", hasFrame: true,  window: null },
  poster: { canvas: null, ctx: null, w: 600,  h: 900,  img: null, frameImg: null, bgImg: null, logoImg: null, scale: 1, offX: 0, offY: 0, baseScale: 1, label: "poster-600x900",  hasFrame: false, window: null }
};

let sharedImage = null;

function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

function windowRect(slot) {
  return slot.window || { x: 0, y: 0, w: slot.w, h: slot.h };
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

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function preloadRealAssets(slot, sizeLabel, windowRectOverride) {
  try {
    const [bg, frame, logo] = await Promise.all([
      loadImg(`assets/bg-${sizeLabel}-real.png`),
      loadImg(`assets/frame-${sizeLabel}-real.png`),
      loadImg(`assets/logo-${sizeLabel}-real.png`)
    ]);
    slot.bgImg = bg;
    slot.frameImg = frame;
    slot.logoImg = logo;
    slot.window = windowRectOverride; // exact photo-window rect read from the source PSD's "Mask" shape
    const hint = slot.card ? slot.card.querySelector(".hint") : null;
    if (hint) hint.textContent = "Рамка заредена от PSD шаблона (Linear Dodge / Add).";
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

    const frameInput = card.querySelector(".frameInput");
    if (frameInput) {
      frameInput.addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const img = await loadImg(URL.createObjectURL(file));
        slot.frameImg = img;
        slot.window = detectWindowRect(img, slot.w, slot.h);
        const hint = card.querySelector(".hint");
        if (hint) hint.textContent = `Рамка "${file.name}" заредена (Linear Dodge / Add).`;
        centerImage(slot);
        render(slot);
      });
    }

    const bgInput = card.querySelector(".bgInput");
    if (bgInput) {
      bgInput.addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        slot.bgImg = await loadImg(URL.createObjectURL(file));
        render(slot);
      });
    }

    const logoInput = card.querySelector(".logoInput");
    if (logoInput) {
      logoInput.addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        slot.logoImg = await loadImg(URL.createObjectURL(file));
        render(slot);
      });
    }
  }

  // preload the real demo assets extracted from the client's PSD templates
  preloadRealAssets(slots.wide, "1200x675", { x: 49, y: 48, w: 1103, h: 578 });
  preloadRealAssets(slots.tall, "1080x1350", { x: 64, y: 202, w: 960, h: 1100 });

  $("#loadUrlBtn").addEventListener("click", loadFromUrl);
  $("#imgFileInput").addEventListener("change", loadFromFile);
  $("#imgUrlInput").addEventListener("keydown", (e) => { if (e.key === "Enter") loadFromUrl(); });

  $all(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      $all(".tab-btn").forEach(b => b.classList.remove("active"));
      $all(".tab-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      $("#" + btn.dataset.tab).classList.add("active");
    });
  });

  $("#qualitySlider").addEventListener("input", (e) => {
    $(".qualityVal").textContent = Math.round(parseFloat(e.target.value) * 100) + "%";
  });

  $("#exportBtn").addEventListener("click", exportAll);
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

  if (slot.hasFrame && slot.frameImg) {
    ctx.globalCompositeOperation = "lighter"; // Linear Dodge (Add)
    ctx.drawImage(slot.frameImg, 0, 0, slot.w, slot.h);
    ctx.globalCompositeOperation = "source-over";
  }

  if (slot.hasFrame && slot.logoImg) {
    ctx.drawImage(slot.logoImg, 0, 0, slot.w, slot.h);
  }
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

function exportAll() {
  const statusEl = $("#exportStatus");
  const format = $("#formatSelect").value;
  const quality = parseFloat($("#qualitySlider").value);
  const ext = EXT_BY_TYPE[format];

  const ready = Object.values(slots).filter(s => s.img);
  if (ready.length === 0) {
    setStatus(statusEl, "Няма заредена снимка за експорт.", "error");
    return;
  }

  setStatus(statusEl, "Експортиране...", "");
  let done = 0, failed = 0;

  ready.forEach((slot, i) => {
    setTimeout(() => {
      slot.canvas.toBlob((blob) => {
        if (!blob) {
          failed++;
        } else {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `menina-${slot.label}.${ext}`;
          document.body.appendChild(a);
          a.click();
          a.remove();
        }
        done++;
        if (done === ready.length) {
          setStatus(statusEl,
            failed ? `Готово с грешки: ${failed} файл(а) не успяха (вероятно CORS от URL източник — качи снимката като файл).`
                   : `Готово — свалени ${done} файл(а).`,
            failed ? "error" : "ok");
        }
      }, format, format === "image/png" ? undefined : quality);
    }, i * 150);
  });
}

init();
