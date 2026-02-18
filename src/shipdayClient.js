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
    return this.withRetry("insert order", metadata, scopedLogger, async (attempt) => {
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
    });
  }

  async getOrderByOrderNumber(orderNumber, metadata = {}) {
    if (!orderNumber) {
      throw new Error("orderNumber is required to retrieve Shipday order details");
    }

    const scopedLogger = logger.child({ requestId: metadata.requestId || "system" });
    return this.withRetry("retrieve order details", metadata, scopedLogger, async (attempt) => {
      scopedLogger.info("Fetching Shipday order details by orderNumber", {
        orderId: metadata.orderId,
        orderNumber,
        attempt
      });

      const response = await this.http.get(`/orders/${encodeURIComponent(orderNumber)}`);
      const candidateOrders = this.extractCandidateOrders(response.data);
      const shipdayOrderId = candidateOrders[0]?.id || null;

      scopedLogger.info("Fetched Shipday order details", {
        orderId: metadata.orderId,
        orderNumber,
        attempt,
        externalStatusCode: response.status,
        shipdayOrderId,
        candidateOrderIds: candidateOrders.map((c) => c.id),
        candidateOrderStates: candidateOrders.map((c) => ({
          id: c.id,
          orderStatusAdmin: c.orderStatusAdmin,
          accepted: c.accepted,
          orderState: c.orderState
        }))
      });

      return {
        response: response.data,
        shipdayOrderId,
        candidateOrderIds: candidateOrders.map((c) => c.id),
        candidateOrders
      };
    });
  }

  async markOrderReadyToPickup(shipdayOrderId, metadata = {}) {
    if (!shipdayOrderId) {
      throw new Error("shipdayOrderId is required to mark order ready for pickup");
    }

    const scopedLogger = logger.child({ requestId: metadata.requestId || "system" });
    return this.withRetry("mark order ready for pickup", metadata, scopedLogger, async (attempt) => {
      scopedLogger.info("Sending Shipday ready-for-pickup update", {
        orderId: metadata.orderId,
        shipdayOrderId,
        attempt
      });

      const response = await this.http.put(`/orders/${shipdayOrderId}/meta`, {});

      scopedLogger.info("Shipday order moved to ready-for-pickup", {
        orderId: metadata.orderId,
        shipdayOrderId,
        attempt,
        externalStatusCode: response.status
      });

      return response.data;
    });
  }

  extractCandidateOrders(data) {
    if (!data) return [];

    const pickId = (item) => item?.orderId ?? item?._id ?? item?.id ?? null;

    if (Array.isArray(data)) {
      return data
        .map((item) => ({
          id: pickId(item),
          placementTime: item?.activityLog?.placementTime
            ? Date.parse(item.activityLog.placementTime)
            : Number.NaN,
          orderStatusAdmin: item?.orderStatusAdmin ?? null,
          accepted: item?.orderStatus?.accepted ?? null,
          orderState: item?.orderStatus?.orderState ?? null
        }))
        .filter((item) => item.id !== null)
        .sort((a, b) => {
          const aTs = Number.isFinite(a.placementTime) ? a.placementTime : 0;
          const bTs = Number.isFinite(b.placementTime) ? b.placementTime : 0;
          return bTs - aTs;
        });
    }

    if (typeof data === "object") {
      const nested = data.data || data.order || data.result || data;
      const nestedId = pickId(nested);
      return nestedId
        ? [
            {
              id: nestedId,
              placementTime: Number.NaN,
              orderStatusAdmin: nested?.orderStatusAdmin ?? null,
              accepted: nested?.orderStatus?.accepted ?? null,
              orderState: nested?.orderStatus?.orderState ?? null
            }
          ]
        : [];
    }

    return [];
  }

  async withRetry(operationName, metadata, scopedLogger, fn) {
    let attempt = 0;
    const maxAttempts = (metadata.maxAttempts && Number.isInteger(metadata.maxAttempts))
      ? metadata.maxAttempts
      : config.shipday.maxRetries + 1;

    while (attempt < maxAttempts) {
      attempt += 1;

      try {
        return await fn(attempt);
      } catch (error) {
        const retriable = isRetriableError(error);
        const shouldRetry = retriable && attempt < maxAttempts;

        scopedLogger.warn(`Shipday ${operationName} call failed`, {
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
          operation: operationName,
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
