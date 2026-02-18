import crypto from "crypto";
import config from "../config.js";

function safeCompare(a, b) {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");

  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function extractSignatureCandidates(rawSignatureHeader) {
  if (!rawSignatureHeader || typeof rawSignatureHeader !== "string") {
    return [];
  }

  return rawSignatureHeader
    .split(",")
    .map((part) => part.trim())
    .flatMap((part) => {
      const values = [part];
      const eqIndex = part.indexOf("=");

      if (eqIndex > -1 && eqIndex < part.length - 1) {
        values.push(part.slice(eqIndex + 1));
      }

      return values;
    })
    .map((value) => value.replace(/^sha256=/i, "").trim())
    .filter(Boolean);
}

export default function validateFoodicsWebhookSignature(req, res, next) {
  const signatureHeaderName = config.foodics.webhookSignatureHeader;
  const receivedSignature = req.headers[signatureHeaderName];

  if (!req.rawBody) {
    req.log?.warn("Webhook raw body is missing for signature validation");
    return res.status(400).json({ acknowledged: false, error: "Raw body is missing" });
  }

  if (!receivedSignature) {
    req.log?.warn(
      { header: signatureHeaderName },
      "Missing Foodics webhook signature header"
    );
    return res.status(401).json({ acknowledged: false, error: "Missing signature" });
  }

  const expectedHex = crypto
    .createHmac(config.foodics.webhookHashAlgorithm, config.foodics.webhookSecret)
    .update(req.rawBody)
    .digest("hex");

  const expectedBase64 = crypto
    .createHmac(config.foodics.webhookHashAlgorithm, config.foodics.webhookSecret)
    .update(req.rawBody)
    .digest("base64");

  const candidates = extractSignatureCandidates(receivedSignature);
  const isValid = candidates.some(
    (candidate) => safeCompare(candidate, expectedHex) || safeCompare(candidate, expectedBase64)
  );

  if (!isValid) {
    req.log?.warn("Foodics webhook signature validation failed");
    return res.status(401).json({ acknowledged: false, error: "Invalid signature" });
  }

  return next();
}
