import fs from "fs";
import path from "path";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import config from "./config.js";

const logsDir = path.resolve(process.cwd(), "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const commonFormat = winston.format.combine(
  winston.format.timestamp({ format: () => new Date().toISOString() }),
  winston.format.errors({ stack: true })
);

const fileJsonFormat = winston.format.combine(
  commonFormat,
  winston.format((info) => {
    const { timestamp, level, message, module, requestId, externalStatusCode, stack, ...rest } = info;
    const normalized = {
      timestamp,
      level,
      message,
      requestId: requestId || "system",
      module: module || "app",
      externalStatusCode: externalStatusCode ?? null
    };

    if (rest.error instanceof Error) {
      normalized.errorMessage = rest.error.message;
      normalized.stack = stack || rest.error.stack;
      delete rest.error;
    } else if (stack) {
      normalized.stack = stack;
    }

    if (Object.keys(rest).length > 0) normalized.meta = rest;
    for (const key of Object.keys(info)) {
      delete info[key];
    }
    Object.assign(info, normalized);
    return info;
  })(),
  winston.format.json()
);

const transports = [
  new DailyRotateFile({
    filename: path.join(logsDir, "app-%DATE%.log"),
    datePattern: "YYYY-MM-DD",
    zippedArchive: true,
    maxFiles: "14d",
    level: config.logLevel
  })
];

if (config.nodeEnv === "development") {
  transports.push(
    new winston.transports.Console({
      level: config.logLevel,
      format: winston.format.combine(
        commonFormat,
        winston.format.colorize(),
        winston.format.printf((info) => {
          const reqId = info.requestId || "system";
          const mod = info.module || "app";
          const ext = info.externalStatusCode ? ` externalStatusCode=${info.externalStatusCode}` : "";
          const details = { ...info };
          delete details.timestamp;
          delete details.level;
          delete details.message;
          delete details.module;
          delete details.requestId;
          delete details.externalStatusCode;
          const meta = Object.keys(details).length ? ` ${JSON.stringify(details)}` : "";
          return `${info.timestamp} ${info.level} [${mod}] [${reqId}] ${info.message}${ext}${meta}`;
        })
      )
    })
  );
}

const rootLogger = winston.createLogger({
  level: config.logLevel,
  levels: winston.config.npm.levels,
  defaultMeta: {
    service: "foodics-shipday-webhook",
    env: config.nodeEnv,
    requestId: "system",
    module: "app"
  },
  transports,
  format: fileJsonFormat
});

export function getLogger(moduleName, context = {}) {
  return rootLogger.child({ module: moduleName, ...context });
}

export default rootLogger;
