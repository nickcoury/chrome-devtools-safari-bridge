import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import safari from "selenium-webdriver/safari.js";
import { Builder } from "selenium-webdriver";
import {
  TraceMap,
  generatedPositionFor,
  originalPositionFor,
} from "@jridgewell/trace-mapping";
import { assessDesktopCompatibility } from "./compatibility.js";
import { Logger } from "./logger.js";
import { formatDesktopStartError, runDesktopPreflight } from "./preflight.js";

const host = "localhost";
const port = Number(process.env.DESKTOP_PORT || 9333);
const frontendUrl =
  process.env.FRONTEND_URL || "devtools://devtools/bundled/inspector.html";
const targetId = "desktop-safari";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = path.join(repoRoot, "fixtures");
const fixtureMountPath = "/__fixtures";
const desktopStartUrl = process.env.DESKTOP_START_URL || "";

class DesktopSafariBackend {
  constructor(logger) {
    this.logger = logger.scope("backend");
    this.driver = null;
    this.lastSnapshot = null;
    this.networkBodies = new Map();
    this.resourceCache = new Map();
    this.scriptCache = new Map();
    this.sourceMapCache = new Map();
    this.nextScriptId = 1;
    this.scriptIdsByKey = new Map();
    this.breakpoints = new Map();
    this.nextBreakpointId = 1;
    this.pauseRequested = false;
    this.pauseOnExceptions = "none";
    this.breakpointActive = true;
    this.profilerEnabled = false;
    this.animationEnabled = false;
  }

  async start() {
    const options = new safari.Options();
    options.set("webSocketUrl", true);
    options.set("safari:automaticInspection", true);
    options.set("safari:automaticProfiling", false);
    try {
      this.driver = await new Builder()
        .forBrowser("safari")
        .setSafariOptions(options)
        .build();
    } catch (error) {
      throw new Error(formatDesktopStartError(error));
    }
    const rawCapabilities = await this.driver.getCapabilities();
    const capabilities = Object.fromEntries(rawCapabilities.map_);
    this.logger.info("session capabilities", capabilities);
    await this.driver.get("https://example.com");
    await this.installInstrumentation();
    await this.refreshSnapshot();
  }

  async stop() {
    if (this.driver) {
      await this.driver.quit();
      this.driver = null;
    }
  }

  async navigate(url) {
    await this.driver.get(url);
    await this.installInstrumentation();
    await this.refreshSnapshot();
    await this.refreshScripts();
    return {
      frameId: "root",
      loaderId: `loader-${Date.now()}`,
      url: this.lastSnapshot.url,
    };
  }

  async installInstrumentation() {
    await this.driver.executeScript(`
      (() => {
        if (!window.__safariCdtBridge) {
          window.__safariCdtBridge = {
            nextRequestId: 1,
            networkEvents: [],
            consoleEvents: [],
            performanceEvents: [],
            debuggerEvents: [],
            profileEvents: [],
            animationEvents: [],
          };
        }

        const bridge = window.__safariCdtBridge;
        if (!bridge.debuggerState) {
          bridge.debuggerState = {
            breakpoints: [],
            breakpointsActive: true,
            pauseRequested: false,
            pauseOnExceptions: "none",
            profilerEnabled: false,
            pendingInvocations: [],
            nextPauseId: 1,
          };
        }
        if (!bridge.animationState) {
          bridge.animationState = {
            enabled: false,
            playbackRate: 1,
            nextAnimationId: 1,
            animationIds: new WeakMap(),
            liveAnimations: {},
            snapshots: {},
            releasedIds: {},
          };
        }
        const alreadyInstalled = !!bridge.networkInstalled;
        bridge.networkInstalled = true;
        const debuggerState = bridge.debuggerState;
        const animationState = bridge.animationState;

        const push = (event) => {
          const enriched = {
            ...event,
            timestamp: Date.now(),
            monotonicTime: performance.now() / 1000,
          };
          if (event.domain === "console") {
            bridge.consoleEvents.push(enriched);
            return;
          }
          bridge.networkEvents.push(enriched);
        };

        const pushPerformance = (entry) => {
          bridge.performanceEvents.push({
            timestamp: Date.now(),
            monotonicTime: performance.now() / 1000,
            ...entry,
          });
        };

        const pushDebugger = (entry) => {
          bridge.debuggerEvents.push({
            timestamp: Date.now(),
            monotonicTime: performance.now() / 1000,
            ...entry,
          });
        };

        const clone = (value) => JSON.parse(JSON.stringify(value));

        const pathKey = (path) =>
          Array.isArray(path) ? path.join("/") : "";

        const getNodePath = (node) => {
          if (!node || node === window || node === document) {
            return [];
          }
          const path = [];
          let current = node;
          while (current && current !== document) {
            const parent = current.parentNode;
            if (!parent?.childNodes) {
              return null;
            }
            const index = Array.prototype.indexOf.call(parent.childNodes, current);
            if (index < 0) {
              return null;
            }
            path.unshift(index);
            current = parent;
          }
          return current === document ? path : null;
        };

        const getNodeByPath = (path) => {
          if (!Array.isArray(path)) {
            return null;
          }
          let current = document;
          for (const index of path) {
            current = current?.childNodes?.[index];
            if (!current) {
              return null;
            }
          }
          return current;
        };

        const toFiniteNumber = (value) => {
          if (typeof value !== "number" || Number.isNaN(value)) {
            return null;
          }
          if (!Number.isFinite(value)) {
            return null;
          }
          return value;
        };

        const quantizeTime = (value) => {
          const numeric = toFiniteNumber(value);
          if (numeric === null) {
            return null;
          }
          return Math.round(numeric * 100) / 100;
        };

        const getAnimationType = (animation) => {
          const ctorName = animation?.constructor?.name || "";
          if (ctorName === "CSSTransition") {
            return "CSSTransition";
          }
          if (ctorName === "CSSAnimation") {
            return "CSSAnimation";
          }
          return "WebAnimation";
        };

        const getAnimationName = (animation, type) => {
          if (type === "CSSAnimation" && animation?.animationName) {
            return animation.animationName;
          }
          if (type === "CSSTransition" && animation?.transitionProperty) {
            return animation.transitionProperty;
          }
          return animation?.id || animation?.effect?.target?.id || "animation";
        };

        const ensureAnimationId = (animation, type, targetPath, name) => {
          const existing = animationState.animationIds.get(animation);
          if (existing) {
            return existing;
          }
          const cssId =
            type === "CSSAnimation" || type === "CSSTransition"
              ? type + ":" + pathKey(targetPath) + ":" + name
              : "";
          const released = Object.keys(animationState.releasedIds).find((id) => {
            const releasedSnapshot = animationState.releasedIds[id];
            return (
              releasedSnapshot?.type === type &&
              releasedSnapshot?.cssId === cssId &&
              releasedSnapshot?.name === name
            );
          });
          const animationId = released || "animation:" + animationState.nextAnimationId++;
          animationState.animationIds.set(animation, animationId);
          return animationId;
        };

        const serializeTiming = (timing = {}) => ({
          delay: Number(timing.delay || 0),
          endDelay: Number(timing.endDelay || 0),
          iterationStart: Number(timing.iterationStart || 0),
          iterations: Number.isFinite(Number(timing.iterations))
            ? Number(timing.iterations)
            : null,
          duration:
            typeof timing.duration === "number" && Number.isFinite(timing.duration)
              ? timing.duration
              : 0,
          direction: timing.direction || "normal",
          fill: timing.fill || "none",
          easing: timing.easing || "linear",
        });

        const serializeKeyframes = (effect) => {
          if (!effect?.getKeyframes) {
            return [];
          }
          try {
            return effect.getKeyframes().map((keyframe) => ({
              offset:
                typeof keyframe.offset === "number"
                  ? String(Math.round(keyframe.offset * 100)) + "%"
                  : "0%",
              easing: keyframe.easing || "linear",
              properties: Object.fromEntries(
                Object.entries(keyframe).filter(([key, value]) => (
                  ![
                    "offset",
                    "computedOffset",
                    "easing",
                    "composite",
                  ].includes(key) &&
                  typeof value === "string"
                )),
              ),
            }));
          } catch {
            return [];
          }
        };

        const getAnimatedPropertyNames = (snapshot) => {
          const names = new Set();
          for (const keyframe of snapshot?.source?.keyframesRule?.keyframes || []) {
            for (const name of Object.keys(keyframe.properties || {})) {
              names.add(name);
            }
          }
          if (snapshot?.type === "CSSTransition" && snapshot?.name) {
            names.add(snapshot.name);
          }
          return Array.from(names);
        };

        const serializeAnimation = (animation) => {
          const effect = animation?.effect;
          const type = getAnimationType(animation);
          const target = effect?.target || null;
          const targetPath = getNodePath(target);
          const name = getAnimationName(animation, type);
          const id = ensureAnimationId(animation, type, targetPath, name);
          const timing = serializeTiming(effect?.getTiming?.());
          const keyframes = serializeKeyframes(effect);
          const cssId =
            type === "CSSAnimation" || type === "CSSTransition"
              ? type + ":" + pathKey(targetPath) + ":" + name
              : "";
          const snapshot = {
            id,
            name,
            pausedState: animation.playState === "paused",
            playState: animation.playState || "idle",
            playbackRate:
              typeof animation.playbackRate === "number"
                ? animation.playbackRate
                : animationState.playbackRate,
            startTime: quantizeTime(animation.startTime),
            currentTime: quantizeTime(animation.currentTime),
            type,
            cssId,
            targetPath,
            source: {
              ...timing,
              targetPath,
              keyframesRule: {
                name,
                keyframes,
              },
            },
          };
          snapshot.propertyNames = getAnimatedPropertyNames(snapshot);
          return snapshot;
        };

        const maybeApplyPlaybackRate = (animation) => {
          if (!animation || typeof animation.playbackRate !== "number") {
            return;
          }
          if (animation.playbackRate !== animationState.playbackRate) {
            try {
              animation.playbackRate = animationState.playbackRate;
            } catch {}
          }
        };

        const snapshotSignature = (snapshot) => JSON.stringify(snapshot);

        const queueAnimationEvent = (event) => {
          bridge.animationEvents.push({
            timestamp: Date.now(),
            monotonicTime: performance.now() / 1000,
            ...event,
          });
        };

        const scanAnimations = () => {
          const animations = [];
          if (document.getAnimations) {
            try {
              animations.push(...document.getAnimations({ subtree: true }));
            } catch {
              animations.push(...document.getAnimations());
            }
          }

          const nextSnapshots = {};
          const nextLiveAnimations = {};
          const seenIds = new Set();

          for (const animation of animations) {
            maybeApplyPlaybackRate(animation);
            const snapshot = serializeAnimation(animation);
            const previous = animationState.snapshots[snapshot.id];
            const signature = snapshotSignature(snapshot);
            seenIds.add(snapshot.id);
            nextSnapshots[snapshot.id] = { snapshot, signature };
            nextLiveAnimations[snapshot.id] = animation;

            if (!previous) {
              queueAnimationEvent({ kind: "created", id: snapshot.id });
              queueAnimationEvent({ kind: "started", animation: snapshot });
              continue;
            }

            if (previous.signature !== signature) {
              queueAnimationEvent({ kind: "updated", animation: snapshot });
            }
          }

          for (const [animationId] of Object.entries(animationState.snapshots)) {
            if (!seenIds.has(animationId)) {
              animationState.releasedIds[animationId] =
                animationState.snapshots[animationId].snapshot;
              queueAnimationEvent({ kind: "canceled", id: animationId });
            }
          }

          animationState.snapshots = nextSnapshots;
          animationState.liveAnimations = nextLiveAnimations;
        };

        const getAnimationSnapshot = (animationId) => {
          scanAnimations();
          return animationState.snapshots[animationId]?.snapshot || null;
        };

        const getAnimationById = (animationId) => {
          scanAnimations();
          return animationState.liveAnimations[animationId] || null;
        };

        const buildCssStyle = (properties, styleSheetId) => {
          const cssProperties = properties.map(({ name, value }) => ({
            name,
            value,
            text: name + ": " + value + ";",
            important: false,
            implicit: false,
            parsedOk: true,
            disabled: false,
            range: {
              startLine: 0,
              startColumn: 0,
              endLine: 0,
              endColumn: 0,
            },
          }));
          return {
            styleSheetId,
            cssProperties,
            shorthandEntries: [],
            cssText: cssProperties.map((property) => property.text).join(" "),
            range: {
              startLine: 0,
              startColumn: 0,
              endLine: 0,
              endColumn: 0,
            },
          };
        };

        const collectAnimatedStylesForElement = (element, styleSheetId) => {
          if (!element?.getAnimations) {
            return {
              animationStyles: [],
              transitionsStyle: buildCssStyle([], styleSheetId),
            };
          }
          const animations = element.getAnimations();
          const computedStyle = getComputedStyle(element);
          const animationStyles = [];
          const transitionProperties = new Map();

          for (const animation of animations) {
            const snapshot = serializeAnimation(animation);
            const propertyNames = snapshot.propertyNames || [];
            const cssProperties = propertyNames
              .map((name) => ({ name, value: computedStyle.getPropertyValue(name) }))
              .filter((property) => property.value);

            if (snapshot.type === "CSSTransition") {
              for (const property of cssProperties) {
                transitionProperties.set(property.name, property.value);
              }
              continue;
            }

            animationStyles.push({
              name: snapshot.name,
              style: buildCssStyle(cssProperties, styleSheetId),
            });
          }

          return {
            animationStyles,
            transitionsStyle: buildCssStyle(
              Array.from(transitionProperties, ([name, value]) => ({ name, value })),
              styleSheetId,
            ),
          };
        };

        bridge.setAnimationConfig = (config = {}) => {
          if (typeof config.enabled === "boolean") {
            animationState.enabled = config.enabled;
          }
          if (typeof config.playbackRate === "number" && Number.isFinite(config.playbackRate)) {
            animationState.playbackRate = config.playbackRate;
          }
          scanAnimations();
          return true;
        };

        bridge.collectAnimationEvents = () => {
          if (!animationState.enabled) {
            bridge.animationEvents.length = 0;
            return [];
          }
          scanAnimations();
          const events = bridge.animationEvents.slice();
          bridge.animationEvents.length = 0;
          return events;
        };

        bridge.getAnimationSnapshot = (animationId) => clone(getAnimationSnapshot(animationId));

        bridge.getDocumentAnimationPlaybackRate = () => animationState.playbackRate;

        bridge.setDocumentAnimationPlaybackRate = (playbackRate) => {
          if (typeof playbackRate !== "number" || !Number.isFinite(playbackRate)) {
            return false;
          }
          animationState.playbackRate = playbackRate;
          scanAnimations();
          for (const animation of Object.values(animationState.liveAnimations)) {
            try {
              animation.playbackRate = playbackRate;
            } catch {}
          }
          scanAnimations();
          return true;
        };

        bridge.setAnimationsPaused = (animationIds = [], paused = false) => {
          let changed = false;
          for (const animationId of animationIds) {
            const animation = getAnimationById(animationId);
            if (!animation) {
              continue;
            }
            try {
              if (paused) {
                animation.pause();
              } else {
                animation.play();
                maybeApplyPlaybackRate(animation);
              }
              changed = true;
            } catch {}
          }
          scanAnimations();
          return changed;
        };

        bridge.seekAnimations = (animationIds = [], currentTime = 0) => {
          let changed = false;
          for (const animationId of animationIds) {
            const animation = getAnimationById(animationId);
            if (!animation) {
              continue;
            }
            try {
              animation.currentTime = currentTime;
              changed = true;
            } catch {}
          }
          scanAnimations();
          return changed;
        };

        bridge.releaseAnimations = (animationIds = []) => {
          for (const animationId of animationIds) {
            delete animationState.liveAnimations[animationId];
            delete animationState.snapshots[animationId];
          }
          return true;
        };

        bridge.resolveAnimationObject = (animationId) => {
          const snapshot = getAnimationSnapshot(animationId);
          if (!snapshot) {
            return null;
          }
          return {
            objectId: "animation:" + animationId,
            type: "object",
            className: "Animation",
            description: (snapshot.type + " " + snapshot.name).trim(),
          };
        };

        bridge.setAnimationTiming = (animationId, duration, delay) => {
          const animation = getAnimationById(animationId);
          const effect = animation?.effect;
          if (!effect?.updateTiming) {
            return false;
          }
          try {
            effect.updateTiming({ duration, delay });
            scanAnimations();
            return true;
          } catch {
            return false;
          }
        };

        bridge.getAnimatedStylesForPath = (path, styleSheetId = "animation") => {
          const node = getNodeByPath(path);
          if (!node || node.nodeType !== Node.ELEMENT_NODE) {
            return {
              animationStyles: [],
              transitionsStyle: buildCssStyle([], styleSheetId),
              inherited: [],
            };
          }

          const inherited = [];
          let current = node.parentElement;
          while (current) {
            const styles = collectAnimatedStylesForElement(
              current,
              styleSheetId + ":inherited",
            );
            if (
              styles.animationStyles.length ||
              styles.transitionsStyle.cssProperties.length
            ) {
              inherited.push(styles);
            }
            current = current.parentElement;
          }

          return {
            ...collectAnimatedStylesForElement(node, styleSheetId),
            inherited,
          };
        };

        if (alreadyInstalled) {
          return;
        }

        const parseStack = (stack) => {
          const lines = String(stack || "")
            .split("\\n")
            .map((line) => line.trim())
            .filter(Boolean);
          const frames = [];
          for (const line of lines) {
            const cleaned = line.startsWith("@") ? "anonymous" + line : line;
            const match = /^(.*?)@(.*):(\\d+):(\\d+)$/.exec(cleaned);
            if (!match) {
              continue;
            }
            const [, functionName, url, lineNumber, columnNumber] = match;
            if (!url || url === "[native code]") {
              continue;
            }
            frames.push({
              functionName: functionName || "(anonymous)",
              url,
              lineNumber: Number(lineNumber),
              columnNumber: Number(columnNumber),
            });
          }
          return frames;
        };

        const captureFrames = (skipCount = 0) => {
          const rawStack = new Error().stack || "";
          const frames = parseStack(rawStack);
          const sliced = frames.slice(skipCount);
          return {
            rawStack,
            frames: sliced.length ? sliced : frames,
          };
        };

        const captureMeta = (kind, label, skipCount = 0) => {
          const { rawStack, frames } = captureFrames(skipCount + 1);
          const locationFrame = frames[0] || {
            functionName: label || "(anonymous)",
            url: location.href,
            lineNumber: 1,
            columnNumber: 1,
          };
          return {
            kind,
            label: label || locationFrame.functionName || "(anonymous)",
            url: locationFrame.url || location.href,
            lineNumber: Math.max(0, (locationFrame.lineNumber || 1) - 1),
            columnNumber: Math.max(0, (locationFrame.columnNumber || 1) - 1),
            functionName: locationFrame.functionName || label || "(anonymous)",
            rawStack,
            stackFrames: frames.map((frame) => ({
              ...frame,
              lineNumber: Math.max(0, (frame.lineNumber || 1) - 1),
              columnNumber: Math.max(0, (frame.columnNumber || 1) - 1),
            })),
          };
        };

        const matchesBreakpoint = (meta) => {
          if (!debuggerState.breakpointsActive) {
            return [];
          }
          return debuggerState.breakpoints.filter((breakpoint) => {
            if (breakpoint.url && breakpoint.url !== meta.url) {
              return false;
            }
            if (breakpoint.lineNumber !== meta.lineNumber) {
              return false;
            }
            if (
              typeof breakpoint.columnNumber === "number" &&
              breakpoint.columnNumber !== meta.columnNumber
            ) {
              return false;
            }
            return true;
          });
        };

        const recordProfile = (meta, startTime, endTime) => {
          if (!debuggerState.profilerEnabled) {
            return;
          }
          bridge.profileEvents.push({
            kind: "sample",
            meta,
            startTime,
            endTime,
            duration: endTime - startTime,
          });
        };

        const wrapCallback = (callback, metaFactory) => {
          if (typeof callback !== "function") {
            return callback;
          }
          if (callback.__safariCdtWrapped) {
            return callback.__safariCdtWrapped;
          }
          const staticMeta =
            typeof metaFactory === "function"
              ? metaFactory()
              : metaFactory;

          const wrapped = function(...args) {
            const meta = staticMeta;
            const hitBreakpoints = matchesBreakpoint(meta);
            if (debuggerState.pauseRequested || hitBreakpoints.length) {
              debuggerState.pauseRequested = false;
              const pauseId = String(debuggerState.nextPauseId++);
              debuggerState.pendingInvocations.push({
                pauseId,
                callback,
                thisArg: this,
                args,
                meta,
              });
              pushDebugger({
                kind: "paused",
                reason: hitBreakpoints.length ? "breakpoint" : "other",
                pauseId,
                meta,
                hitBreakpoints: hitBreakpoints.map((breakpoint) => breakpoint.breakpointId),
              });
              return undefined;
            }

            if (debuggerState.profilerEnabled) {
              const startTime = performance.now();
              try {
                return callback.apply(this, args);
              } finally {
                recordProfile(meta, startTime, performance.now());
              }
            }
            return callback.apply(this, args);
          };

          callback.__safariCdtWrapped = wrapped;
          return wrapped;
        };

        bridge.setDebuggerConfig = (config = {}) => {
          if (Array.isArray(config.breakpoints)) {
            debuggerState.breakpoints = config.breakpoints;
          }
          if (typeof config.breakpointsActive === "boolean") {
            debuggerState.breakpointsActive = config.breakpointsActive;
          }
          if (typeof config.pauseRequested === "boolean") {
            debuggerState.pauseRequested = config.pauseRequested;
          }
          if (typeof config.pauseOnExceptions === "string") {
            debuggerState.pauseOnExceptions = config.pauseOnExceptions;
          }
          if (typeof config.profilerEnabled === "boolean") {
            debuggerState.profilerEnabled = config.profilerEnabled;
          }
          return true;
        };

        bridge.resumeDebugger = (mode = "resume", pauseId = null) => {
          const queue = debuggerState.pendingInvocations;
          if (!queue.length) {
            if (mode !== "resume") {
              debuggerState.pauseRequested = true;
            }
            return false;
          }
          const index = pauseId
            ? queue.findIndex((entry) => entry.pauseId === pauseId)
            : 0;
          const pending = index >= 0 ? queue.splice(index, 1)[0] : queue.shift();
          setTimeout(() => {
            try {
              pending.callback.apply(pending.thisArg, pending.args);
            } catch (error) {
              setTimeout(() => {
                throw error;
              }, 0);
            } finally {
              if (mode !== "resume") {
                debuggerState.pauseRequested = true;
              }
            }
          }, 0);
          return true;
        };

        const normalizeHeaders = (headersLike) => {
          const out = {};
          if (!headersLike) return out;
          if (headersLike instanceof Headers) {
            for (const [key, value] of headersLike.entries()) {
              out[key] = value;
            }
            return out;
          }
          if (Array.isArray(headersLike)) {
            for (const [key, value] of headersLike) {
              out[key] = value;
            }
            return out;
          }
          return { ...headersLike };
        };

        const nextId = () => String(bridge.nextRequestId++);

        const originalFetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const request = new Request(...args);
          const requestId = nextId();
          push({
            kind: "request",
            requestId,
            url: request.url,
            method: request.method,
            headers: normalizeHeaders(request.headers),
            postData: null,
            resourceType: "Fetch",
            initiatorType: "fetch",
          });
          try {
            const response = await originalFetch(...args);
            const clone = response.clone();
            let body = "";
            try {
              body = await clone.text();
            } catch {}
            push({
              kind: "response",
              requestId,
              url: response.url || request.url,
              status: response.status,
              statusText: response.statusText,
              headers: normalizeHeaders(response.headers),
              mimeType: response.headers.get("content-type") || "",
              body,
              encodedDataLength: body.length,
              resourceType: "Fetch",
            });
            push({
              kind: "finished",
              requestId,
              encodedDataLength: body.length,
            });
            return response;
          } catch (error) {
            push({
              kind: "failed",
              requestId,
              errorText: String(error),
              canceled: false,
            });
            throw error;
          }
        };

        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

        XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
          this.__safariCdtRequest = {
            requestId: nextId(),
            method,
            url: new URL(url, location.href).href,
            headers: {},
            postData: null,
            resourceType: "XHR",
          };
          return originalOpen.call(this, method, url, async, user, password);
        };

        XMLHttpRequest.prototype.setRequestHeader = function(key, value) {
          if (this.__safariCdtRequest) {
            this.__safariCdtRequest.headers[key] = value;
          }
          return originalSetRequestHeader.call(this, key, value);
        };

        XMLHttpRequest.prototype.send = function(body) {
          const meta = this.__safariCdtRequest || {
            requestId: nextId(),
            method: "GET",
            url: location.href,
            headers: {},
            postData: null,
            resourceType: "XHR",
          };
          meta.postData = typeof body === "string" ? body : null;
          push({
            kind: "request",
            ...meta,
            initiatorType: "xmlhttprequest",
          });

          this.addEventListener("loadend", () => {
            const rawHeaders = this.getAllResponseHeaders()
              .trim()
              .split(/[\\r\\n]+/)
              .filter(Boolean);
            const headers = {};
            for (const line of rawHeaders) {
              const parts = line.split(": ");
              const header = parts.shift();
              headers[header] = parts.join(": ");
            }
            const responseBody =
              typeof this.responseText === "string" ? this.responseText : "";
            push({
              kind: "response",
              requestId: meta.requestId,
              url: this.responseURL || meta.url,
              status: this.status,
              statusText: this.statusText,
              headers,
              mimeType: this.getResponseHeader("content-type") || "",
              body: responseBody,
              encodedDataLength: responseBody.length,
              resourceType: "XHR",
            });
            if (this.status === 0) {
              push({
                kind: "failed",
                requestId: meta.requestId,
                errorText: "XHR failed",
                canceled: false,
              });
            } else {
              push({
                kind: "finished",
                requestId: meta.requestId,
                encodedDataLength: responseBody.length,
              });
            }
          }, { once: true });

          return originalSend.call(this, body);
        };

        const serializeValue = (value) => {
          if (value === null) {
            return { type: "object", subtype: "null", value: null, description: "null" };
          }
          if (value === undefined) {
            return { type: "undefined", description: "undefined" };
          }
          const type = typeof value;
          if (type === "object") {
            let description = "Object";
            try {
              description = Array.isArray(value)
                ? "Array(" + value.length + ")"
                : value?.constructor?.name || "Object";
            } catch {}
            return { type: "object", description, value: null };
          }
          return { type, value, description: String(value) };
        };

        const originalConsole = { ...console };
        for (const level of ["log", "info", "warn", "error", "debug"]) {
          const original = originalConsole[level]?.bind(console);
          if (!original) continue;
          console[level] = (...args) => {
            push({
              domain: "console",
              kind: "console-api",
              level,
              text: args.map((arg) => {
                try {
                  return typeof arg === "string" ? arg : JSON.stringify(arg);
                } catch {
                  return String(arg);
                }
              }).join(" "),
              args: args.map(serializeValue),
              stackTrace: [],
            });
            return original(...args);
          };
        }

        window.addEventListener("error", (event) => {
          if (debuggerState.pauseOnExceptions !== "none") {
            pushDebugger({
              kind: "paused",
              reason: "exception",
              pauseId: String(debuggerState.nextPauseId++),
              meta: captureMeta("exception", event.message || "Error", 1),
              hitBreakpoints: [],
            });
          }
          push({
            domain: "console",
            kind: "exception",
            text: event.message,
            url: event.filename,
            lineNumber: event.lineno,
            columnNumber: event.colno,
            stack: event.error?.stack || "",
          });
        });

        window.addEventListener("unhandledrejection", (event) => {
          if (debuggerState.pauseOnExceptions !== "none") {
            pushDebugger({
              kind: "paused",
              reason: "promiseRejection",
              pauseId: String(debuggerState.nextPauseId++),
              meta: captureMeta("exception", event.reason?.message || "Unhandled rejection", 1),
              hitBreakpoints: [],
            });
          }
          push({
            domain: "console",
            kind: "exception",
            text: event.reason?.message || String(event.reason),
            url: location.href,
            lineNumber: 0,
            columnNumber: 0,
            stack: event.reason?.stack || "",
          });
        });

        const knownEntryTypes = [
          "navigation",
          "resource",
          "mark",
          "measure",
          "paint",
          "longtask",
        ];

        const serializePerfEntry = (entry) => ({
          entryType: entry.entryType,
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
          initiatorType: entry.initiatorType || "",
          transferSize: entry.transferSize || 0,
          encodedBodySize: entry.encodedBodySize || 0,
          decodedBodySize: entry.decodedBodySize || 0,
          nextHopProtocol: entry.nextHopProtocol || "",
          renderBlockingStatus: entry.renderBlockingStatus || "",
          responseStatus: entry.responseStatus || 0,
        });

        if (!bridge.performanceInstalled) {
          bridge.performanceInstalled = true;
          for (const type of knownEntryTypes) {
            try {
              const observer = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                  pushPerformance(serializePerfEntry(entry));
                }
              });
              observer.observe({ type, buffered: true });
            } catch {}
          }

          for (const entry of performance.getEntries()) {
            if (knownEntryTypes.includes(entry.entryType)) {
              pushPerformance(serializePerfEntry(entry));
            }
          }
        }

        if (!bridge.debuggerInstalled) {
          bridge.debuggerInstalled = true;

          const originalSetTimeout = window.setTimeout.bind(window);
          window.setTimeout = (callback, timeout, ...args) =>
            originalSetTimeout(
              wrapCallback(callback, () => captureMeta("timer", "setTimeout", 1)),
              timeout,
              ...args,
            );

          const originalSetInterval = window.setInterval.bind(window);
          window.setInterval = (callback, timeout, ...args) =>
            originalSetInterval(
              wrapCallback(callback, () => captureMeta("timer", "setInterval", 1)),
              timeout,
              ...args,
            );

          const originalRequestAnimationFrame = window.requestAnimationFrame?.bind(window);
          if (originalRequestAnimationFrame) {
            window.requestAnimationFrame = (callback) =>
              originalRequestAnimationFrame(
                wrapCallback(callback, () => captureMeta("animation", "requestAnimationFrame", 1)),
              );
          }

          const originalQueueMicrotask = window.queueMicrotask?.bind(window);
          if (originalQueueMicrotask) {
            window.queueMicrotask = (callback) =>
              originalQueueMicrotask(
                wrapCallback(callback, () => captureMeta("microtask", "queueMicrotask", 1)),
              );
          }

          const originalAddEventListener = EventTarget.prototype.addEventListener;
          EventTarget.prototype.addEventListener = function(type, listener, options) {
            return originalAddEventListener.call(
              this,
              type,
              wrapCallback(
                listener,
                () => captureMeta("event", type || "event", 1),
              ),
              options,
            );
          };

          const originalThen = Promise.prototype.then;
          Promise.prototype.then = function(onFulfilled, onRejected) {
            return originalThen.call(
              this,
              wrapCallback(onFulfilled, () => captureMeta("promise", "then", 1)),
              wrapCallback(onRejected, () => captureMeta("promise", "catch", 1)),
            );
          };

          const originalCatch = Promise.prototype.catch;
          Promise.prototype.catch = function(onRejected) {
            return originalCatch.call(
              this,
              wrapCallback(onRejected, () => captureMeta("promise", "catch", 1)),
            );
          };

          const originalFinally = Promise.prototype.finally;
          Promise.prototype.finally = function(onFinally) {
            return originalFinally.call(
              this,
              wrapCallback(onFinally, () => captureMeta("promise", "finally", 1)),
            );
          };

          // View Transition API instrumentation
          if (document.startViewTransition) {
            const origStartViewTransition = document.startViewTransition.bind(document);
            document.startViewTransition = function(callbackOrOptions) {
              const transition = origStartViewTransition(callbackOrOptions);
              if (transition && transition.ready) {
                transition.ready.then(() => {
                  if (animationState.enabled) {
                    try {
                      const docAnims = document.getAnimations({ subtree: true });
                      for (const anim of docAnims) {
                        const effect = anim.effect;
                        if (effect && effect.pseudoElement &&
                            effect.pseudoElement.includes("view-transition")) {
                          const snapshot = serializeAnimation(anim);
                          snapshot.type = "ViewTransition";
                          snapshot.name = effect.pseudoElement || "view-transition";
                          queueAnimationEvent({ kind: "started", animation: snapshot });
                        }
                      }
                    } catch {}
                    scanAnimations();
                  }
                }).catch(() => {});
              }
              if (transition && transition.finished) {
                transition.finished.then(() => {
                  if (animationState.enabled) scanAnimations();
                }).catch(() => {});
              }
              return transition;
            };
          }
        }
      })();
    `);
    await this.#syncDebuggerConfig();
  }

  async getDocument() {
    await this.refreshSnapshot();
    return this.lastSnapshot.root;
  }

  async getScripts() {
    await this.refreshScripts();
    return Array.from(this.scriptCache.values());
  }

  async getNode(nodeId) {
    await this.refreshSnapshot();
    return this.lastSnapshot.nodes.get(nodeId) || null;
  }

  async requestChildNodes(nodeId) {
    await this.refreshSnapshot();
    const node = this.lastSnapshot.nodes.get(nodeId);
    return node?.children || [];
  }

  async describeNode(nodeId) {
    await this.refreshSnapshot();
    return this.lastSnapshot.nodes.get(nodeId) || null;
  }

  async evaluate(expression) {
    const result = await this.driver.executeScript(`return eval(arguments[0]);`, expression);
    return this.#toRemoteObject(result);
  }

  async getScriptSource(scriptId) {
    await this.refreshScripts();
    return this.scriptCache.get(scriptId)?.source || "";
  }

  async getPossibleBreakpoints() {
    await this.refreshScripts();
    return Array.from(this.scriptCache.values()).map((script) => ({
      scriptId: script.scriptId,
      lineNumber: 0,
      columnNumber: 0,
    }));
  }

  async getComputedStyle(nodeId) {
    await this.refreshSnapshot();
    const node = this.lastSnapshot.nodes.get(nodeId);
    if (!node?.backendPath) {
      return [];
    }
    return await this.driver.executeScript(
      `
      const path = arguments[0];
      let current = document;
      for (const index of path) {
        current = current.childNodes[index];
      }
      if (!current || current.nodeType !== Node.ELEMENT_NODE) {
        return [];
      }
      const style = getComputedStyle(current);
      return Array.from(style).map((name) => ({
        name,
        value: style.getPropertyValue(name),
      }));
      `,
      node.backendPath,
    );
  }

  async getAnimatedStyles(nodeId) {
    await this.refreshSnapshot();
    const node = this.lastSnapshot.nodes.get(nodeId);
    if (!node?.backendPath) {
      return {
        animationStyles: [],
        transitionsStyle: this.#emptyCssStyle("animation"),
        inherited: [],
      };
    }
    const animatedStyles = await this.driver.executeScript(
      `
      const bridge = window.__safariCdtBridge;
      if (!bridge?.getAnimatedStylesForPath) {
        return null;
      }
      return bridge.getAnimatedStylesForPath(arguments[0], arguments[1]);
      `,
      node.backendPath,
      `animation:${nodeId}`,
    );
    return this.#normalizeAnimatedStylesPayload(animatedStyles, nodeId);
  }

  async getOuterHTML(nodeId) {
    await this.refreshSnapshot();
    const node = this.lastSnapshot.nodes.get(nodeId);
    if (!node?.backendPath) {
      return "";
    }
    const html = await this.driver.executeScript(
      `
      const path = arguments[0];
      let current = document;
      for (const index of path) {
        current = current.childNodes[index];
      }
      return current?.outerHTML ?? current?.nodeValue ?? "";
      `,
      node.backendPath,
    );
    return html;
  }

  async getBoxModel(nodeId) {
    await this.refreshSnapshot();
    const node = this.lastSnapshot.nodes.get(nodeId);
    if (!node?.backendPath) {
      return null;
    }
    const rect = await this.driver.executeScript(
      `
      const path = arguments[0];
      let current = document;
      for (const index of path) {
        current = current.childNodes[index];
      }
      if (!current?.getBoundingClientRect) {
        return null;
      }
      const r = current.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height
      };
      `,
      node.backendPath,
    );
    if (!rect) {
      return null;
    }
    const { x, y, width, height } = rect;
    const quad = [x, y, x + width, y, x + width, y + height, x, y + height];
    return {
      model: {
        content: quad,
        padding: quad,
        border: quad,
        margin: quad,
        width,
        height,
      },
    };
  }

  async refreshSnapshot() {
    const snapshot = await this.driver.executeScript(`
      let nextId = 1;
      const nodes = [];
      function attrPairs(element) {
        const out = [];
        if (!element?.attributes) return out;
        for (const attr of element.attributes) {
          out.push(attr.name, attr.value);
        }
        return out;
      }
      function visit(node, path) {
        const nodeId = nextId++;
        const base = {
          nodeId,
          backendNodeId: nodeId,
          nodeType: node.nodeType,
          nodeName: node.nodeName,
          localName: node.localName || "",
          nodeValue: node.nodeValue || "",
          childNodeCount: node.childNodes ? node.childNodes.length : 0,
          children: [],
          attributes: node.nodeType === Node.ELEMENT_NODE ? attrPairs(node) : [],
          backendPath: path,
        };
        if (node.nodeType === Node.DOCUMENT_NODE) {
          base.documentURL = document.URL;
          base.baseURL = document.baseURI;
          base.xmlVersion = "";
          base.compatibilityMode = document.compatMode;
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
          base.frameId = "root";
        }
        nodes.push(base);
        if (node.childNodes?.length) {
          base.children = Array.from(node.childNodes, (child, index) =>
            visit(child, path.concat(index)),
          );
        }
        return base;
      }
      const root = visit(document, []);
      return { root, nodes, url: document.URL, title: document.title };
    `);

    const nodes = new Map();
    const pathToNodeId = new Map();
    const index = (node) => {
      nodes.set(node.nodeId, node);
      pathToNodeId.set(this.#pathKey(node.backendPath), node.nodeId);
      for (const child of node.children || []) {
        index(child);
      }
    };
    index(snapshot.root);
    this.lastSnapshot = { ...snapshot, nodes, pathToNodeId };
    return this.lastSnapshot;
  }

  async refreshScripts() {
    const pageUrl = this.lastSnapshot?.url || (await this.driver.getCurrentUrl());
    const scripts = await this.driver.executeScript(`
      return Array.from(document.scripts).map((script, index) => ({
        index,
        src: script.src || "",
        inline: !script.src,
        type: script.type || "",
        source: script.src ? "" : (script.textContent || ""),
      }));
    `);

    const nextCache = new Map();
    for (const script of scripts) {
      const generatedKey = script.inline
        ? "inline:" + pageUrl + ":" + script.index
        : "external:" + script.src;
      let scriptId = this.scriptIdsByKey.get(generatedKey);
      if (!scriptId) {
        scriptId = String(this.nextScriptId++);
        this.scriptIdsByKey.set(generatedKey, scriptId);
      }

      const url = script.inline
        ? pageUrl + "#inline-script-" + (script.index + 1)
        : script.src;
      const source = script.inline
        ? script.source
        : await this.#loadTextResource(url);
      const sourceMapURL =
        (await this.#discoverSourceMap(url, source)) ||
        this.#extractSourceMapURL(url, source);

      nextCache.set(scriptId, {
        scriptId,
        kind: "generated",
        url,
        matchUrls: script.inline ? [url, pageUrl] : [url],
        source,
        inline: script.inline,
        type: script.type || "text/javascript",
        sourceMapURL,
        startLine: 0,
        startColumn: 0,
        endLine: source.split("\n").length,
        endColumn: 0,
        executionContextId: 1,
        hash: this.#simpleHash(source),
        isModule: script.type === "module",
        hasSourceURL: false,
      });

      if (sourceMapURL) {
        const sourceMapRecord = this.sourceMapCache.get(sourceMapURL);
        if (sourceMapRecord?.resolvedSources?.length) {
          for (const sourceUrl of sourceMapRecord.resolvedSources) {
            const sourceKey = `source:${sourceUrl}`;
            let sourceScriptId = this.scriptIdsByKey.get(sourceKey);
            if (!sourceScriptId) {
              sourceScriptId = String(this.nextScriptId++);
              this.scriptIdsByKey.set(sourceKey, sourceScriptId);
            }
            const sourceResource = this.resourceCache.get(sourceUrl);
            const sourceContent = sourceResource?.content || "";
            nextCache.set(sourceScriptId, {
              scriptId: sourceScriptId,
              kind: "source",
              url: sourceUrl,
              matchUrls: [sourceUrl],
              source: sourceContent,
              inline: false,
              type: "text/typescript",
              sourceMapURL: "",
              startLine: 0,
              startColumn: 0,
              endLine: sourceContent.split("\n").length,
              endColumn: 0,
              executionContextId: 1,
              hash: this.#simpleHash(sourceContent),
              isModule: false,
              hasSourceURL: true,
              sourceMappedFrom: scriptId,
            });
          }
        }
      }
    }

    this.scriptCache = nextCache;
    return Array.from(this.scriptCache.values());
  }

  async getResource(url) {
    return await this.#loadResource(url);
  }

  async #loadTextResource(url) {
    const resource = await this.#loadResource(url);
    return resource.content;
  }

  async #loadResource(url) {
    if (this.resourceCache.has(url)) {
      return this.resourceCache.get(url);
    }

    let content = "";
    let mimeType = "text/plain";

    if (url === this.lastSnapshot?.url) {
      content = await this.driver.executeScript(
        "return '<!doctype html>\\n' + document.documentElement.outerHTML;",
      );
      mimeType = "text/html";
    } else if (url.includes("#inline-script-")) {
      const match = /#inline-script-(\\d+)$/.exec(url);
      const index = match ? Number(match[1]) - 1 : 0;
      content = await this.driver.executeScript(
        "const i = arguments[0]; return document.scripts[i]?.textContent || '';",
        index,
      );
      mimeType = "text/javascript";
    } else {
      const response = await fetch(url);
      content = await response.text();
      mimeType = response.headers.get("content-type") || mimeType;
    }

    const resource = { url, content, mimeType, base64Encoded: false };
    this.resourceCache.set(url, resource);
    return resource;
  }

  async #discoverSourceMap(scriptUrl, source) {
    const match =
      /[#@]\s*sourceMappingURL\s*=\s*(\S+)\s*$/m.exec(source);
    if (!match) {
      return "";
    }
    const mapUrl = new URL(match[1], scriptUrl).toString();
    if (!this.sourceMapCache.has(mapUrl)) {
      try {
        const resource = await this.#loadResource(mapUrl);
        const parsed = JSON.parse(resource.content);
        const resolvedSources = Array.isArray(parsed.sources)
          ? parsed.sources.map((sourcePath) => new URL(sourcePath, mapUrl).toString())
          : [];
        this.sourceMapCache.set(mapUrl, {
          parsed,
          traceMap: new TraceMap(parsed),
          resolvedSources,
        });
        if (Array.isArray(parsed.sources)) {
          for (let i = 0; i < parsed.sources.length; i += 1) {
            const sourceUrl = resolvedSources[i];
            const sourceContent = parsed.sourcesContent?.[i];
            if (typeof sourceContent === "string") {
              this.resourceCache.set(sourceUrl, {
                url: sourceUrl,
                content: sourceContent,
                mimeType: "text/plain",
                base64Encoded: false,
              });
            } else {
              try {
                await this.#loadResource(sourceUrl);
              } catch {}
            }
          }
        }
      } catch (error) {
        this.logger.debug("source map load failed", mapUrl, error?.message || error);
      }
    }
    return mapUrl;
  }

  #extractSourceMapURL(scriptUrl, source) {
    const match =
      /[#@]\s*sourceMappingURL\s*=\s*(\S+)\s*$/m.exec(source);
    if (!match) {
      return "";
    }
    return new URL(match[1], scriptUrl).toString();
  }

  #simpleHash(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
      hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }
    return hash.toString(16);
  }

  async drainNetworkEvents() {
    const events = await this.driver.executeScript(`
      const bridge = window.__safariCdtBridge;
      if (!bridge) {
        return [];
      }
      const events = bridge.networkEvents.slice();
      bridge.networkEvents.length = 0;
      return events;
    `);
    for (const event of events) {
      if (event.kind === "response") {
        this.networkBodies.set(event.requestId, {
          body: event.body || "",
          base64Encoded: false,
        });
      }
    }
    return events;
  }

  async drainConsoleEvents() {
    return await this.driver.executeScript(`
      const bridge = window.__safariCdtBridge;
      if (!bridge) {
        return [];
      }
      const events = bridge.consoleEvents.slice();
      bridge.consoleEvents.length = 0;
      return events;
    `);
  }

  async drainPerformanceEvents() {
    return await this.driver.executeScript(`
      const bridge = window.__safariCdtBridge;
      if (!bridge) {
        return [];
      }
      const events = bridge.performanceEvents.slice();
      bridge.performanceEvents.length = 0;
      return events;
    `);
  }

  async getPerformanceMetrics() {
    return await this.driver.executeScript(`
      const nav = performance.getEntriesByType("navigation")[0];
      const timing = performance.timing || {};
      const memory = performance.memory || {};
      const now = performance.now();
      return [
        { name: "Timestamp", value: Date.now() / 1000 },
        { name: "Documents", value: 1 },
        { name: "Frames", value: 1 },
        { name: "JSEventListeners", value: 0 },
        { name: "Nodes", value: document.getElementsByTagName("*").length },
        { name: "LayoutCount", value: 0 },
        { name: "RecalcStyleCount", value: 0 },
        { name: "LayoutDuration", value: 0 },
        { name: "RecalcStyleDuration", value: 0 },
        { name: "ScriptDuration", value: 0 },
        { name: "TaskDuration", value: now / 1000 },
        { name: "JSHeapUsedSize", value: memory.usedJSHeapSize || 0 },
        { name: "JSHeapTotalSize", value: memory.totalJSHeapSize || 0 },
        { name: "DomContentLoaded", value: nav?.domContentLoadedEventEnd || 0 },
        { name: "LoadEvent", value: nav?.loadEventEnd || 0 },
      ];
    `);
  }

  getResponseBody(requestId) {
    return this.networkBodies.get(requestId) || { body: "", base64Encoded: false };
  }

  async drainDebuggerEvents() {
    return await this.driver.executeScript(`
      const bridge = window.__safariCdtBridge;
      if (!bridge) {
        return [];
      }
      const events = bridge.debuggerEvents.slice();
      bridge.debuggerEvents.length = 0;
      return events;
    `);
  }

  async setAnimationEnabled(enabled) {
    this.animationEnabled = enabled !== false;
    await this.driver.executeScript(
      `
      const bridge = window.__safariCdtBridge;
      if (!bridge?.setAnimationConfig) {
        return false;
      }
      return bridge.setAnimationConfig({ enabled: arguments[0] });
      `,
      this.animationEnabled,
    );
  }

  async drainAnimationEvents() {
    return await this.driver.executeScript(`
      const bridge = window.__safariCdtBridge;
      if (!bridge?.collectAnimationEvents) {
        return [];
      }
      return bridge.collectAnimationEvents();
    `);
  }

  async getAnimationCurrentTime(animationId) {
    const snapshot = await this.driver.executeScript(
      `
      const bridge = window.__safariCdtBridge;
      return bridge?.getAnimationSnapshot
        ? bridge.getAnimationSnapshot(arguments[0])
        : null;
      `,
      animationId,
    );
    return Number(snapshot?.currentTime || 0);
  }

  async getAnimationPlaybackRate() {
    return await this.driver.executeScript(`
      const bridge = window.__safariCdtBridge;
      return bridge?.getDocumentAnimationPlaybackRate
        ? bridge.getDocumentAnimationPlaybackRate()
        : 1;
    `);
  }

  async setAnimationPlaybackRate(playbackRate) {
    await this.driver.executeScript(
      `
      const bridge = window.__safariCdtBridge;
      if (!bridge?.setDocumentAnimationPlaybackRate) {
        return false;
      }
      return bridge.setDocumentAnimationPlaybackRate(arguments[0]);
      `,
      playbackRate,
    );
  }

  async releaseAnimations(animationIds) {
    await this.driver.executeScript(
      `
      const bridge = window.__safariCdtBridge;
      if (!bridge?.releaseAnimations) {
        return false;
      }
      return bridge.releaseAnimations(arguments[0]);
      `,
      animationIds,
    );
  }

  async resolveAnimation(animationId) {
    return await this.driver.executeScript(
      `
      const bridge = window.__safariCdtBridge;
      return bridge?.resolveAnimationObject
        ? bridge.resolveAnimationObject(arguments[0])
        : null;
      `,
      animationId,
    );
  }

  async seekAnimations(animationIds, currentTime) {
    await this.driver.executeScript(
      `
      const bridge = window.__safariCdtBridge;
      if (!bridge?.seekAnimations) {
        return false;
      }
      return bridge.seekAnimations(arguments[0], arguments[1]);
      `,
      animationIds,
      currentTime,
    );
  }

  async setAnimationsPaused(animationIds, paused) {
    await this.driver.executeScript(
      `
      const bridge = window.__safariCdtBridge;
      if (!bridge?.setAnimationsPaused) {
        return false;
      }
      return bridge.setAnimationsPaused(arguments[0], arguments[1]);
      `,
      animationIds,
      paused,
    );
  }

  async setAnimationTiming(animationId, duration, delay) {
    await this.driver.executeScript(
      `
      const bridge = window.__safariCdtBridge;
      if (!bridge?.setAnimationTiming) {
        return false;
      }
      return bridge.setAnimationTiming(arguments[0], arguments[1], arguments[2]);
      `,
      animationId,
      duration,
      delay,
    );
  }

  async startProfiler() {
    this.profilerEnabled = true;
    await this.driver.executeScript(`
      const bridge = window.__safariCdtBridge;
      if (!bridge?.setDebuggerConfig) {
        return false;
      }
      bridge.profileEvents.length = 0;
      bridge.setDebuggerConfig({ profilerEnabled: true });
      return true;
    `);
  }

  async stopProfiler() {
    this.profilerEnabled = false;
    const samples = await this.driver.executeScript(`
      const bridge = window.__safariCdtBridge;
      if (!bridge?.setDebuggerConfig) {
        return [];
      }
      bridge.setDebuggerConfig({ profilerEnabled: false });
      const events = bridge.profileEvents.slice();
      bridge.profileEvents.length = 0;
      return events;
    `);
    return this.#buildProfile(samples);
  }

  async pause() {
    this.pauseRequested = true;
    await this.#syncDebuggerConfig();
  }

  async resume(mode = "resume", pauseId = null) {
    this.pauseRequested = mode !== "resume";
    const resumed = await this.driver.executeScript(
      `
      const bridge = window.__safariCdtBridge;
      if (!bridge?.resumeDebugger) {
        return false;
      }
      bridge.setDebuggerConfig({ pauseRequested: false });
      const mode = arguments[0];
      const pauseId = arguments[1];
      setTimeout(() => {
        bridge.resumeDebugger(mode, pauseId);
      }, 0);
      return true;
      `,
      mode,
      pauseId,
    );
    return resumed;
  }

  async setPauseOnExceptions(state) {
    this.pauseOnExceptions = state || "none";
    await this.#syncDebuggerConfig();
  }

  async setBreakpointsActive(active) {
    this.breakpointActive = active !== false;
    await this.#syncDebuggerConfig();
  }

  async setBreakpointByUrl(params) {
    await this.refreshScripts();
    const resolved = this.#resolveBreakpointLocations(params);
    const breakpointId = `breakpoint:${this.nextBreakpointId++}`;
    for (const location of resolved) {
      this.breakpoints.set(`${breakpointId}:${location.url}:${location.lineNumber}:${location.columnNumber}`, {
        breakpointId,
        url: location.url,
        lineNumber: location.lineNumber,
        columnNumber: location.matchColumnNumber,
      });
    }
    await this.#syncDebuggerConfig();
    return {
      breakpointId,
      locations: resolved.map((location) => ({
        scriptId: location.scriptId,
        lineNumber: location.lineNumber,
        columnNumber: location.columnNumber,
      })),
    };
  }

  async removeBreakpoint(breakpointId) {
    for (const key of Array.from(this.breakpoints.keys())) {
      if (this.breakpoints.get(key)?.breakpointId === breakpointId) {
        this.breakpoints.delete(key);
      }
    }
    await this.#syncDebuggerConfig();
  }

  #resolveBreakpointLocations(params) {
    const requestedUrl = params.url || "";
    const requestedLine = Number(params.lineNumber || 0);
    const requestedColumn = Number(params.columnNumber || 0);
    const locations = [];

    for (const script of this.scriptCache.values()) {
      if (script.url === requestedUrl && script.kind !== "source") {
        locations.push({
          scriptId: script.scriptId,
          url: script.matchUrls?.at(-1) || script.url,
          lineNumber: requestedLine,
          columnNumber: requestedColumn,
          matchColumnNumber: requestedColumn,
        });
        continue;
      }

      if (!script.sourceMapURL) {
        continue;
      }
      const sourceMapRecord = this.sourceMapCache.get(script.sourceMapURL);
      if (!sourceMapRecord) {
        continue;
      }
      const sourceIndex = sourceMapRecord.resolvedSources.findIndex(
        (sourceUrl) => sourceUrl === requestedUrl,
      );
      if (sourceIndex === -1) {
        continue;
      }
      const generated = generatedPositionFor(sourceMapRecord.traceMap, {
        source: sourceMapRecord.parsed.sources[sourceIndex],
        line: requestedLine + 1,
        column: requestedColumn,
      });
      if (!generated?.line) {
        continue;
      }
      locations.push({
        scriptId: script.scriptId,
        url: script.url,
        lineNumber: Math.max(0, generated.line - 1),
        columnNumber: Math.max(0, generated.column || 0),
        matchColumnNumber: requestedColumn > 0 ? Math.max(0, generated.column || 0) : undefined,
      });
    }

    return locations;
  }

  mapToUiLocation(url, lineNumber, columnNumber) {
    for (const script of this.scriptCache.values()) {
      if (script.url !== url || !script.sourceMapURL || script.kind !== "generated") {
        continue;
      }
      const sourceMapRecord = this.sourceMapCache.get(script.sourceMapURL);
      if (!sourceMapRecord) {
        continue;
      }
      const original = originalPositionFor(sourceMapRecord.traceMap, {
        line: lineNumber + 1,
        column: columnNumber,
      });
      if (!original?.source || !original.line) {
        continue;
      }
      const sourceIndex = sourceMapRecord.parsed.sources.indexOf(original.source);
      const sourceUrl =
        sourceIndex >= 0
          ? sourceMapRecord.resolvedSources[sourceIndex]
          : new URL(original.source, script.sourceMapURL).toString();
      return {
        scriptId: this.findScriptIdForUrl(sourceUrl),
        url: sourceUrl,
        lineNumber: Math.max(0, original.line - 1),
        columnNumber: Math.max(0, original.column || 0),
      };
    }

    return {
      scriptId: this.findScriptIdForUrl(url),
      url,
      lineNumber,
      columnNumber,
    };
  }

  async #syncDebuggerConfig() {
    if (!this.driver) {
      return;
    }
    await this.driver.executeScript(
      `
      const bridge = window.__safariCdtBridge;
      if (!bridge?.setDebuggerConfig) {
        return false;
      }
      return bridge.setDebuggerConfig(arguments[0]);
      `,
      {
        breakpoints: Array.from(this.breakpoints.values()),
        breakpointsActive: this.breakpointActive,
        pauseRequested: this.pauseRequested,
        pauseOnExceptions: this.pauseOnExceptions,
        profilerEnabled: this.profilerEnabled,
      },
    );
  }

  #buildProfile(samples) {
    const nodes = [
      {
        id: 1,
        callFrame: {
          functionName: "(root)",
          scriptId: "0",
          url: "",
          lineNumber: 0,
          columnNumber: 0,
        },
        hitCount: 0,
        children: [],
      },
    ];
    const nodeIds = new Map();
    const profileSamples = [];
    const timeDeltas = [];
    let nextNodeId = 2;

    for (const sample of samples) {
      const meta = sample.meta || {};
      const uiLocation = this.mapToUiLocation(
        meta.url || "",
        Number(meta.lineNumber || 0),
        Number(meta.columnNumber || 0),
      );
      const key = `${uiLocation.url}:${uiLocation.lineNumber}:${uiLocation.columnNumber}:${meta.functionName || meta.label || "(anonymous)"}`;
      let nodeId = nodeIds.get(key);
      if (!nodeId) {
        nodeId = nextNodeId++;
        nodeIds.set(key, nodeId);
        nodes[0].children.push(nodeId);
        nodes.push({
          id: nodeId,
          callFrame: {
            functionName: meta.functionName || meta.label || "(anonymous)",
            scriptId: uiLocation.scriptId || this.findScriptIdForUrl(meta.url || ""),
            url: uiLocation.url,
            lineNumber: uiLocation.lineNumber,
            columnNumber: uiLocation.columnNumber,
          },
          hitCount: 0,
          children: [],
        });
      }
      const node = nodes.find((entry) => entry.id === nodeId);
      node.hitCount += 1;
      nodes[0].hitCount += 1;
      profileSamples.push(nodeId);
      timeDeltas.push(Math.max(1, Math.round(Number(sample.duration || 0) * 1000)));
    }

    const endTime = timeDeltas.reduce((total, delta) => total + delta, 0);
    return {
      profile: {
        nodes,
        startTime: 0,
        endTime,
        samples: profileSamples,
        timeDeltas,
      },
    };
  }

  findScriptIdForUrl(url) {
    for (const script of this.scriptCache.values()) {
      if (script.url === url) {
        return script.scriptId;
      }
    }
    for (const script of this.scriptCache.values()) {
      if (script.matchUrls?.includes(url)) {
        return script.scriptId;
      }
    }
    return "0";
  }

  #pathKey(path) {
    return Array.isArray(path) ? path.join("/") : "";
  }

  #findNodeIdByPath(path) {
    return this.lastSnapshot?.pathToNodeId?.get(this.#pathKey(path)) || 0;
  }

  #emptyCssStyle(styleSheetId) {
    return {
      styleSheetId,
      cssProperties: [],
      shorthandEntries: [],
      cssText: "",
      range: {
        startLine: 0,
        startColumn: 0,
        endLine: 0,
        endColumn: 0,
      },
    };
  }

  #normalizeCssStyle(style, styleSheetId) {
    if (!style) {
      return this.#emptyCssStyle(styleSheetId);
    }
    return {
      styleSheetId: style.styleSheetId || styleSheetId,
      cssProperties: Array.isArray(style.cssProperties) ? style.cssProperties : [],
      shorthandEntries: Array.isArray(style.shorthandEntries) ? style.shorthandEntries : [],
      cssText: style.cssText || "",
      range: style.range || {
        startLine: 0,
        startColumn: 0,
        endLine: 0,
        endColumn: 0,
      },
    };
  }

  #normalizeAnimatedStylesPayload(payload, nodeId) {
    const styleSheetId = `animation:${nodeId}`;
    const inherited = Array.isArray(payload?.inherited)
      ? payload.inherited.map((entry, index) => ({
          animationStyles: Array.isArray(entry.animationStyles)
            ? entry.animationStyles.map((styleEntry) => ({
                name: styleEntry.name || "animation",
                style: this.#normalizeCssStyle(
                  styleEntry.style,
                  `${styleSheetId}:inherited:${index}`,
                ),
              }))
            : [],
          transitionsStyle: this.#normalizeCssStyle(
            entry.transitionsStyle,
            `${styleSheetId}:inherited:${index}`,
          ),
        }))
      : [];

    return {
      animationStyles: Array.isArray(payload?.animationStyles)
        ? payload.animationStyles.map((styleEntry, index) => ({
            name: styleEntry.name || `animation-${index + 1}`,
            style: this.#normalizeCssStyle(
              styleEntry.style,
              `${styleSheetId}:${styleEntry.name || index}`,
            ),
          }))
        : [],
      transitionsStyle: this.#normalizeCssStyle(payload?.transitionsStyle, styleSheetId),
      inherited,
    };
  }

  toAnimationPayload(snapshot) {
    if (!snapshot) {
      return null;
    }
    return {
      id: snapshot.id,
      name: snapshot.name || "animation",
      pausedState: !!snapshot.pausedState,
      playState: snapshot.playState || "idle",
      playbackRate: Number(snapshot.playbackRate || 1),
      startTime: Number(snapshot.startTime || 0),
      currentTime: Number(snapshot.currentTime || 0),
      type: snapshot.type || "WebAnimation",
      source: {
        delay: Number(snapshot.source?.delay || 0),
        endDelay: Number(snapshot.source?.endDelay || 0),
        iterationStart: Number(snapshot.source?.iterationStart || 0),
        ...(snapshot.source?.iterations === null
          ? {}
          : { iterations: Number(snapshot.source?.iterations || 0) }),
        duration: Number(snapshot.source?.duration || 0),
        direction: snapshot.source?.direction || "normal",
        fill: snapshot.source?.fill || "none",
        backendNodeId: this.#findNodeIdByPath(snapshot.source?.targetPath),
        keyframesRule: {
          name: snapshot.source?.keyframesRule?.name || snapshot.name || "animation",
          keyframes: Array.isArray(snapshot.source?.keyframesRule?.keyframes)
            ? snapshot.source.keyframesRule.keyframes.map((keyframe) => ({
                offset: keyframe.offset || "0%",
                easing: keyframe.easing || "linear",
              }))
            : [],
        },
        easing: snapshot.source?.easing || "linear",
      },
      cssId: snapshot.cssId || snapshot.id,
    };
  }

  #toRemoteObject(value) {
    if (value === null) {
      return { type: "object", subtype: "null", value: null, description: "null" };
    }
    const type = typeof value;
    if (type === "object") {
      return {
        type: "object",
        value,
        description: Array.isArray(value) ? "Array" : "Object",
      };
    }
    return {
      type,
      value,
      description: String(value),
    };
  }
}

class DesktopSafariServer {
  constructor(logger) {
    this.logger = logger.scope("desktop");
    this.backend = new DesktopSafariBackend(this.logger);
    this.app = express();
    this.httpServer = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.clients = new Set();
    this.pollTimer = null;
    this.tracingActive = false;
    this.traceBuffer = [];
    this.debuggerEnabled = false;
    this.lastPauseEvent = null;
    this.animationDomainEnabled = false;
    this.desiredStartUrl = desktopStartUrl;
    this.restartPromise = null;
    this.isStopping = false;
  }

  async start() {
    await this.backend.start();
    this.#setupRoutes();
    this.#setupWs();
    this.#startPolling();
    await new Promise((resolve, reject) => {
      this.httpServer.listen(port, host, () => resolve());
      this.httpServer.on("error", reject);
    });
    if (this.desiredStartUrl) {
      await this.#safeNavigate(this.desiredStartUrl, "startup");
    }
    this.logger.info(`desktop safari bridge listening on http://${host}:${port}`);
  }

  async stop() {
    this.isStopping = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    await this.backend.stop();
    await new Promise((resolve) => this.wss.close(() => resolve()));
    await new Promise((resolve) => this.httpServer.close(() => resolve()));
  }

  #setupRoutes() {
    this.app.use(fixtureMountPath, express.static(fixturesDir));

    this.app.get("/json/version", (_req, res) => {
      res.json({
        Browser: "Safari/26.4",
        "Protocol-Version": "1.3",
        "User-Agent": "Safari Desktop Bridge",
        "V8-Version": "0.0",
        "WebKit-Version": "Safari 26.4",
      });
    });

    this.app.get("/json/list", async (_req, res) => {
      if (this.isStopping || !this.backend.driver) {
        res.json(
          this.backend.lastSnapshot?.url
            ? [
                {
                  id: targetId,
                  title: this.backend.lastSnapshot.title || "Desktop Safari",
                  type: "page",
                  url: this.backend.lastSnapshot.url,
                  devtoolsFrontendUrl: `${frontendUrl}?ws=${host}:${port}/devtools/page/${targetId}`,
                  webSocketDebuggerUrl: `ws://${host}:${port}/devtools/page/${targetId}`,
                },
              ]
            : [],
        );
        return;
      }
      if (this.backend.lastSnapshot?.url) {
        res.json([
          {
            id: targetId,
            title: this.backend.lastSnapshot.title || "Desktop Safari",
            type: "page",
            url: this.backend.lastSnapshot.url,
            devtoolsFrontendUrl: `${frontendUrl}?ws=${host}:${port}/devtools/page/${targetId}`,
            webSocketDebuggerUrl: `ws://${host}:${port}/devtools/page/${targetId}`,
          },
        ]);
        return;
      }
      try {
        const snapshot = await this.backend.refreshSnapshot();
        res.json([
          {
            id: targetId,
            title: snapshot.title || "Desktop Safari",
            type: "page",
            url: snapshot.url,
            devtoolsFrontendUrl: `${frontendUrl}?ws=${host}:${port}/devtools/page/${targetId}`,
            webSocketDebuggerUrl: `ws://${host}:${port}/devtools/page/${targetId}`,
          },
        ]);
      } catch (error) {
        this.logger.error("json/list snapshot failed", error);
        if (!this.isStopping && this.#isRecoverableSessionError(error)) {
          try {
            await this.#restartBackendSession("json/list");
            const snapshot = await this.backend.refreshSnapshot();
            res.json([
              {
                id: targetId,
                title: snapshot.title || "Desktop Safari",
                type: "page",
                url: snapshot.url,
                devtoolsFrontendUrl: `${frontendUrl}?ws=${host}:${port}/devtools/page/${targetId}`,
                webSocketDebuggerUrl: `ws://${host}:${port}/devtools/page/${targetId}`,
              },
            ]);
            return;
          } catch (restartError) {
            this.logger.error("json/list session restart failed", restartError);
          }
        }
        if (this.backend.lastSnapshot?.url) {
          res.json([
            {
              id: targetId,
              title: this.backend.lastSnapshot.title || "Desktop Safari",
              type: "page",
              url: this.backend.lastSnapshot.url,
              devtoolsFrontendUrl: `${frontendUrl}?ws=${host}:${port}/devtools/page/${targetId}`,
              webSocketDebuggerUrl: `ws://${host}:${port}/devtools/page/${targetId}`,
            },
          ]);
          return;
        }
        res.json([]);
      }
    });

    this.app.get("/json", async (_req, res) => {
      res.redirect("/json/list");
    });

    this.app.get("/__bridge/status", async (_req, res) => {
      res.json({
        connected: !!this.backend.driver,
        url: this.backend.lastSnapshot?.url || "",
        title: this.backend.lastSnapshot?.title || "",
        desiredStartUrl: this.desiredStartUrl,
      });
    });

    this.app.get("/__bridge/restart", async (_req, res) => {
      try {
        await this.#restartBackendSession("http helper");
        res.json({
          ok: true,
          url: this.backend.lastSnapshot?.url || "",
          title: this.backend.lastSnapshot?.title || "",
        });
      } catch (error) {
        res.status(500).json({
          ok: false,
          error: error?.message || String(error),
        });
      }
    });

    this.app.get("/__bridge/navigate", async (req, res) => {
      const url = String(req.query.url || "");
      if (!url) {
        res.status(400).json({ error: "Missing url query parameter." });
        return;
      }
      try {
        const result = await this.#safeNavigate(url, "http helper");
        res.json({
          ok: true,
          frameId: result.frameId,
          loaderId: result.loaderId,
          url: result.url,
        });
      } catch (error) {
        res.status(500).json({
          ok: false,
          error: error?.message || String(error),
        });
      }
    });
  }

  #setupWs() {
    this.wss.on("connection", (socket) => {
      this.clients.add(socket);
      socket.on("close", () => {
        this.clients.delete(socket);
      });
      socket.on("message", async (raw) => {
        try {
          const message = JSON.parse(raw.toString());
          this.logger.debug("cdp <-", message.method);
          const response = await this.#handleMessage(socket, message);
          if (response) {
            socket.send(JSON.stringify(response));
          }
        } catch (error) {
          this.logger.error("websocket message failed", error);
          if (this.#isRecoverableSessionError(error)) {
            await this.#restartBackendSession("websocket");
          }
        }
      });
    });
  }

  #startPolling() {
    this.pollTimer = setInterval(async () => {
      if (!this.clients.size) {
        return;
      }
      try {
        const events = await this.backend.drainNetworkEvents();
        for (const event of events) {
          this.#broadcastNetworkEvent(event);
        }
        const consoleEvents = await this.backend.drainConsoleEvents();
        for (const event of consoleEvents) {
          this.#broadcastConsoleEvent(event);
        }
        const perfEvents = await this.backend.drainPerformanceEvents();
        for (const event of perfEvents) {
          this.#handlePerformanceEvent(event);
        }
        const debuggerEvents = await this.backend.drainDebuggerEvents();
        for (const event of debuggerEvents) {
          this.#handleDebuggerEvent(event);
        }
        if (this.animationDomainEnabled) {
          const animationEvents = await this.backend.drainAnimationEvents();
          for (const event of animationEvents) {
            this.#handleAnimationEvent(event);
          }
        }
      } catch (error) {
        this.logger.error("network polling failed", error);
        if (!this.isStopping && this.#isRecoverableSessionError(error)) {
          await this.#restartBackendSession("polling");
        }
      }
    }, 500);
  }

  #broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.readyState === 1) {
        client.send(data);
      }
    }
  }

  #broadcastPageLifecycle() {
    const url = this.backend.lastSnapshot?.url || "";
    const origin = url ? new URL(url).origin : "";
    const timestamp = Date.now() / 1000;
    this.#broadcast({
      method: "Page.frameNavigated",
      params: {
        frame: {
          id: "root",
          loaderId: `loader-${Date.now()}`,
          url,
          domainAndRegistry: "",
          securityOrigin: origin,
          mimeType: "text/html",
        },
        type: "Navigation",
      },
    });
    this.#broadcast({
      method: "Page.domContentEventFired",
      params: {
        timestamp,
      },
    });
    this.#broadcast({
      method: "Page.loadEventFired",
      params: {
        timestamp,
      },
    });
  }

  async #broadcastScripts() {
    if (!this.debuggerEnabled) {
      return;
    }
    const scripts = await this.backend.getScripts();
    for (const script of scripts) {
      this.#broadcast({
        method: "Debugger.scriptParsed",
        params: {
          scriptId: script.scriptId,
          url: script.url,
          startLine: script.startLine,
          startColumn: script.startColumn,
          endLine: script.endLine,
          endColumn: script.endColumn,
          executionContextId: script.executionContextId,
          hash: script.hash,
          isLiveEdit: false,
          sourceMapURL: script.sourceMapURL || undefined,
          hasSourceURL: script.hasSourceURL,
          isModule: script.isModule,
          length: script.source.length,
          scriptLanguage: "JavaScript",
          embedderName: script.url,
        },
      });
    }
  }

  #broadcastNetworkEvent(event) {
    const type = event.resourceType || "Fetch";
    if (event.kind === "request") {
      this.#broadcast({
        method: "Network.requestWillBeSent",
        params: {
          requestId: event.requestId,
          loaderId: "root",
          documentURL: this.backend.lastSnapshot?.url || event.url,
          request: {
            url: event.url,
            method: event.method,
            headers: event.headers || {},
            postData: event.postData || undefined,
            mixedContentType: "none",
            initialPriority: "High",
            referrerPolicy: "strict-origin-when-cross-origin",
          },
          timestamp: event.monotonicTime,
          wallTime: event.timestamp / 1000,
          initiator: {
            type: event.initiatorType || "other",
          },
          redirectHasExtraInfo: false,
          type,
          frameId: "root",
          hasUserGesture: false,
        },
      });
      return;
    }

    if (event.kind === "response") {
      const secure = event.url.startsWith("https:");
      this.#broadcast({
        method: "Network.responseReceived",
        params: {
          requestId: event.requestId,
          loaderId: "root",
          timestamp: event.monotonicTime,
          type,
          response: {
            url: event.url,
            status: event.status,
            statusText: event.statusText,
            headers: event.headers || {},
            mimeType: event.mimeType || "",
            charset: "",
            connectionReused: false,
            connectionId: 0,
            encodedDataLength: event.encodedDataLength || 0,
            securityState: secure ? "secure" : "insecure",
            protocol: secure ? "h2" : "http/1.1",
            fromDiskCache: false,
            fromServiceWorker: false,
            fromPrefetchCache: false,
            responseTime: event.timestamp,
          },
          hasExtraInfo: false,
          frameId: "root",
        },
      });
      return;
    }

    if (event.kind === "finished") {
      this.#broadcast({
        method: "Network.loadingFinished",
        params: {
          requestId: event.requestId,
          timestamp: event.monotonicTime,
          encodedDataLength: event.encodedDataLength || 0,
        },
      });
      return;
    }

    if (event.kind === "failed") {
      this.#broadcast({
        method: "Network.loadingFailed",
        params: {
          requestId: event.requestId,
          timestamp: event.monotonicTime,
          type: "Fetch",
          errorText: event.errorText || "Request failed",
          canceled: !!event.canceled,
        },
      });
    }
  }

  #broadcastConsoleEvent(event) {
    if (event.kind === "console-api") {
      this.#broadcast({
        method: "Runtime.consoleAPICalled",
        params: {
          type: event.level === "warn" ? "warning" : event.level,
          args: event.args || [],
          executionContextId: 1,
          timestamp: event.timestamp,
          stackTrace: {
            callFrames: event.stackTrace || [],
          },
          context: "default",
        },
      });
      this.#broadcast({
        method: "Log.entryAdded",
        params: {
          entry: {
            source: "javascript",
            level: event.level === "warn" ? "warning" : event.level,
            text: event.text || "",
            timestamp: event.timestamp,
            url: this.backend.lastSnapshot?.url || "",
          },
        },
      });
      return;
    }

    if (event.kind === "exception") {
      this.#broadcast({
        method: "Runtime.exceptionThrown",
        params: {
          timestamp: event.timestamp,
          exceptionDetails: {
            exceptionId: event.timestamp,
            text: event.text || "Uncaught",
            lineNumber: event.lineNumber || 0,
            columnNumber: event.columnNumber || 0,
            url: event.url || this.backend.lastSnapshot?.url || "",
            stackTrace: {
              callFrames: [],
            },
            exception: {
              type: "object",
              subtype: "error",
              className: "Error",
              description: event.stack || event.text || "Error",
            },
          },
        },
      });
      this.#broadcast({
        method: "Log.entryAdded",
        params: {
          entry: {
            source: "javascript",
            level: "error",
            text: event.text || "Uncaught",
            timestamp: event.timestamp,
            url: event.url || this.backend.lastSnapshot?.url || "",
            lineNumber: event.lineNumber || 0,
          },
        },
      });
    }
  }

  #handlePerformanceEvent(event) {
    if (!this.tracingActive) {
      return;
    }
    const traceEvent = this.#toTraceEvent(event);
    if (traceEvent) {
      this.traceBuffer.push(traceEvent);
      this.#broadcast({
        method: "Tracing.dataCollected",
        params: {
          value: [traceEvent],
        },
      });
    }
  }

  #toTraceEvent(event) {
    const ts = Math.round((event.startTime || 0) * 1000);
    const dur = Math.round((event.duration || 0) * 1000);
    const categoryMap = {
      navigation: "loading",
      resource: "loading,network",
      mark: "blink.user_timing",
      measure: "blink.user_timing",
      paint: "devtools.timeline",
      longtask: "toplevel",
    };
    const phase = dur > 0 ? "X" : "i";
    return {
      pid: 1,
      tid: 1,
      ts,
      ph: phase,
      cat: categoryMap[event.entryType] || "devtools.timeline",
      name: event.name || event.entryType,
      dur: dur > 0 ? dur : undefined,
      s: phase === "i" ? "t" : undefined,
      args: {
        data: event,
      },
    };
  }

  #handleDebuggerEvent(event) {
    if (event.kind !== "paused") {
      return;
    }
    this.lastPauseEvent = event;
    this.#broadcast({
      method: "Debugger.paused",
      params: {
        callFrames: this.#toDebuggerCallFrames(event.meta),
        reason: event.reason || "other",
        hitBreakpoints: event.hitBreakpoints || [],
      },
    });
  }

  #handleAnimationEvent(event) {
    if (event.kind === "created") {
      this.#broadcast({
        method: "Animation.animationCreated",
        params: {
          id: event.id,
        },
      });
      return;
    }

    if (event.kind === "canceled") {
      this.#broadcast({
        method: "Animation.animationCanceled",
        params: {
          id: event.id,
        },
      });
      return;
    }

    if (event.kind === "started" || event.kind === "updated") {
      const animation = this.backend.toAnimationPayload(event.animation);
      if (!animation) {
        return;
      }
      this.#broadcast({
        method:
          event.kind === "started"
            ? "Animation.animationStarted"
            : "Animation.animationUpdated",
        params: {
          animation,
        },
      });
    }
  }

  #toDebuggerCallFrames(meta = {}) {
    const frames = meta.stackFrames?.length ? meta.stackFrames : [meta];
    return frames.map((frame, index) => {
      const uiLocation = this.backend.mapToUiLocation(
        frame.url || "",
        Number(frame.lineNumber || 0),
        Number(frame.columnNumber || 0),
      );
      return {
        callFrameId: `pause:${Date.now()}:${index}`,
        functionName: frame.functionName || frame.label || "(anonymous)",
        location: {
          scriptId: uiLocation.scriptId || this.backend.findScriptIdForUrl(frame.url || ""),
          lineNumber: uiLocation.lineNumber,
          columnNumber: uiLocation.columnNumber,
        },
        url: uiLocation.url || frame.url || "",
        scopeChain: [],
        this: {
          type: "object",
          description: "Window",
          className: "Window",
        },
      };
    });
  }

  async #handleMessage(socket, message) {
    const { id, method, params = {} } = message;
    switch (method) {
      case "Browser.getVersion":
        return {
          id,
          result: {
            product: "Safari/26.4",
            revision: "desktop",
            userAgent: "Safari Desktop Bridge",
            jsVersion: "0.0",
            protocolVersion: "1.3",
          },
        };
      case "Schema.getDomains":
        return { id, result: { domains: [] } };
      case "Target.setDiscoverTargets":
      case "Target.setAutoAttach":
      case "Page.enable":
        this.#broadcastPageLifecycle();
        return { id, result: {} };
      case "Performance.enable":
      case "Performance.disable":
        return { id, result: {} };
      case "Network.enable":
      case "Network.setAttachDebugStack":
      case "Network.disable":
      case "Runtime.enable":
      case "Runtime.runIfWaitingForDebugger":
      case "Runtime.addBinding":
      case "DOM.enable":
      case "DOM.setInspectedNode":
      case "CSS.enable":
      case "CSS.trackComputedStyleUpdates":
      case "CSS.takeComputedStyleUpdates":
      case "CSS.trackComputedStyleUpdatesForNode":
      case "Overlay.enable":
      case "Overlay.setShowViewportSizeOnResize":
      case "Overlay.setShowGridOverlays":
      case "Overlay.setShowFlexOverlays":
      case "Overlay.setShowScrollSnapOverlays":
      case "Overlay.setShowContainerQueryOverlays":
      case "Overlay.setShowIsolatedElements":
      case "Log.enable":
      case "Log.startViolationsReport":
      case "Accessibility.enable":
      case "Autofill.enable":
      case "Autofill.setAddresses":
      case "Profiler.enable":
      case "Emulation.setEmulatedMedia":
      case "Emulation.setEmulatedVisionDeficiency":
      case "Emulation.setFocusEmulationEnabled":
      case "Audits.enable":
      case "ServiceWorker.enable":
      case "Inspector.enable":
      case "Target.setRemoteLocations":
      case "Network.setBlockedURLs":
      case "Network.emulateNetworkConditionsByRule":
      case "Network.overrideNetworkState":
      case "Network.clearAcceptedEncodingsOverride":
        return { id, result: {} };
      case "Debugger.setPauseOnExceptions":
        await this.backend.setPauseOnExceptions(params.state);
        return { id, result: {} };
      case "Animation.enable": {
        this.animationDomainEnabled = true;
        await this.backend.setAnimationEnabled(true);
        const animationEvents = await this.backend.drainAnimationEvents();
        for (const event of animationEvents) {
          this.#handleAnimationEvent(event);
        }
        return { id, result: {} };
      }
      case "Animation.disable":
        this.animationDomainEnabled = false;
        await this.backend.setAnimationEnabled(false);
        return { id, result: {} };
      case "Animation.getCurrentTime":
        return {
          id,
          result: {
            currentTime: await this.backend.getAnimationCurrentTime(params.id),
          },
        };
      case "Animation.getPlaybackRate":
        return {
          id,
          result: {
            playbackRate: await this.backend.getAnimationPlaybackRate(),
          },
        };
      case "Animation.releaseAnimations":
        await this.backend.releaseAnimations(params.animations || []);
        return { id, result: {} };
      case "Animation.resolveAnimation": {
        const remoteObject = await this.backend.resolveAnimation(params.animationId);
        return {
          id,
          result: {
            remoteObject: remoteObject || {
              type: "object",
              className: "Animation",
              description: `Animation ${params.animationId || ""}`.trim(),
            },
          },
        };
      }
      case "Animation.seekAnimations":
        await this.backend.seekAnimations(params.animations || [], params.currentTime || 0);
        return { id, result: {} };
      case "Animation.setPaused":
        await this.backend.setAnimationsPaused(params.animations || [], !!params.paused);
        return { id, result: {} };
      case "Animation.setPlaybackRate":
        await this.backend.setAnimationPlaybackRate(Number(params.playbackRate));
        return { id, result: {} };
      case "Animation.setTiming":
        await this.backend.setAnimationTiming(
          params.animationId,
          params.duration || 0,
          params.delay || 0,
        );
        return { id, result: {} };
      case "Debugger.setBreakpointsActive":
        await this.backend.setBreakpointsActive(params.active);
        return { id, result: {} };
      case "Debugger.setAsyncCallStackDepth":
      case "Debugger.setBlackboxPatterns":
      case "DOMDebugger.setBreakOnCSPViolation":
      case "Page.setAdBlockingEnabled":
      case "Page.startScreencast":
      case "Page.addScriptToEvaluateOnNewDocument":
        return { id, result: {} };
      case "Debugger.enable":
        this.debuggerEnabled = true;
        await this.backend.refreshScripts();
        await this.#broadcastScripts();
        return { id, result: { debuggerId: "desktop-debugger" } };
      case "Debugger.pause":
        await this.backend.pause();
        return { id, result: {} };
      case "Debugger.resume":
        await this.backend.resume("resume", this.lastPauseEvent?.pauseId || null);
        this.lastPauseEvent = null;
        return { id, result: {} };
      case "Debugger.stepInto":
      case "Debugger.stepOver":
      case "Debugger.stepOut":
        await this.backend.resume("step", this.lastPauseEvent?.pauseId || null);
        this.lastPauseEvent = null;
        return { id, result: {} };
      case "Debugger.removeBreakpoint":
        await this.backend.removeBreakpoint(params.breakpointId);
        return { id, result: {} };
      case "Debugger.setBreakpointByUrl":
        return {
          id,
          result: await this.backend.setBreakpointByUrl(params),
        };
      case "Debugger.getScriptSource":
        return {
          id,
          result: {
            scriptSource: await this.backend.getScriptSource(params.scriptId),
          },
        };
      case "Tracing.start":
        this.tracingActive = true;
        this.traceBuffer = [];
        return { id, result: {} };
      case "Tracing.end":
        this.tracingActive = false;
        this.#broadcast({
          method: "Tracing.tracingComplete",
          params: {
            dataLossOccurred: false,
            stream: "",
            traceFormat: "json",
          },
        });
        return { id, result: {} };
      case "Tracing.getCategories":
        return {
          id,
          result: {
            categories: [
              "loading",
              "network",
              "blink.user_timing",
              "devtools.timeline",
              "toplevel",
            ],
          },
        };
      case "Profiler.start":
        await this.backend.startProfiler();
        return { id, result: {} };
      case "Profiler.stop":
        return {
          id,
          result: await this.backend.stopProfiler(),
        };
      case "Target.getTargets":
        return {
          id,
          result: {
            targetInfos: [
              {
                targetId,
                type: "page",
                title: (await this.backend.refreshSnapshot()).title || "Desktop Safari",
                url: this.backend.lastSnapshot.url,
                attached: true,
                canAccessOpener: false,
                browserContextId: "default",
              },
            ],
          },
        };
      case "Page.getResourceTree":
        await this.backend.refreshScripts();
        return {
          id,
          result: {
            frameTree: {
              frame: {
                id: "root",
                loaderId: "root",
                url: this.backend.lastSnapshot.url,
                domainAndRegistry: "",
                securityOrigin: new URL(this.backend.lastSnapshot.url).origin,
                mimeType: "text/html",
              },
              resources: (await this.backend.getScripts()).map((script) => ({
                url: script.url,
                type: "Script",
                mimeType: script.type,
                lastModified: undefined,
                contentSize: script.source.length,
                failed: false,
                canceled: false,
              })),
            },
          },
        };
      case "Page.getResourceContent": {
        const resource = await this.backend.getResource(params.url);
        return {
          id,
          result: {
            content: resource.content,
            base64Encoded: resource.base64Encoded,
          },
        };
      }
      case "Page.getNavigationHistory":
        return {
          id,
          result: {
            currentIndex: 0,
            entries: [
              {
                id: 0,
                url: this.backend.lastSnapshot.url,
                userTypedURL: this.backend.lastSnapshot.url,
                title: this.backend.lastSnapshot.title,
                transitionType: "typed",
              },
            ],
          },
        };
      case "Page.navigate": {
        const result = await this.#safeNavigate(params.url, "cdp");
        return { id, result };
      }
      case "Performance.getMetrics":
        return {
          id,
          result: {
            metrics: await this.backend.getPerformanceMetrics(),
          },
        };
      case "Page.getLayoutMetrics":
        return {
          id,
          result: {
            layoutViewport: {
              pageX: 0,
              pageY: 0,
              clientWidth: 1280,
              clientHeight: 720,
            },
            visualViewport: {
              offsetX: 0,
              offsetY: 0,
              pageX: 0,
              pageY: 0,
              clientWidth: 1280,
              clientHeight: 720,
              scale: 1,
              zoom: 1,
            },
            contentSize: {
              x: 0,
              y: 0,
              width: 1280,
              height: 720,
            },
            cssLayoutViewport: {
              pageX: 0,
              pageY: 0,
              clientWidth: 1280,
              clientHeight: 720,
            },
            cssVisualViewport: {
              offsetX: 0,
              offsetY: 0,
              pageX: 0,
              pageY: 0,
              clientWidth: 1280,
              clientHeight: 720,
              scale: 1,
              zoom: 1,
            },
            cssContentSize: {
              x: 0,
              y: 0,
              width: 1280,
              height: 720,
            },
          },
        };
      case "Network.getResponseBody":
        return { id, result: this.backend.getResponseBody(params.requestId) };
      case "Debugger.getPossibleBreakpoints":
        return {
          id,
          result: {
            locations: await this.backend.getPossibleBreakpoints(),
          },
        };
      case "Runtime.evaluate":
        return { id, result: { result: await this.backend.evaluate(params.expression) } };
      case "Runtime.callFunctionOn":
        return {
          id,
          result: {
            result: {
              type: "undefined",
            },
          },
        };
      case "DOM.getDocument":
        return {
          id,
          result: { root: await this.backend.getDocument() },
        };
      case "DOM.requestChildNodes": {
        const nodes = await this.backend.requestChildNodes(params.nodeId);
        socket.send(
          JSON.stringify({
            method: "DOM.setChildNodes",
            params: {
              parentId: params.nodeId,
              nodes,
            },
          }),
        );
        return { id, result: {} };
      }
      case "DOM.describeNode":
        return { id, result: { node: await this.backend.describeNode(params.nodeId) } };
      case "DOM.pushNodesByBackendIdsToFrontend":
        return {
          id,
          result: {
            nodeIds: (params.backendNodeIds || []).map((backendNodeId) => backendNodeId),
          },
        };
      case "DOM.resolveNode": {
        const node = await this.backend.getNode(params.nodeId);
        return {
          id,
          result: {
            object: {
              type: "object",
              subtype: "node",
              className: node?.nodeName || "Node",
              description: node?.nodeName || "Node",
              objectId: `node:${params.nodeId}`,
            },
          },
        };
      }
      case "DOM.getOuterHTML":
        return { id, result: { outerHTML: await this.backend.getOuterHTML(params.nodeId) } };
      case "DOM.getBoxModel":
        return { id, result: await this.backend.getBoxModel(params.nodeId) || {} };
      case "CSS.getComputedStyleForNode":
        return {
          id,
          result: { computedStyle: await this.backend.getComputedStyle(params.nodeId) },
        };
      case "CSS.getMatchedStylesForNode":
        return {
          id,
          result: {
            inlineStyle: {
              styleSheetId: "inline",
              cssProperties: [],
              shorthandEntries: [],
            },
            attributesStyle: {
              styleSheetId: "attributes",
              cssProperties: [],
              shorthandEntries: [],
            },
            matchedCSSRules: [],
            inherited: [],
            pseudoElements: [],
            cssKeyframesRules: [],
            cssPositionFallbackRules: [],
            parentLayoutNodeId: params.nodeId,
          },
        };
      case "CSS.getAnimatedStylesForNode":
        return {
          id,
          result: await this.backend.getAnimatedStyles(params.nodeId),
        };
      case "CSS.getPlatformFontsForNode":
        return { id, result: { fonts: [] } };
      case "CSS.getEnvironmentVariables":
        return { id, result: { variables: [] } };
      case "CSS.getInlineStylesForNode":
        return {
          id,
          result: {
            inlineStyle: {
              styleSheetId: "inline",
              cssProperties: [],
              shorthandEntries: [],
            },
            attributesStyle: {
              styleSheetId: "attributes",
              cssProperties: [],
              shorthandEntries: [],
            },
          },
        };
      case "Storage.getStorageKey":
        return {
          id,
          result: {
            storageKey: new URL(this.backend.lastSnapshot.url).origin,
          },
        };
      case "Runtime.releaseObject":
        return { id, result: {} };
      case "Overlay.highlightNode":
      case "Overlay.hideHighlight":
        return { id, result: {} };
      default:
        this.logger.debug(`unhandled cdp method ${method}`);
        return {
          id,
          error: {
            code: -32601,
            message: `Method not implemented: ${method}`,
          },
        };
    }
  }

  async #safeNavigate(url, source = "navigate") {
    if (this.isStopping) {
      throw new Error("Desktop bridge is stopping.");
    }
    this.logger.info(`${source} navigate`, url);
    let result;
    try {
      result = await this.backend.navigate(url);
    } catch (error) {
      if (!this.#isRecoverableSessionError(error)) {
        throw error;
      }
      await this.#restartBackendSession(`${source} navigate`);
      result = await this.backend.navigate(url);
    }
    this.#broadcastPageLifecycle();
    await this.#broadcastScripts();
    if (this.animationDomainEnabled) {
      const animationEvents = await this.backend.drainAnimationEvents();
      for (const event of animationEvents) {
        this.#handleAnimationEvent(event);
      }
    }
    return result;
  }

  #isRecoverableSessionError(error) {
    const message = error?.message || String(error);
    return (
      message.includes("NoSuchSessionError") ||
      message.includes("invalid session id") ||
      message.includes("Session does not exist") ||
      message.includes("no such session")
    );
  }

  async #restartBackendSession(reason) {
    if (this.isStopping) {
      return;
    }
    if (this.restartPromise) {
      return await this.restartPromise;
    }
    this.restartPromise = (async () => {
      const resumeUrl =
        this.desiredStartUrl ||
        this.backend.lastSnapshot?.url ||
        `http://${host}:${port}${fixtureMountPath}/animation.html`;
      this.logger.warn(`restarting desktop backend after ${reason}`);
      await this.backend.stop().catch(() => {});
      await this.backend.start();
      if (this.animationDomainEnabled) {
        await this.backend.setAnimationEnabled(true);
      }
      if (resumeUrl) {
        await this.backend.navigate(resumeUrl);
      }
      this.#broadcastPageLifecycle();
      await this.#broadcastScripts();
      if (this.animationDomainEnabled) {
        const animationEvents = await this.backend.drainAnimationEvents();
        for (const event of animationEvents) {
          this.#handleAnimationEvent(event);
        }
      }
    })();
    try {
      await this.restartPromise;
    } finally {
      this.restartPromise = null;
    }
  }
}

export async function main() {
  const logger = new Logger();
  const server = new DesktopSafariServer(logger);
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`shutting down on ${signal}`);
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    const preflight = await runDesktopPreflight({ bridgePort: port });
    if (preflight.safariVersion) {
      logger.info(`Safari ${preflight.safariVersion} detected`);
    }
    if (preflight.chromeVersion) {
      logger.info(`Chrome ${preflight.chromeVersion} detected`);
    } else {
      logger.warn("Google Chrome was not detected in /Applications");
    }
    const compatibility = assessDesktopCompatibility(preflight);
    if (compatibility.status === "verified") {
      logger.info(compatibility.summary);
    } else {
      logger.warn(compatibility.summary);
      logger.warn(compatibility.notes);
    }
    await server.start();
    logger.info(
      `Open Chrome DevTools with ${frontendUrl}?ws=${host}:${port}/devtools/page/${targetId}`,
    );
    logger.info(
      `Bridge fixture gallery: http://${host}:${port}${fixtureMountPath}/animation.html`,
    );
    logger.info(
      `Bridge navigate helper: http://${host}:${port}/__bridge/navigate?url=${encodeURIComponent(`http://${host}:${port}${fixtureMountPath}/animation.html`)}`,
    );
  } catch (error) {
    logger.error(error?.message || String(error));
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
