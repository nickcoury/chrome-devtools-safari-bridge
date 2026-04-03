/**
 * Shared CDP WebSocket client.
 * Used to connect to both Chrome and our bridge via raw WebSocket.
 */

import WebSocket from 'ws';

const DEFAULT_TIMEOUT = 10000;

export class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.msgId = 1;
    this.pending = new Map();
    this.events = [];
    this._handlers = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.id && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        } else if (msg.method) {
          this.events.push(msg);
          const handlers = this._handlers.get(msg.method) || [];
          for (const h of handlers) h(msg.params);
        }
      });
    });
  }

  send(method, params = {}, timeout = DEFAULT_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, timeout);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    if (!this._handlers.has(method)) this._handlers.set(method, []);
    this._handlers.get(method).push(handler);
  }

  off(method, handler) {
    const handlers = this._handlers.get(method) || [];
    this._handlers.set(method, handlers.filter(h => h !== handler));
  }

  waitEvent(method, timeout = DEFAULT_TIMEOUT) {
    const idx = this.events.findIndex(e => e.method === method);
    if (idx >= 0) return Promise.resolve(this.events.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(method, handler);
        reject(new Error(`Timeout waiting for ${method}`));
      }, timeout);
      const handler = (params) => {
        clearTimeout(timer);
        this.off(method, handler);
        resolve({ method, params });
      };
      this.on(method, handler);
    });
  }

  drainEvents(method) {
    const matching = this.events.filter(e => e.method === method);
    this.events = this.events.filter(e => e.method !== method);
    return matching;
  }

  clearEvents() {
    this.events = [];
  }

  close() {
    this.ws?.close();
  }
}

/**
 * Wrapper around Puppeteer's CDPSession to match CDPClient interface.
 */
export class PuppeteerCDPAdapter {
  constructor(cdpSession) {
    this.session = cdpSession;
    this.events = [];
    this._handlers = new Map();

    // Buffer all events
    this.session.on('*', (eventName, params) => {
      // Puppeteer CDPSession emits events as (method, params)
    });
  }

  /**
   * Must be called after construction to set up event listening.
   * Pass the list of event names to subscribe to.
   */
  subscribeEvents(eventNames) {
    for (const name of eventNames) {
      this.session.on(name, (params) => {
        this.events.push({ method: name, params });
        const handlers = this._handlers.get(name) || [];
        for (const h of handlers) h(params);
      });
    }
  }

  async send(method, params = {}, timeout = DEFAULT_TIMEOUT) {
    const timer = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${method}`)), timeout)
    );
    return Promise.race([this.session.send(method, params), timer]);
  }

  on(method, handler) {
    if (!this._handlers.has(method)) this._handlers.set(method, []);
    this._handlers.get(method).push(handler);
  }

  off(method, handler) {
    const handlers = this._handlers.get(method) || [];
    this._handlers.set(method, handlers.filter(h => h !== handler));
  }

  waitEvent(method, timeout = DEFAULT_TIMEOUT) {
    const idx = this.events.findIndex(e => e.method === method);
    if (idx >= 0) return Promise.resolve(this.events.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(method, handler);
        reject(new Error(`Timeout waiting for ${method}`));
      }, timeout);
      const handler = (params) => {
        clearTimeout(timer);
        this.off(method, handler);
        resolve({ method, params });
      };
      this.on(method, handler);
    });
  }

  drainEvents(method) {
    const matching = this.events.filter(e => e.method === method);
    this.events = this.events.filter(e => e.method !== method);
    return matching;
  }

  clearEvents() {
    this.events = [];
  }

  close() {
    this.session.detach().catch(() => {});
  }
}
