// Whitelist and settings persistence via browser.storage.local

const STORAGE_KEYS = {
  WHITELIST: "whitelist",
  SESSION_CAP: "sessionCap",
};

const DEFAULT_SESSION_CAP = 200;

// --- Whitelist ---

async function getWhitelist() {
  const result = await browser.storage.local.get(STORAGE_KEYS.WHITELIST);
  return result[STORAGE_KEYS.WHITELIST] || {};
}

async function addToWhitelist(userId, screenName) {
  const whitelist = await getWhitelist();
  whitelist[userId] = { screenName, addedAt: Date.now() };
  await browser.storage.local.set({ [STORAGE_KEYS.WHITELIST]: whitelist });
  return whitelist;
}

async function removeFromWhitelist(userId) {
  const whitelist = await getWhitelist();
  delete whitelist[userId];
  await browser.storage.local.set({ [STORAGE_KEYS.WHITELIST]: whitelist });
  return whitelist;
}

function isWhitelisted(whitelist, userId) {
  return userId in whitelist;
}

// --- Settings ---

async function getSessionCap() {
  const result = await browser.storage.local.get(STORAGE_KEYS.SESSION_CAP);
  return result[STORAGE_KEYS.SESSION_CAP] || DEFAULT_SESSION_CAP;
}

async function setSessionCap(cap) {
  const value = Math.max(1, Math.min(1000, parseInt(cap, 10) || DEFAULT_SESSION_CAP));
  await browser.storage.local.set({ [STORAGE_KEYS.SESSION_CAP]: value });
  return value;
}
