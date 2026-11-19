import assert from "node:assert/strict";
import test from "node:test";
import {
  createProfile,
  deleteProfile,
  loadProfiles,
  parseProfile,
  saveProfile,
  serializeProfile,
} from "../profiles.js";

const bands = [
  { type: "low_shelf", frequency: 90, gain: 1.2, q: 0.71 },
  { type: "peaking", frequency: 250, gain: -1, q: 1 },
  { type: "peaking", frequency: 1000, gain: 0, q: 1 },
  { type: "peaking", frequency: 4000, gain: 2.5, q: 1.2 },
  { type: "high_shelf", frequency: 10000, gain: 0, q: 0.71 },
];

function memoryStorage() {
  const records = new Map();
  return {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, String(value)),
  };
}

test("round-trips an EQ profile through the portable JSON format", () => {
  const profile = createProfile("Late night", bands, "2026-01-02T03:04:05.000Z");
  assert.deepEqual(parseProfile(serializeProfile(profile)), profile);
});

test("rejects malformed, unsupported, or invalid-band profile imports", () => {
  assert.throws(() => parseProfile("{"), SyntaxError);
  assert.throws(() => parseProfile(JSON.stringify({ format: "other", version: 1 })), TypeError);
  assert.throws(() => parseProfile(JSON.stringify({
    format: "chu-studio-eq",
    version: 1,
    name: "Bad band",
    savedAt: "2026-01-02T03:04:05.000Z",
    bands: bands.map((band, index) => index === 0 ? { ...band, gain: 20 } : band),
  })), RangeError);
});

test("saves, overwrites case-insensitively, and deletes local profiles", () => {
  const storage = memoryStorage();
  saveProfile("Desk", bands, storage);
  const changedBands = bands.map((band, index) => index === 1 ? { ...band, gain: 1 } : band);
  saveProfile("desk", changedBands, storage);
  assert.equal(loadProfiles(storage).length, 1);
  assert.equal(loadProfiles(storage)[0].name, "desk");
  assert.equal(loadProfiles(storage)[0].bands[1].gain, 1);
  assert.deepEqual(deleteProfile("DESK", storage), []);
});

test("reports corrupt browser storage instead of silently clearing it", () => {
  const storage = {
    getItem: () => "{broken",
    setItem: () => {},
  };
  assert.throws(() => loadProfiles(storage), SyntaxError);
});
