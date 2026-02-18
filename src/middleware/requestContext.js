import { randomUUID } from "crypto";
import { getLogger } from "../logger.js";

export default function attachRequestContext(req, res, next) {
  const requestId = randomUUID();
  const startedAt = Date.now();

  req.requestId = requestId;
  req.log = getLogger("server", { requestId });

  res.on("finish", () => {
    req.log.info("HTTP request completed", {
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      responseTimeMs: Date.now() - startedAt
    });
  });

  next();
}
