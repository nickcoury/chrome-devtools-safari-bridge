import { Server } from "../package/dist/src/services/server.js";
import { Logger } from "./logger.js";

const deviceListPort = Number(process.env.DEVICE_LIST_PORT || 9221);
const deviceTargetPort = Number(process.env.DEVICE_TARGET_PORT || 9222);
const frontendUrl =
  process.env.FRONTEND_URL || "devtools://devtools/bundled/inspector.html";
const deviceId = process.env.DEVICE_ID || "";

const logger = new Logger();
const server = new Server(
  logger,
  frontendUrl,
  deviceId,
  deviceListPort,
  deviceTargetPort,
);

const shutdown = async (signal) => {
  logger.info(`shutting down on ${signal}`);
  await server.stop();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

logger.info(
  `starting bridge on device list :${deviceListPort} and target :${deviceTargetPort}`,
);
await server.run();
