import { DEVICE, normalizeBand } from "./protocol.js";

export const PROFILE_FORMAT = "chu-studio-eq";
export const PROFILE_VERSION = 1;
const STORAGE_KEY = "chu-studio.profiles.v1";
const MAX_PROFILES = 100;
const MAX_PROFILE_TEXT_LENGTH = 16_384;
const MAX_PROFILE_NAME_LENGTH = 40;

function validateName(name) {
  if (typeof name !== "string") {
    throw new TypeError("Profile name must be text.");
  }
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_PROFILE_NAME_LENGTH) {
    throw new RangeError(`Enter a profile name with 1–${MAX_PROFILE_NAME_LENGTH} characters.`);
  }
  return trimmed;
}

function validateBands(bands) {
  if (!Array.isArray(bands) || bands.length !== DEVICE.bandCount) {
    throw new RangeError(`A profile must contain exactly ${DEVICE.bandCount} EQ bands.`);
  }
  return bands.map((band) => {
    if (!band || typeof band !== "object"
        || typeof band.type !== "string"
        || typeof band.frequency !== "number"
        || typeof band.gain !== "number"
        || typeof band.q !== "number") {
      throw new TypeError("Each EQ band must include a type, frequency, gain, and Q.");
    }
    return normalizeBand(band);
  });
}

function validateProfile(profile) {
  if (!profile || typeof profile !== "object"
      || profile.format !== PROFILE_FORMAT
      || profile.version !== PROFILE_VERSION) {
    throw new TypeError("Unsupported profile format or version.");
  }
  if (typeof profile.savedAt !== "string" || Number.isNaN(Date.parse(profile.savedAt))) {
    throw new TypeError("Profile is missing a valid savedAt timestamp.");
  }
  return {
    format: PROFILE_FORMAT,
    version: PROFILE_VERSION,
    name: validateName(profile.name),
    savedAt: new Date(profile.savedAt).toISOString(),
    bands: validateBands(profile.bands),
  };
}

function getStorage(storage) {
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
    throw new Error("Browser storage is unavailable. Try a regular browser window.");
  }
  return storage;
}

export function createProfile(name, bands, savedAt = new Date().toISOString()) {
  return validateProfile({
    format: PROFILE_FORMAT,
    version: PROFILE_VERSION,
    name,
    savedAt,
    bands,
  });
}

export function serializeProfile(profile) {
  return JSON.stringify(validateProfile(profile), null, 2);
}

export function parseProfile(text) {
  if (typeof text !== "string" || text.length > MAX_PROFILE_TEXT_LENGTH) {
    throw new RangeError(`Profile JSON must be no larger than ${MAX_PROFILE_TEXT_LENGTH} characters.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SyntaxError("Invalid JSON. Check the pasted profile text and try again.", { cause: error });
  }
  return validateProfile(parsed);
}

export function loadProfiles(storage = globalThis.localStorage) {
  const savedText = getStorage(storage).getItem(STORAGE_KEY);
  if (savedText === null) return [];

  let savedProfiles;
  try {
    savedProfiles = JSON.parse(savedText);
  } catch (error) {
    throw new SyntaxError("Saved browser profiles could not be parsed.", { cause: error });
  }
  if (!Array.isArray(savedProfiles) || savedProfiles.length > MAX_PROFILES) {
    throw new RangeError("Saved browser profiles have an invalid format or exceed the profile limit.");
  }

  const profiles = savedProfiles.map(validateProfile);
  const names = profiles.map((profile) => profile.name.toLocaleLowerCase());
  if (new Set(names).size !== names.length) {
    throw new RangeError("Saved browser profiles contain duplicate names.");
  }
  return profiles;
}

export function saveProfile(name, bands, storage = globalThis.localStorage) {
  const targetStorage = getStorage(storage);
  const profiles = loadProfiles(targetStorage);
  const profile = createProfile(name, bands);
  const existingIndex = profiles.findIndex(
    (saved) => saved.name.toLocaleLowerCase() === profile.name.toLocaleLowerCase(),
  );
  if (existingIndex < 0 && profiles.length >= MAX_PROFILES) {
    throw new RangeError(`A maximum of ${MAX_PROFILES} profiles can be saved in this browser.`);
  }
  if (existingIndex < 0) profiles.push(profile);
  else profiles[existingIndex] = profile;
  targetStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
  return profiles;
}

export function deleteProfile(name, storage = globalThis.localStorage) {
  const targetStorage = getStorage(storage);
  const profiles = loadProfiles(targetStorage);
  const remaining = profiles.filter(
    (profile) => profile.name.toLocaleLowerCase() !== name.toLocaleLowerCase(),
  );
  if (remaining.length === profiles.length) {
    throw new RangeError("The selected profile no longer exists in browser storage.");
  }
  targetStorage.setItem(STORAGE_KEY, JSON.stringify(remaining));
  return remaining;
}
