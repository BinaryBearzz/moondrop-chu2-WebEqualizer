import {
  DEVICE,
  normalizeBand,
  previewEqualizerBand,
  readEqualizer,
  setEqualizerSlot,
  writeEqualizer,
} from "./protocol.js";
import {
  createProfile,
  deleteProfile,
  loadProfiles,
  parseProfile,
  saveProfile,
  serializeProfile,
} from "./profiles.js";

const DEFAULT_BANDS = [
  { type: "low_shelf", frequency: 90, gain: 0, q: 0.71 },
  { type: "peaking", frequency: 250, gain: 0, q: 1 },
  { type: "peaking", frequency: 1000, gain: 0, q: 1 },
  { type: "peaking", frequency: 4000, gain: 0, q: 1 },
  { type: "high_shelf", frequency: 10000, gain: 0, q: 0.71 },
];
const FILTER_LABELS = { peaking: "Peak", low_shelf: "Low shelf", high_shelf: "High shelf" };

const state = {
  bands: DEFAULT_BANDS.map((band) => ({ ...band })),
  savedBands: null,
  slot: null,
  savedSlot: null,
  device: null,
  busy: false,
  previewMessage: "เชื่อมต่อและอ่าน EQ เพื่อเริ่มทดลองเสียง",
};

const byId = (id) => document.getElementById(id);
const canvas = byId("eq-graph");
const context = canvas.getContext("2d");
const PREVIEW_DEBOUNCE_MS = 180;
let previewQueue = Promise.resolve();
let previewWorkerRunning = false;
let previewGeneration = 0;
let previewRevision = 0;
const previewTimers = new Map();
const queuedPreviews = new Map();
let toastTimer;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showToast(message, isError = false) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 4000);
}

function isConnected() {
  return Boolean(state.device?.opened);
}

function hasUnsavedChanges() {
  return !state.savedBands
    || JSON.stringify(state.bands) !== JSON.stringify(state.savedBands)
    || state.slot !== state.savedSlot;
}

function updateConnectionUi(message) {
  const connected = isConnected();
  byId("sidebar-device-state").textContent = connected ? "เชื่อมต่อแล้ว" : "ยังไม่เชื่อมต่อ";
  byId("sidebar-status-dot").classList.toggle("connected", connected);
  byId("topbar-status-dot").classList.toggle("connected", connected);
  byId("connection-label").textContent = connected ? "เชื่อมต่อแล้ว" : "ยังไม่เชื่อมต่อ";
  byId("device-chip").classList.toggle("connected", connected);
  byId("device-chip-label").textContent = connected ? "Moondrop CHU 2 DSP" : "รอเชื่อมต่อ";
  byId("connect-button").classList.toggle("connected", connected);
  byId("connect-button").querySelector("span").textContent = connected
    ? "ตัดการเชื่อมต่อ"
    : "เชื่อมต่ออุปกรณ์";
  byId("save-button").disabled = !connected || !state.savedBands || state.busy || !hasUnsavedChanges();
  byId("reset-button").disabled = state.busy || !hasUnsavedChanges();
  byId("read-button").disabled = !connected || state.busy;
  if (message) byId("save-state-detail").textContent = message;
}

function updateSaveSummary() {
  const dirty = hasUnsavedChanges();
  byId("save-state-title").textContent = dirty ? "การเปลี่ยนแปลงยังไม่บันทึก" : "EQ ตรงกับค่าที่บันทึกไว้";
  if (!state.savedBands) {
    byId("save-state-detail").textContent = "เชื่อมต่ออุปกรณ์และอ่านค่า EQ ก่อนบันทึก";
  } else if (dirty) {
    byId("save-state-detail").textContent = "ตรวจสอบค่าแล้วกดบันทึกเพื่อเขียนลงใน DSP";
  } else {
    byId("save-state-detail").textContent = "การตั้งค่าปัจจุบันตรงกับค่าล่าสุดในอุปกรณ์";
  }
  byId("save-button").disabled = !isConnected() || !state.savedBands || state.busy || !dirty;
  byId("reset-button").disabled = state.busy || !dirty;
  byId("read-button").disabled = !isConnected() || state.busy;
  byId("connect-button").disabled = state.busy;
  byId("save-profile-button").disabled = state.busy;
  byId("profile-select").disabled = state.busy;
  byId("load-profile-button").disabled = state.busy || !byId("profile-select").value;
  byId("delete-profile-button").disabled = state.busy || !byId("profile-select").value;
  byId("transfer-button").disabled = state.busy;
  byId("import-profile-button").disabled = state.busy;
  byId("profile-file").disabled = state.busy;
  byId("restore-preview-button").disabled = state.busy || !state.savedBands || !dirty;
  byId("preview-state").textContent = state.previewMessage;
  byId("bands-grid").querySelectorAll("input, select").forEach((control) => {
    control.disabled = state.busy;
  });
}

function refreshProfileList(selectedName = "") {
  const profiles = loadProfiles();
  const select = byId("profile-select");
  const options = [new Option("เลือกโปรไฟล์…", "")];
  profiles.forEach((profile) => {
    options.push(new Option(profile.name, profile.name));
  });
  select.replaceChildren(...options);
  select.value = selectedName;
  const hasSelection = Boolean(select.value);
  byId("load-profile-button").disabled = !hasSelection;
  byId("delete-profile-button").disabled = !hasSelection;
}

function openProfileTransfer() {
  const name = byId("profile-name").value.trim() || "โปรไฟล์ของฉัน";
  byId("profile-json").value = serializeProfile(createProfile(name, state.bands));
  byId("profile-dialog").showModal();
}

async function copyProfileJson() {
  try {
    await navigator.clipboard.writeText(byId("profile-json").value);
    showToast("คัดลอก JSON ไปยังคลิปบอร์ดแล้ว");
  } catch (error) {
    showToast(`คัดลอกไม่สำเร็จ: ${error.message}`, true);
  }
}

function downloadProfileJson() {
  try {
    const profile = parseProfile(byId("profile-json").value);
    const filename = `${profile.name.normalize("NFKD").replace(/[^\w-]+/g, "-") || "chu-eq"}.json`;
    const blob = new Blob([serializeProfile(profile)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = element("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    showToast("ดาวน์โหลดไฟล์โปรไฟล์แล้ว");
  } catch (error) {
    showToast(error.message || "ส่งออกไฟล์ไม่สำเร็จ", true);
  }
}

function importProfileJson(text) {
  try {
    const profile = parseProfile(text);
    if (state.savedBands && hasUnsavedChanges()
        && !window.confirm("นำเข้าโปรไฟล์แล้วแทนที่การแก้ไขที่ยังไม่บันทึกหรือไม่?")) {
      return;
    }
    state.bands = profile.bands;
    byId("profile-name").value = profile.name;
    renderBands();
    drawGraph();
    updateSaveSummary();
    scheduleAllPreviews();
    byId("profile-dialog").close();
    showToast(`นำเข้าโปรไฟล์ “${profile.name}” แล้ว — ยังไม่ได้เขียนลงอุปกรณ์`);
  } catch (error) {
    showToast(error.message || "นำเข้าโปรไฟล์ไม่สำเร็จ", true);
  }
}

function storeCurrentProfile() {
  try {
    const name = byId("profile-name").value;
    const existing = loadProfiles().find(
      (profile) => profile.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase(),
    );
    if (existing && !window.confirm(`โปรไฟล์ “${existing.name}” มีอยู่แล้ว ต้องการเขียนทับหรือไม่?`)) {
      return;
    }
    const profiles = saveProfile(name, state.bands);
    const savedProfile = profiles.find(
      (profile) => profile.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase(),
    );
    if (!savedProfile) throw new Error("บันทึกโปรไฟล์แล้วแต่ไม่พบในรายการโปรไฟล์");
    refreshProfileList(savedProfile.name);
    showToast(`บันทึกโปรไฟล์ “${name.trim()}” ไว้ในเบราว์เซอร์แล้ว`);
  } catch (error) {
    showToast(error.message || "บันทึกโปรไฟล์ไม่สำเร็จ", true);
  }
}

function applySelectedProfile() {
  try {
    const profile = loadProfiles().find((saved) => saved.name === byId("profile-select").value);
    if (!profile) throw new RangeError("กรุณาเลือกโปรไฟล์ที่บันทึกไว้");
    if (state.savedBands && hasUnsavedChanges()
        && !window.confirm("โหลดโปรไฟล์แล้วแทนที่การแก้ไขที่ยังไม่บันทึกหรือไม่?")) {
      return;
    }
    state.bands = profile.bands;
    byId("profile-name").value = profile.name;
    renderBands();
    drawGraph();
    updateSaveSummary();
    scheduleAllPreviews();
    showToast(`โหลดโปรไฟล์ “${profile.name}” แล้ว — ยังไม่ได้เขียนลงอุปกรณ์`);
  } catch (error) {
    showToast(error.message || "โหลดโปรไฟล์ไม่สำเร็จ", true);
  }
}

function removeSelectedProfile() {
  const name = byId("profile-select").value;
  if (!name || !window.confirm(`ลบโปรไฟล์ “${name}” ออกจากเบราว์เซอร์หรือไม่?`)) return;
  try {
    deleteProfile(name);
    refreshProfileList();
    showToast(`ลบโปรไฟล์ “${name}” แล้ว`);
  } catch (error) {
    showToast(error.message || "ลบโปรไฟล์ไม่สำเร็จ", true);
  }
}

function formatFrequency(value) {
  return value >= 1000 ? `${Number((value / 1000).toFixed(2))} kHz` : `${Math.round(value)} Hz`;
}

function createBandCard(band, index) {
  const card = element("article", "band-card");
  card.setAttribute("aria-label", `แบนด์ ${index + 1}`);

  const top = element("div", "band-top");
  const number = element("div", "band-number");
  number.append(element("span", "", String(index + 1)), document.createTextNode(`Band ${index + 1}`));
  const type = element("select", "band-select");
  type.setAttribute("aria-label", `ประเภทฟิลเตอร์แบนด์ ${index + 1}`);
  Object.entries(FILTER_LABELS).forEach(([value, label]) => {
    const option = element("option", "", label);
    option.value = value;
    option.selected = value === band.type;
    type.append(option);
  });
  type.addEventListener("change", () => updateBand(index, { type: type.value }));
  top.append(number, type);

  const gainControl = element("div", "band-control");
  const gainLabel = element("label", "", "เกน");
  const gainOutput = element("output", "", `${band.gain.toFixed(1)} dB`);
  gainLabel.append(gainOutput);
  const gainRange = element("input");
  gainRange.type = "range";
  gainRange.min = String(DEVICE.minGain);
  gainRange.max = String(DEVICE.maxGain);
  gainRange.step = "0.1";
  gainRange.value = String(band.gain);
  gainRange.setAttribute("aria-label", `เกนแบนด์ ${index + 1}`);
  gainRange.addEventListener("input", () => {
    updateBand(index, { gain: Number(gainRange.value) }, false);
    gainOutput.textContent = `${state.bands[index].gain.toFixed(1)} dB`;
  });
  gainControl.append(gainLabel, gainRange);

  const frequencyControl = createNumberControl({
    label: "ความถี่",
    value: band.frequency,
    min: DEVICE.minFrequency,
    max: DEVICE.maxFrequency,
    step: 1,
    unit: "Hz",
    accessibleLabel: `ความถี่แบนด์ ${index + 1}`,
    onChange: (value) => updateBand(index, { frequency: value }),
  });
  const qControl = createNumberControl({
    label: "Q",
    value: band.q,
    min: DEVICE.minQ,
    max: DEVICE.maxQ,
    step: 0.01,
    unit: "",
    accessibleLabel: `Q แบนด์ ${index + 1}`,
    onChange: (value) => updateBand(index, { q: value }),
  });
  card.append(top, gainControl, frequencyControl, qControl);
  return card;
}

function createNumberControl({ label, value, min, max, step, unit, accessibleLabel, onChange }) {
  const control = element("div", "band-control");
  const heading = element("label", "", label);
  const input = element("input");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.setAttribute("aria-label", accessibleLabel);
  const row = element("div", "band-input-row");
  row.append(input, element("span", "", unit));
  input.addEventListener("change", () => {
    const parsed = Number(input.value);
    if (!Number.isFinite(parsed)) {
      input.value = String(value);
      return;
    }
    onChange(parsed);
  });
  control.append(heading, row);
  return control;
}

function renderBands() {
  const grid = byId("bands-grid");
  const cards = state.bands.map(createBandCard);
  grid.replaceChildren(...cards);
  const active = state.bands.filter((band) => band.gain !== 0).length;
  byId("active-band-count").textContent = String(active);
}

function updateBand(index, patch, shouldRender = true) {
  try {
    state.bands[index] = normalizeBand({ ...state.bands[index], ...patch });
    if (shouldRender) renderBands();
    else {
      byId("active-band-count").textContent = String(state.bands.filter((band) => band.gain !== 0).length);
    }
    drawGraph();
    updateSaveSummary();
    schedulePreview(index);
  } catch (error) {
    showToast(error.message, true);
    renderBands();
  }
}

function setPreviewMessage(message) {
  state.previewMessage = message;
  byId("preview-state").textContent = message;
}

function enqueuePreview(index, band, generation, revision) {
  queuedPreviews.set(index, { band, generation, revision });
  if (!previewWorkerRunning) {
    previewWorkerRunning = true;
    previewQueue = (async () => {
      try {
        while (queuedPreviews.size > 0) {
          const [nextIndex, pending] = queuedPreviews.entries().next().value;
          queuedPreviews.delete(nextIndex);
          const device = state.device;
          if (pending.generation !== previewGeneration || !device?.opened
              || !state.savedBands || state.busy) continue;
          try {
            state.slot = await previewEqualizerBand(device, nextIndex, pending.band, state.slot);
            if (pending.generation === previewGeneration
                && pending.revision === previewRevision
                && previewTimers.size === 0
                && queuedPreviews.size === 0) {
              setPreviewMessage("กำลังทดลองเสียงอยู่ · ยังไม่บันทึกลงอุปกรณ์");
              updateSaveSummary();
            }
          } catch (error) {
            setPreviewMessage(`ทดลองเสียงแบนด์ ${nextIndex + 1} ไม่สำเร็จ`);
            showToast(`ส่งตัวอย่างเสียงแบนด์ ${nextIndex + 1} ไม่สำเร็จ: ${error.message}`, true);
          }
        }
      } finally {
        previewWorkerRunning = false;
      }
    })();
  }
  return previewQueue;
}

function schedulePreview(index) {
  if (!isConnected() || !state.savedBands || state.busy) return;
  const previousTimer = previewTimers.get(index);
  if (previousTimer) clearTimeout(previousTimer);
  const generation = previewGeneration;
  const revision = ++previewRevision;
  setPreviewMessage("กำลังส่งการปรับไปยัง DSP…");
  const timer = setTimeout(() => {
    previewTimers.delete(index);
    void enqueuePreview(index, { ...state.bands[index] }, generation, revision);
  }, PREVIEW_DEBOUNCE_MS);
  previewTimers.set(index, timer);
}

function scheduleAllPreviews() {
  state.bands.forEach((_, index) => schedulePreview(index));
}

function clearPendingPreviews() {
  previewGeneration += 1;
  previewTimers.forEach(clearTimeout);
  previewTimers.clear();
  queuedPreviews.clear();
}

async function applyPreviewBands(device, bands, startingSlot, targetSlot = null) {
  let slot = startingSlot;
  for (let index = 0; index < bands.length; index += 1) {
    if (state.device !== device || !device.opened) {
      throw new Error("อุปกรณ์ตัดการเชื่อมต่อระหว่างทดลองเสียง");
    }
    slot = await previewEqualizerBand(device, index, bands[index], slot);
    state.slot = slot;
  }
  if (targetSlot !== null && slot !== targetSlot) {
    slot = await setEqualizerSlot(device, targetSlot);
    state.slot = slot;
  }
  return slot;
}

function coefficients(band) {
  const w = 2 * Math.PI * band.frequency / 48_000;
  const cosine = Math.cos(w);
  const sine = Math.sin(w);
  const amplitude = 10 ** (band.gain / 40);
  const alpha = band.type === "peaking"
    ? sine / (2 * band.q)
    : sine / (2 * band.q) * Math.SQRT2;
  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;

  if (band.type === "peaking") {
    b0 = 1 + alpha * amplitude;
    b1 = -2 * cosine;
    b2 = 1 - alpha * amplitude;
    a0 = 1 + alpha / amplitude;
    a1 = -2 * cosine;
    a2 = 1 - alpha / amplitude;
  } else {
    const twoRootAlpha = 2 * Math.sqrt(amplitude) * alpha;
    if (band.type === "low_shelf") {
      b0 = amplitude * ((amplitude + 1) - (amplitude - 1) * cosine + twoRootAlpha);
      b1 = 2 * amplitude * ((amplitude - 1) - (amplitude + 1) * cosine);
      b2 = amplitude * ((amplitude + 1) - (amplitude - 1) * cosine - twoRootAlpha);
      a0 = (amplitude + 1) + (amplitude - 1) * cosine + twoRootAlpha;
      a1 = -2 * ((amplitude - 1) + (amplitude + 1) * cosine);
      a2 = (amplitude + 1) + (amplitude - 1) * cosine - twoRootAlpha;
    } else {
      b0 = amplitude * ((amplitude + 1) + (amplitude - 1) * cosine + twoRootAlpha);
      b1 = -2 * amplitude * ((amplitude - 1) + (amplitude + 1) * cosine);
      b2 = amplitude * ((amplitude + 1) + (amplitude - 1) * cosine - twoRootAlpha);
      a0 = (amplitude + 1) - (amplitude - 1) * cosine + twoRootAlpha;
      a1 = 2 * ((amplitude - 1) - (amplitude + 1) * cosine);
      a2 = (amplitude + 1) - (amplitude - 1) * cosine - twoRootAlpha;
    }
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

function bandMagnitudeDb(coefficientsForBand, frequency) {
  const [b0, b1, b2, a1, a2] = coefficientsForBand;
  const angle = 2 * Math.PI * frequency / 48_000;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const cosine2 = Math.cos(2 * angle);
  const sine2 = Math.sin(2 * angle);
  const realNumerator = b0 + b1 * cosine + b2 * cosine2;
  const imaginaryNumerator = -b1 * sine - b2 * sine2;
  const realDenominator = 1 + a1 * cosine + a2 * cosine2;
  const imaginaryDenominator = -a1 * sine - a2 * sine2;
  const numerator = Math.hypot(realNumerator, imaginaryNumerator);
  const denominator = Math.hypot(realDenominator, imaginaryDenominator);
  return 20 * Math.log10(Math.max(numerator / denominator, 1e-8));
}

function drawGraph() {
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width < 2 || bounds.height < 2) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(bounds.width * ratio);
  canvas.height = Math.round(bounds.height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = bounds.width;
  const height = bounds.height;
  const plot = { left: 36, right: width - 10, top: 8, bottom: height - 23 };
  const x = (frequency) => plot.left + Math.log10(frequency / 20) / 3 * (plot.right - plot.left);
  const y = (gain) => plot.top + (15 - gain) / 30 * (plot.bottom - plot.top);

  context.clearRect(0, 0, width, height);
  context.fillStyle = "#171b19";
  context.fillRect(plot.left, plot.top, plot.right - plot.left, plot.bottom - plot.top);
  context.font = "9px Inter, Segoe UI, sans-serif";
  context.textBaseline = "middle";
  for (let gain = -12; gain <= 12; gain += 6) {
    const gridY = y(gain);
    context.beginPath();
    context.moveTo(plot.left, gridY);
    context.lineTo(plot.right, gridY);
    context.strokeStyle = gain === 0 ? "#515a54" : "#29302c";
    context.lineWidth = 1;
    context.stroke();
    context.fillStyle = "#69736c";
    context.textAlign = "right";
    context.fillText(`${gain > 0 ? "+" : ""}${gain}`, plot.left - 7, gridY);
  }
  [20, 100, 1000, 10000, 20000].forEach((frequency) => {
    const gridX = x(frequency);
    context.beginPath();
    context.moveTo(gridX, plot.top);
    context.lineTo(gridX, plot.bottom);
    context.strokeStyle = "#29302c";
    context.stroke();
    context.fillStyle = "#69736c";
    context.textAlign = frequency === 20 ? "left" : frequency === 20000 ? "right" : "center";
    context.textBaseline = "top";
    context.fillText(formatFrequency(frequency).replace(" Hz", "").replace(" kHz", "k"), gridX, plot.bottom + 5);
  });

  const filters = state.bands.map(coefficients);
  context.beginPath();
  for (let point = 0; point <= 240; point += 1) {
    const frequency = 20 * 1000 ** (point / 240);
    const gain = filters.reduce((sum, filter) => sum + bandMagnitudeDb(filter, frequency), 0);
    const pointX = x(frequency);
    const pointY = y(Math.max(-15, Math.min(15, gain)));
    if (point === 0) context.moveTo(pointX, pointY);
    else context.lineTo(pointX, pointY);
  }
  context.strokeStyle = "#d3f26a";
  context.lineWidth = 2;
  context.shadowColor = "#d3f26a44";
  context.shadowBlur = 7;
  context.stroke();
  context.shadowBlur = 0;
}

function showBrowserNotice(message, isError = false) {
  const notice = byId("browser-notice");
  notice.hidden = !message;
  notice.classList.toggle("error", isError);
  byId("browser-notice-text").textContent = message;
}

async function disconnectDevice() {
  const device = state.device;
  if (state.savedBands && hasUnsavedChanges()) {
    const shouldRestore = window.confirm(
      "มี EQ ทดลองที่ยังไม่บันทึก ต้องการคืนค่า EQ ล่าสุดก่อนตัดการเชื่อมต่อหรือไม่?",
    );
    if (!shouldRestore) return;
    return restoreSavedPreview(false).then((restored) => {
      if (restored) return closeDevice(device);
      return undefined;
    });
  }
  return closeDevice(device);
}

async function closeDevice(device) {
  clearPendingPreviews();
  state.busy = true;
  updateSaveSummary();
  try {
    await previewQueue;
    state.device = null;
    state.savedBands = null;
    state.slot = null;
    state.savedSlot = null;
    setPreviewMessage("เชื่อมต่อและอ่าน EQ เพื่อเริ่มทดลองเสียง");
    if (device?.opened) await device.close();
  } finally {
    state.busy = false;
    updateConnectionUi("เชื่อมต่ออุปกรณ์และอ่านค่า EQ ก่อนบันทึก");
    updateSaveSummary();
  }
}

async function connectDevice() {
  if (!("hid" in navigator)) {
    showBrowserNotice("เบราว์เซอร์นี้ไม่รองรับ WebHID กรุณาใช้ Chrome หรือ Edge บน HTTPS หรือ localhost", true);
    return;
  }
  try {
    const devices = await navigator.hid.requestDevice({
      filters: [{ vendorId: DEVICE.vendorId, productId: DEVICE.productId }],
    });
    if (devices.length === 0) return;
    const device = devices[0];
    await device.open();
    state.device = device;
    device.addEventListener("disconnect", onDeviceDisconnected, { once: true });
    updateConnectionUi("กำลังอ่านค่า EQ จากอุปกรณ์…");
    const equalizer = await readEqualizer(device);
    state.bands = equalizer.bands;
    state.savedBands = equalizer.bands.map((band) => ({ ...band }));
    state.slot = equalizer.slot;
    state.savedSlot = equalizer.slot;
    setPreviewMessage("พร้อมทดลองเสียงสด · ปรับแบนด์เพื่อฟังผลทันที");
    renderBands();
    drawGraph();
    updateConnectionUi("อ่านค่า EQ จากอุปกรณ์แล้ว");
    updateSaveSummary();
    showToast("เชื่อมต่อ CHU 2 และอ่านค่า EQ สำเร็จ");
    showBrowserNotice("", false);
  } catch (error) {
    updateConnectionUi();
    showBrowserNotice(error.message || "เชื่อมต่ออุปกรณ์ไม่สำเร็จ", true);
    showToast(error.message || "เชื่อมต่ออุปกรณ์ไม่สำเร็จ", true);
  }
}

function onDeviceDisconnected(event) {
  if (event.device !== state.device) return;
  clearPendingPreviews();
  state.device = null;
  state.savedBands = null;
  state.slot = null;
  state.savedSlot = null;
  setPreviewMessage("อุปกรณ์ตัดการเชื่อมต่อ · ตัวอย่างเสียงที่ยังไม่บันทึกจะหายไป");
  updateConnectionUi("อุปกรณ์ตัดการเชื่อมต่อแล้ว โปรดเชื่อมต่อและอ่านค่าอีกครั้ง");
  updateSaveSummary();
  showToast("อุปกรณ์ถูกตัดการเชื่อมต่อ");
}

async function saveEqualizer() {
  if (!state.device?.opened || !state.savedBands || state.busy) return;
  const confirmed = window.confirm(
    "บันทึก EQ 5 แบนด์ลงใน CHU 2 หรือไม่?\n\nอุปกรณ์จะรีสตาร์ตและเสียงอาจหยุดชั่วครู่",
  );
  if (!confirmed) return;

  state.busy = true;
  clearPendingPreviews();
  updateSaveSummary();
  byId("save-state-detail").textContent = "กำลังเขียนและตรวจสอบค่า EQ…";
  setPreviewMessage("กำลังบันทึก EQ ลงในอุปกรณ์…");
  try {
    await previewQueue;
    const savedBands = await writeEqualizer(state.device, state.bands);
    state.bands = savedBands;
    state.savedBands = savedBands.map((band) => ({ ...band }));
    state.slot = 0x03;
    state.savedSlot = 0x03;
    renderBands();
    drawGraph();
    setPreviewMessage("บันทึกแล้ว · EQ นี้ยังเล่นอยู่ในอุปกรณ์");
    updateSaveSummary();
    byId("save-state-detail").textContent = "บันทึกแล้ว · DSP กำลังรีสตาร์ต";
    showToast("บันทึก EQ สำเร็จ อุปกรณ์กำลังรีสตาร์ต");
  } catch (error) {
    setPreviewMessage("บันทึกไม่สำเร็จ · ตรวจสอบการเชื่อมต่อ");
    showToast(error.message || "บันทึก EQ ไม่สำเร็จ", true);
    byId("save-state-detail").textContent = "บันทึกไม่สำเร็จ ตรวจสอบการเชื่อมต่อแล้วลองอีกครั้ง";
  } finally {
    state.busy = false;
    updateSaveSummary();
  }
}

async function refreshEqualizer() {
  if (!state.device?.opened || state.busy) return;
  const shouldRestoreSaved = Boolean(state.savedBands && hasUnsavedChanges());
  if (shouldRestoreSaved
      && !window.confirm("อ่านค่าใหม่แล้วละทิ้งการแก้ไขที่ยังไม่บันทึกหรือไม่?")) {
    return;
  }
  state.busy = true;
  clearPendingPreviews();
  updateSaveSummary();
  try {
    await previewQueue;
    if (shouldRestoreSaved) {
      await applyPreviewBands(state.device, state.savedBands, state.slot, state.savedSlot);
    }
    const equalizer = await readEqualizer(state.device);
    state.bands = equalizer.bands;
    state.savedBands = equalizer.bands.map((band) => ({ ...band }));
    state.slot = equalizer.slot;
    state.savedSlot = equalizer.slot;
    setPreviewMessage("พร้อมทดลองเสียงสด · ปรับแบนด์เพื่อฟังผลทันที");
    renderBands();
    drawGraph();
    updateSaveSummary();
    showToast("อ่านค่า EQ จากอุปกรณ์แล้ว");
  } catch (error) {
    showToast(error.message || "อ่านค่า EQ ไม่สำเร็จ", true);
  } finally {
    state.busy = false;
    updateSaveSummary();
  }
}

function resetBands() {
  if (!hasUnsavedChanges()) return;
  state.bands = DEFAULT_BANDS.map((band) => ({ ...band }));
  renderBands();
  drawGraph();
  updateSaveSummary();
  scheduleAllPreviews();
  showToast("รีเซ็ตแบนด์เป็น 0 dB แล้ว — ยังไม่ได้เขียนลงในอุปกรณ์");
}

async function restoreSavedPreview(confirmBefore = true) {
  if (!state.savedBands || !hasUnsavedChanges() || state.busy) return;
  if (confirmBefore
      && !window.confirm("ยกเลิกการทดลองและคืนเสียงเป็น EQ ที่อ่าน/บันทึกไว้ล่าสุดหรือไม่?")) {
    return false;
  }

  clearPendingPreviews();
  state.busy = true;
  state.bands = state.savedBands.map((band) => ({ ...band }));
  renderBands();
  drawGraph();
  setPreviewMessage("กำลังคืนค่า EQ เดิมให้กับ DSP…");
  updateSaveSummary();
  try {
    await previewQueue;
    if (!state.device?.opened) {
      throw new Error("อุปกรณ์ตัดการเชื่อมต่อก่อนคืนค่าเสร็จ");
    }
    await applyPreviewBands(state.device, state.bands, state.slot, state.savedSlot);
    setPreviewMessage("คืนค่า EQ ที่อ่านล่าสุดแล้ว · ยังไม่มีการบันทึกค่าใหม่");
    showToast("ยกเลิกการทดลองและคืนค่า EQ เดิมแล้ว");
    return true;
  } catch (error) {
    setPreviewMessage("คืนค่าไม่สำเร็จ · ตรวจสอบการเชื่อมต่ออุปกรณ์");
    showToast(`คืนค่า EQ เดิมไม่สำเร็จ: ${error.message}`, true);
    return false;
  } finally {
    state.busy = false;
    updateSaveSummary();
  }
}

function init() {
  renderBands();
  drawGraph();
  updateConnectionUi();
  try {
    refreshProfileList();
  } catch (error) {
    showToast(error.message || "โหลดโปรไฟล์จากเบราว์เซอร์ไม่สำเร็จ", true);
  }
  byId("connect-button").addEventListener("click", () => {
    if (isConnected()) {
      disconnectDevice().catch((error) => showToast(error.message, true));
    } else {
      connectDevice();
    }
  });
  byId("save-button").addEventListener("click", saveEqualizer);
  byId("read-button").addEventListener("click", refreshEqualizer);
  byId("reset-button").addEventListener("click", resetBands);
  byId("restore-preview-button").addEventListener("click", restoreSavedPreview);
  byId("save-profile-button").addEventListener("click", storeCurrentProfile);
  byId("profile-select").addEventListener("change", () => {
    const selected = Boolean(byId("profile-select").value);
    byId("load-profile-button").disabled = !selected;
    byId("delete-profile-button").disabled = !selected;
  });
  byId("load-profile-button").addEventListener("click", applySelectedProfile);
  byId("delete-profile-button").addEventListener("click", removeSelectedProfile);
  byId("transfer-button").addEventListener("click", openProfileTransfer);
  byId("close-profile-dialog").addEventListener("click", () => byId("profile-dialog").close());
  byId("copy-profile-button").addEventListener("click", copyProfileJson);
  byId("download-profile-button").addEventListener("click", downloadProfileJson);
  byId("import-profile-button").addEventListener("click", () => importProfileJson(byId("profile-json").value));
  byId("profile-file").addEventListener("change", async (event) => {
    const [file] = event.target.files;
    if (!file) return;
    try {
      if (file.size > 16_384) {
        throw new RangeError("ไฟล์โปรไฟล์ต้องมีขนาดไม่เกิน 16 KB");
      }
      importProfileJson(await file.text());
    } catch (error) {
      showToast(error.message || "อ่านไฟล์โปรไฟล์ไม่สำเร็จ", true);
    } finally {
      event.target.value = "";
    }
  });
  window.addEventListener("resize", drawGraph);

  if (!("hid" in navigator)) {
    showBrowserNotice("เบราว์เซอร์นี้ไม่รองรับ WebHID กรุณาใช้ Chrome หรือ Edge บน HTTPS หรือ localhost", true);
  } else if (!window.isSecureContext) {
    showBrowserNotice("WebHID ต้องเปิดเว็บไซต์ผ่าน HTTPS หรือ localhost เพื่อเข้าถึงอุปกรณ์ USB");
  } else {
    showBrowserNotice("พร้อมเชื่อมต่อผ่าน WebHID · การเข้าถึงอุปกรณ์ขึ้นอยู่กับเบราว์เซอร์และระบบปฏิบัติการ");
  }
}

init();
