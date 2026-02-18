import dotenv from "dotenv";

dotenv.config();

function asInt(value, defaultValue) {
  const num = Number.parseInt(value ?? "", 10);
  return Number.isFinite(num) ? num : defaultValue;
}

function asList(value, fallback) {
  if (!value) return fallback;
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

const config = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: asInt(process.env.PORT, 3000),
  logLevel: process.env.LOG_LEVEL || "info",

  foodics: {
    apiBaseUrl: process.env.FOODICS_API_BASE_URL || "https://api.foodics.com/v5",
    authBaseUrl: process.env.FOODICS_AUTH_BASE_URL || "https://api.foodics.com",
    clientId: process.env.FOODICS_CLIENT_ID,
    clientSecret: process.env.FOODICS_CLIENT_SECRET,
    redirectUri: process.env.FOODICS_REDIRECT_URI,
    authorizationCode: process.env.FOODICS_AUTHORIZATION_CODE,
    refreshToken: process.env.FOODICS_REFRESH_TOKEN,
    accessToken: process.env.FOODICS_ACCESS_TOKEN,
    accessTokenExpiresAt: process.env.FOODICS_ACCESS_TOKEN_EXPIRES_AT
      ? Date.parse(process.env.FOODICS_ACCESS_TOKEN_EXPIRES_AT)
      : null,
    webhookSecret: process.env.FOODICS_WEBHOOK_SECRET,
    webhookSignatureHeader: (process.env.FOODICS_WEBHOOK_SIGNATURE_HEADER || "x-foodics-signature").toLowerCase(),
    webhookHashAlgorithm: process.env.FOODICS_WEBHOOK_HASH_ALGO || "sha256"
  },

  shipday: {
    apiBaseUrl: process.env.SHIPDAY_API_BASE_URL || "https://api.shipday.com",
    apiKey: process.env.SHIPDAY_API_KEY,
    timeoutMs: asInt(process.env.SHIPDAY_TIMEOUT_MS, 15000),
    maxRetries: asInt(process.env.SHIPDAY_MAX_RETRIES, 4),
    retryBaseDelayMs: asInt(process.env.SHIPDAY_RETRY_BASE_DELAY_MS, 500),
    retryMaxDelayMs: asInt(process.env.SHIPDAY_RETRY_MAX_DELAY_MS, 10000)
  },

  forwardEvents: asList(process.env.FORWARD_EVENTS, [
    "order.created",
    "order.updated",
    "order.delivery.created",
    "order.delivery.updated"
  ])
};

function validateConfig() {
  const errors = [];

  if (!config.foodics.webhookSecret) {
    errors.push("FOODICS_WEBHOOK_SECRET is required.");
  }

  if (!config.shipday.apiKey) {
    errors.push("SHIPDAY_API_KEY is required.");
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n- ${errors.join("\n- ")}`);
  }
}

validateConfig();

export default config;
