/**
 * DevTools Safari Bridge — Background Script (persistent, MV2)
 *
 * Maintains a WebSocket to the Node.js bridge server at ws://localhost:9333/__extension.
 * Relays messages between bridge server and content scripts.
 *
 * Content script → background (via browser.runtime.sendMessage):
 *   - Push events: { type: "events", kind, events }
 *   - Content ready: { type: "contentReady", url, title }
 *
 * Bridge server → background (via WebSocket):
 *   - Commands: { id, type, ...params }
 *   - Background forwards to content script, returns response
 *
 * Background → bridge server:
 *   - Responses: { type: "response", id, response }
 *   - Events: forwarded from content script
 *   - contentReady: tab info
 */

const BRIDGE_URL = "ws://localhost:9333/__extension";

let ws = null;
let activeTabId = null;
let reconnectTimer = null;

function connect() {
  if (ws && ws.readyState <= WebSocket.OPEN) return;

  try {
    ws = new WebSocket(BRIDGE_URL);
  } catch (e) {
    console.log("[bridge] WebSocket constructor failed:", e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log("[bridge] Connected to bridge server");
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    // Send current active tab info
    notifyActiveTab();
  };

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    // Command from bridge server — forward to content script
    if (msg.id !== undefined && msg.type) {
      const tabId = activeTabId;
      if (!tabId) {
        wsSend({ type: "response", id: msg.id, response: { error: "no active tab" } });
        return;
      }
      try {
        const response = await browser.tabs.sendMessage(tabId, msg);
        wsSend({ type: "response", id: msg.id, response });
      } catch (e) {
        wsSend({ type: "response", id: msg.id, response: { error: e.message } });
      }
    }
  };

  ws.onclose = () => {
    console.log("[bridge] Disconnected");
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {};
}

function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

async function notifyActiveTab() {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0) {
      activeTabId = tabs[0].id;
      wsSend({
        type: "activeTab",
        tabId: activeTabId,
        url: tabs[0].url,
        title: tabs[0].title,
      });
    }
  } catch {}
}

// Listen for messages from content scripts
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Forward events and contentReady to bridge server
  if (msg.type === "events" || msg.type === "contentReady") {
    if (msg.type === "contentReady" && sender.tab?.active) {
      activeTabId = sender.tab.id;
    }
    wsSend(msg);
  }
  // Don't block — return false (synchronous)
  return false;
});

// Track tab activation
browser.tabs.onActivated.addListener((info) => {
  activeTabId = info.tabId;
  browser.tabs.get(info.tabId).then(tab => {
    wsSend({ type: "activeTab", tabId: info.tabId, url: tab.url, title: tab.title });
  }).catch(() => {});
});

// Track tab URL changes
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId === activeTabId && changeInfo.status === "complete") {
    wsSend({ type: "tabUpdated", tabId, url: tab.url, title: tab.title, status: "complete" });
  }
});

// Initial connection
connect();
