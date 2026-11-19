export const DEVICE = Object.freeze({
  vendorId: 0x31b2,
  productId: 0x0113,
  reportId: 0x4b,
  bandCount: 5,
  minFrequency: 20,
  maxFrequency: 20_000,
  minGain: -12,
  maxGain: 12,
  minQ: 0.1,
  maxQ: 10,
});

const REGISTER = Object.freeze({ slot: 0x24, firstBand: 0x26 });
const COMMAND = Object.freeze({ read: 0x52, write: 0x57, commit: 0x53 });
const SLOT = Object.freeze({ on: 0x03, off: 0x02 });
const FILTER_CODE = Object.freeze({ peaking: 0, low_shelf: 3, high_shelf: 4 });
const FILTER_NAME = Object.freeze({ 0: "peaking", 3: "low_shelf", 4: "high_shelf" });
const REPLY_TIMEOUT_MS = 1000;

export function normalizeBand(band) {
  if (!band || typeof band !== "object") {
    throw new TypeError("EQ band must be an object.");
  }

  const frequency = Number(band.frequency);
  const gain = Number(band.gain);
  const q = Number(band.q);
  if (![frequency, gain, q].every(Number.isFinite)) {
    throw new TypeError("Frequency, gain, and Q must be finite numbers.");
  }
  if (frequency < DEVICE.minFrequency || frequency > DEVICE.maxFrequency) {
    throw new RangeError(`Frequency must be ${DEVICE.minFrequency}–${DEVICE.maxFrequency} Hz.`);
  }
  if (gain < DEVICE.minGain || gain > DEVICE.maxGain) {
    throw new RangeError(`Gain must be ${DEVICE.minGain}–${DEVICE.maxGain} dB.`);
  }
  if (q < DEVICE.minQ || q > DEVICE.maxQ) {
    throw new RangeError(`Q must be ${DEVICE.minQ}–${DEVICE.maxQ}.`);
  }
  if (!(band.type in FILTER_CODE)) {
    throw new RangeError("This filter type is not supported by the CHU 2 DSP.");
  }

  return {
    type: band.type,
    frequency: Math.round(frequency),
    gain: Math.round(gain * 10) / 10,
    q: Math.round(q * 1000) / 1000,
  };
}

export function encodeBand(band) {
  const normalized = normalizeBand(band);
  const gainFrequency = new Uint8Array(4);
  const gainView = new DataView(gainFrequency.buffer);
  gainView.setInt16(0, Math.round(normalized.gain * 10), true);
  gainView.setUint16(2, normalized.frequency, true);

  const qType = new Uint8Array(4);
  const qView = new DataView(qType.buffer);
  qView.setUint16(0, Math.round(normalized.q * 1000), true);
  qType[2] = FILTER_CODE[normalized.type];
  return [gainFrequency, qType];
}

export function decodeBand(gainFrequency, qType) {
  if (gainFrequency.length !== 4 || qType.length !== 4) {
    throw new RangeError("A CHU 2 EQ band must contain two 4-byte values.");
  }
  const gainView = new DataView(gainFrequency.buffer, gainFrequency.byteOffset, gainFrequency.byteLength);
  const qView = new DataView(qType.buffer, qType.byteOffset, qType.byteLength);
  const type = FILTER_NAME[qType[2]];
  if (!type) {
    throw new RangeError(`The device reported unsupported filter type ${qType[2]}.`);
  }
  return normalizeBand({
    type,
    frequency: gainView.getUint16(2, true),
    gain: gainView.getInt16(0, true) / 10,
    q: qView.getUint16(0, true) / 1000,
  });
}

export function buildPacket(register, command, value = new Uint8Array(4)) {
  if (!Number.isInteger(register) || register < 0 || register > 0xff) {
    throw new RangeError("Register must be a byte.");
  }
  if (!Number.isInteger(command) || command < 0 || command > 0xff) {
    throw new RangeError("Command must be a byte.");
  }
  if (value.length !== 4) {
    throw new RangeError("Command value must be exactly 4 bytes.");
  }
  const packet = new Uint8Array(10);
  packet[0] = register;
  packet[4] = command;
  packet.set(value, 6);
  return packet;
}

function waitForReply(device, register, command, timeoutMs) {
  let settle;
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      device.removeEventListener("inputreport", onReport);
      callback(value);
    };
    const onReport = (event) => {
      if (event.reportId !== DEVICE.reportId || event.data.byteLength < 10) return;
      const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
      if (bytes[0] !== register || bytes[4] !== command) return;
      finish(resolve, bytes.slice(6, 10));
    };
    const timer = setTimeout(
      () => finish(reject, new Error("ไม่ได้รับการตอบกลับจาก DSP ภายในเวลาที่กำหนด")),
      timeoutMs,
    );
    settle = (error) => finish(reject, error);
    device.addEventListener("inputreport", onReport);
  });
  return { promise, cancel: (error) => settle(error) };
}

async function command(device, register, commandCode, value = new Uint8Array(4)) {
  const packet = buildPacket(register, commandCode, value);
  const pendingReply = waitForReply(device, register, commandCode, REPLY_TIMEOUT_MS);
  try {
    await device.sendReport(DEVICE.reportId, packet);
  } catch (error) {
    pendingReply.cancel(new Error("ส่งคำสั่งไปยัง CHU 2 ไม่สำเร็จ", { cause: error }));
  }
  return pendingReply.promise;
}

export async function readEqualizer(device) {
  const slot = (await command(
    device,
    REGISTER.slot,
    COMMAND.read,
    Uint8Array.of(SLOT.on, 0, 0, 0),
  ))[0];
  const bands = [];
  for (let index = 0; index < DEVICE.bandCount; index += 1) {
    const register = REGISTER.firstBand + index * 2;
    const gainFrequency = await command(device, register, COMMAND.read);
    const qType = await command(device, register + 1, COMMAND.read);
    bands.push(decodeBand(gainFrequency, qType));
  }
  return { slot, bands };
}

export async function setEqualizerSlot(device, slot) {
  if (slot !== SLOT.on && slot !== SLOT.off) {
    throw new RangeError("EQ slot must be on (0x03) or off (0x02).");
  }
  await command(device, REGISTER.slot, COMMAND.write, Uint8Array.of(slot, 0, 0, 0));
  return slot;
}

export async function previewEqualizerBand(device, index, band, slot) {
  if (!Number.isInteger(index) || index < 0 || index >= DEVICE.bandCount) {
    throw new RangeError(`EQ band index must be between 0 and ${DEVICE.bandCount - 1}.`);
  }
  if (slot !== SLOT.on && slot !== SLOT.off) {
    throw new RangeError("A valid EQ slot state is required for live preview.");
  }
  const normalizedBand = normalizeBand(band);
  const activeSlot = slot === SLOT.off
    ? await setEqualizerSlot(device, SLOT.on)
    : slot;
  const register = REGISTER.firstBand + index * 2;
  const [gainFrequency, qType] = encodeBand(normalizedBand);
  await command(device, register, COMMAND.write, gainFrequency);
  await command(device, register + 1, COMMAND.write, qType);
  return activeSlot;
}

export async function writeEqualizer(device, bands) {
  if (!Array.isArray(bands) || bands.length !== DEVICE.bandCount) {
    throw new RangeError(`Exactly ${DEVICE.bandCount} EQ bands are required.`);
  }
  const normalizedBands = bands.map(normalizeBand);
  const slot = (await command(
    device,
    REGISTER.slot,
    COMMAND.read,
    Uint8Array.of(SLOT.on, 0, 0, 0),
  ))[0];

  if (slot !== SLOT.on) {
    await command(device, REGISTER.slot, COMMAND.write, Uint8Array.of(SLOT.on, 0, 0, 0));
  }

  for (let index = 0; index < normalizedBands.length; index += 1) {
    const register = REGISTER.firstBand + index * 2;
    const [gainFrequency, qType] = encodeBand(normalizedBands[index]);
    await command(device, register, COMMAND.write, gainFrequency);
    await command(device, register + 1, COMMAND.write, qType);

    const readGainFrequency = await command(device, register, COMMAND.read);
    const readQType = await command(device, register + 1, COMMAND.read);
    const matches = [gainFrequency, qType].every((expected, valueIndex) => {
      const actual = valueIndex === 0 ? readGainFrequency : readQType;
      return expected.every((byte, byteIndex) => byte === actual[byteIndex]);
    });
    if (!matches) {
      throw new Error(`แบนด์ ${index + 1} อ่านค่ากลับไม่ตรงกัน จึงยังไม่ได้บันทึก`);
    }
  }

  await command(device, 0x00, COMMAND.commit);
  return normalizedBands;
}
