import axios from "axios";
import config from "./config.js";
import { getLogger } from "./logger.js";

const logger = getLogger("shipdayClient");

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
    const scopedLogger = logger.child({ requestId: metadata.requestId || "system" });
    let attempt = 0;
    const maxAttempts = config.shipday.maxRetries + 1;

    while (attempt < maxAttempts) {
      attempt += 1;

      try {
        scopedLogger.info("Sending Shipday order request", {
          orderId: metadata.orderId,
          attempt,
          idempotencyKey: metadata.idempotencyKey || metadata.orderId || null,
          shipdayPayload: {
            orderNumber: orderPayload.orderNumber,
            expectedDeliveryDate: orderPayload.expectedDeliveryDate,
            expectedPickupTime: orderPayload.expectedPickupTime,
            expectedDeliveryTime: orderPayload.expectedDeliveryTime,
            pickupLatitude: orderPayload.pickupLatitude,
            pickupLongitude: orderPayload.pickupLongitude,
            deliveryLatitude: orderPayload.deliveryLatitude,
            deliveryLongitude: orderPayload.deliveryLongitude
          }
        });

        const response = await this.http.post("/orders", orderPayload, {
          headers: {
            "x-idempotency-key": metadata.idempotencyKey || metadata.orderId || undefined
          }
        });

        scopedLogger.info("Shipday order inserted successfully", {
          orderId: metadata.orderId,
          attempt,
          externalStatusCode: response.status,
          shipdaySuccess: response.data?.success,
          shipdayOrderId: response.data?.orderId ?? response.data?._id ?? null,
          shipdayResponse: response.data
        });

        return response.data;
      } catch (error) {
        const retriable = isRetriableError(error);
        const shouldRetry = retriable && attempt < maxAttempts;

        scopedLogger.warn("Shipday insert order call failed", {
          orderId: metadata.orderId,
          attempt,
          maxAttempts,
          retriable,
          externalStatusCode: error.response?.status,
          responseData: error.response?.data,
          error
        });

        if (!shouldRetry) {
          throw error;
        }

        const delay = Math.min(
          config.shipday.retryBaseDelayMs * 2 ** (attempt - 1),
          config.shipday.retryMaxDelayMs
        );

        scopedLogger.info("Retrying Shipday request with exponential backoff", {
          orderId: metadata.orderId,
          attempt,
          retryDelayMs: delay
        });

        await sleep(delay);
      }
    }

    throw new Error("Unexpected retry loop termination when calling Shipday");
  }
}

const shipdayClient = new ShipdayClient();

export default shipdayClient;
