import pino from "pino";
import pinoHttp from "pino-http";
import config from "./config.js";

const logger = pino({
  level: config.logLevel,
  base: {
    service: "foodics-shipday-webhook",
    env: config.nodeEnv
  },
  timestamp: pino.stdTimeFunctions.isoTime
});

export const httpLogger = pinoHttp({
  logger,
  customLogLevel(req, res, err) {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(req, res) {
    return `Request completed: ${req.method} ${req.url} (${res.statusCode})`;
  },
  customErrorMessage(req, res, err) {
    return `Request failed: ${req.method} ${req.url} (${res.statusCode}) ${err.message}`;
  },
  serializers: {
    req(req) {
      return {
        id: req.id,
        method: req.method,
        url: req.url,
        remoteAddress: req.remoteAddress,
        userAgent: req.headers["user-agent"]
      };
    },
    res(res) {
      return {
        statusCode: res.statusCode
      };
    }
  }
});

export default logger;
