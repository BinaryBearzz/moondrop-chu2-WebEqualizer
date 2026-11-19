import assert from "node:assert/strict";
import test from "node:test";
import {
  DEVICE,
  buildPacket,
  decodeBand,
  encodeBand,
  normalizeBand,
  previewEqualizerBand,
  readEqualizer,
  writeEqualizer,
} from "../protocol.js";

const exampleBand = { type: "peaking", frequency: 1250, gain: -3.4, q: 1.25 };

test("encodes and decodes all supported CHU 2 filter types", () => {
  for (const type of ["peaking", "low_shelf", "high_shelf"]) {
    const band = { ...exampleBand, type };
    const [gainFrequency, qType] = encodeBand(band);
    assert.deepEqual(decodeBand(gainFrequency, qType), band);
  }
});

test("normalizes device precision and rejects out-of-range values", () => {
  assert.deepEqual(
    normalizeBand({ ...exampleBand, frequency: 1250.4, gain: -3.44, q: 1.2345 }),
    { ...exampleBand, frequency: 1250, gain: -3.4, q: 1.235 },
  );
  assert.throws(() => normalizeBand({ ...exampleBand, gain: 12.1 }), RangeError);
  assert.throws(() => normalizeBand({ ...exampleBand, type: "notch" }), RangeError);
});

test("builds the 10-byte KTMicro packet without changing the report ID", () => {
  assert.deepEqual(
    [...buildPacket(0x26, 0x57, Uint8Array.of(1, 2, 3, 4))],
    [0x26, 0, 0, 0, 0x57, 0, 1, 2, 3, 4],
  );
  assert.equal(DEVICE.reportId, 0x4b);
});

class FakeDevice extends EventTarget {
  constructor() {
    super();
    this.opened = true;
    this.registers = new Map([[0x24, Uint8Array.of(0x03, 0, 0, 0)]]);
    for (let index = 0; index < DEVICE.bandCount; index += 1) {
      const [gainFrequency, qType] = encodeBand({
        type: "peaking",
        frequency: 100 * (index + 1),
        gain: 0,
        q: 1,
      });
      this.registers.set(0x26 + index * 2, gainFrequency);
      this.registers.set(0x27 + index * 2, qType);
    }
    this.committed = false;
  }

  async sendReport(reportId, packet) {
    assert.equal(reportId, DEVICE.reportId);
    const register = packet[0];
    const command = packet[4];
    const value = packet.slice(6, 10);
    if (command === 0x57) this.registers.set(register, value);
    if (command === 0x53) this.committed = true;
    const replyValue = command === 0x52
      ? (this.registers.get(register) ?? new Uint8Array(4))
      : value;
    const reply = new Uint8Array(10);
    reply[0] = register;
    reply[4] = command;
    reply.set(replyValue, 6);
    queueMicrotask(() => {
      const event = new Event("inputreport");
      Object.defineProperties(event, {
        reportId: { value: reportId },
        data: { value: new DataView(reply.buffer) },
      });
      this.dispatchEvent(event);
    });
  }
}

test("reads the slot and five bands from the HID reports", async () => {
  const device = new FakeDevice();
  const { slot, bands } = await readEqualizer(device);
  assert.equal(slot, 0x03);
  assert.equal(bands.length, DEVICE.bandCount);
  assert.equal(bands[0].frequency, 100);
});

test("writes, reads back, then commits all five bands", async () => {
  const device = new FakeDevice();
  const bands = Array.from({ length: DEVICE.bandCount }, (_, index) => ({
    ...exampleBand,
    frequency: 200 + index * 300,
  }));
  await writeEqualizer(device, bands);
  assert.equal(device.committed, true);
  assert.deepEqual((await readEqualizer(device)).bands, bands);
});

test("live-previews a band without committing it to persistent device storage", async () => {
  const device = new FakeDevice();
  device.registers.set(0x24, Uint8Array.of(0x02, 0, 0, 0));
  const slot = await previewEqualizerBand(device, 2, exampleBand, 0x02);
  const { bands } = await readEqualizer(device);
  assert.equal(slot, 0x03);
  assert.deepEqual(bands[2], exampleBand);
  assert.equal(device.committed, false);
});

test("rejects invalid EQ before sending any device command", async () => {
  let commandsSent = 0;
  const device = new FakeDevice();
  const sendReport = device.sendReport.bind(device);
  device.sendReport = async (...args) => {
    commandsSent += 1;
    return sendReport(...args);
  };
  await assert.rejects(
    writeEqualizer(device, Array(DEVICE.bandCount).fill({ ...exampleBand, gain: 13 })),
    RangeError,
  );
  assert.equal(commandsSent, 0);
});
