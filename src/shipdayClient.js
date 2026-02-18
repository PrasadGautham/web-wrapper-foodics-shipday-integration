import axios from "axios";
import config from "./config.js";
import logger from "./logger.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableError(error) {
  if (!error.response) return true;
  const status = error.response.status;
  return status === 429 || status >= 500;
}

class ShipdayClient {
  constructor() {
    this.http = axios.create({
      baseURL: config.shipday.apiBaseUrl,
      timeout: config.shipday.timeoutMs,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Basic ${config.shipday.apiKey}`
      }
    });
  }

  async insertDeliveryOrder(orderPayload, metadata = {}) {
    let attempt = 0;
    const maxAttempts = config.shipday.maxRetries + 1;

    while (attempt < maxAttempts) {
      attempt += 1;

      try {
        const response = await this.http.post("/orders", orderPayload, {
          headers: {
            "x-idempotency-key": metadata.idempotencyKey || metadata.orderId || undefined
          }
        });

        logger.info(
          {
            orderId: metadata.orderId,
            attempt,
            status: response.status,
            shipdaySuccess: response.data?.success,
            shipdayOrderId: response.data?.orderId ?? response.data?._id ?? null,
            shipdayResponse: response.data
          },
          "Shipday order inserted successfully"
        );

        return response.data;
      } catch (error) {
        const retriable = isRetriableError(error);
        const shouldRetry = retriable && attempt < maxAttempts;

        logger.warn(
          {
            orderId: metadata.orderId,
            attempt,
            maxAttempts,
            retriable,
            status: error.response?.status,
            err: error.message,
            responseData: error.response?.data
          },
          "Shipday insert order call failed"
        );

        if (!shouldRetry) {
          throw error;
        }

        const delay = Math.min(
          config.shipday.retryBaseDelayMs * 2 ** (attempt - 1),
          config.shipday.retryMaxDelayMs
        );

        await sleep(delay);
      }
    }

    throw new Error("Unexpected retry loop termination when calling Shipday");
  }
}

const shipdayClient = new ShipdayClient();

export default shipdayClient;
