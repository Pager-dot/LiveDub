// Toolbar click toggles dubbing for the current tab. Audio work happens in the offscreen document;
// results are relayed to the tab's widget (content.js).
let activeTab = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Capture tab audio for live translation and play the English voiceover",
  });
}

async function start(tab) {
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  await ensureOffscreen();
  const settings = (await chrome.storage.local.get("settings")).settings || {};
  activeTab = tab.id;
  await chrome.tabs.sendMessage(tab.id, { type: "widget", on: true }).catch(() => {});
  chrome.runtime.sendMessage({ target: "offscreen", type: "start", streamId, settings });
  chrome.action.setBadgeText({ text: "ON", tabId: tab.id });
  chrome.action.setBadgeBackgroundColor({ color: "#ff4d6d" });
}

function stop() {
  chrome.runtime.sendMessage({ target: "offscreen", type: "stop" }).catch(() => {});
  if (activeTab != null) {
    chrome.action.setBadgeText({ text: "", tabId: activeTab });
    chrome.tabs.sendMessage(activeTab, { type: "state", running: false }).catch(() => {});
  }
  activeTab = null;
}

chrome.action.onClicked.addListener(async (tab) => {
  if (activeTab === tab.id) return stop();
  if (activeTab != null) stop();
  try {
    await start(tab);
  } catch (e) {
    chrome.tabs.sendMessage(tab.id, { type: "status", text: "Can't capture this tab: " + e.message, err: true }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.target !== "background") return;
  if (msg.type === "stop") return stop();
  if (msg.type === "settings") return chrome.runtime.sendMessage({ target: "offscreen", type: "settings", settings: msg.settings });
  if (activeTab != null) chrome.tabs.sendMessage(activeTab, msg.payload).catch(() => {}); // offscreen -> widget
});

chrome.tabs.onRemoved.addListener((id) => id === activeTab && stop());
chrome.tabs.onUpdated.addListener((id, info) => id === activeTab && info.status === "loading" && info.url && stop());
