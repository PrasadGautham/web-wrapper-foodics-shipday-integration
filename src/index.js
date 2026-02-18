import express from "express";
import bodyParser from "body-parser";

import config from "./config.js";
import { getLogger } from "./logger.js";
import foodicsClient from "./foodicsClient.js";
import shipdayClient from "./shipdayClient.js";
import validateFoodicsWebhookSignature from "./middleware/webhookValidator.js";
import attachRequestContext from "./middleware/requestContext.js";

const app = express();
const logger = getLogger("server");
const supportedEvents = new Set(config.forwardEvents);
const READY_EVENT_SUPPRESSION_WINDOW_MS = 5 * 60 * 1000;
const readyDispatchCache = new Map();

app.use(
  bodyParser.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    }
  })
);
app.use(attachRequestContext);

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post("/webhooks/foodics", validateFoodicsWebhookSignature, async (req, res) => {
  const event = req.body?.event;
  req.log.info("Incoming Foodics webhook event", {
    payload: sanitizeWebhookPayload(req.body)
  });

  if (!event) {
    req.log.warn("Webhook payload missing event", {
      payload: sanitizeWebhookPayload(req.body)
    });
    return res.status(400).json({ acknowledged: false, error: "Missing event" });
  }

  res.status(200).json({ acknowledged: true, event });

  processWebhookEvent(req.body, req.log, req.requestId).catch((error) => {
    req.log.error("Failed to process Foodics webhook event", {
      event,
      orderId: req.body?.order?.id,
      error
    });
  });
});

app.use((err, req, res, _next) => {
  const requestLogger = req?.log || logger.child({ requestId: "system" });
  requestLogger.error("Unhandled server error", { error: err });
  res.status(500).json({ acknowledged: false, error: "Internal server error" });
});

function sanitizeWebhookPayload(payload) {
  return {
    event: payload?.event,
    timestamp: payload?.timestamp,
    businessReference: payload?.business?.reference,
    orderId: payload?.order?.id ?? payload?.order_id ?? payload?.data?.order_id ?? null,
    orderReference: payload?.order?.reference ?? null,
    orderType: payload?.order?.type ?? null,
    hasCustomerAddress: Boolean(payload?.order?.customer_address)
  };
}

function isDeliveryOrder(order, eventName) {
  if (!order) return false;

  if (eventName.includes("order.delivery.")) return true;

  const orderType = Number(order.type);
  const deliveryTypeMatch = orderType === 3;
  const hasAddress = Boolean(order.customer_address?.description || order.customer_address?.name);

  return deliveryTypeMatch || hasAddress;
}

function isUpdatedEvent(eventName) {
  return eventName === "order.updated" || eventName === "order.delivery.updated";
}

function isStrictDeliveryOrder(order, eventName) {
  if (!order) return false;
  if (eventName?.includes("order.delivery.")) return true;

  const orderType = Number(order.type);
  if (orderType === 3) return true;

  const serviceType = normalizeStatusValue(order.service_type ?? order.fulfillment_type);
  return serviceType === "delivery";
}

function normalizeStatusValue(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim().toLowerCase();
}

function isReadyForPickupUpdate(order, payload, eventName) {
  if (!isUpdatedEvent(eventName)) return false;

  const readyMarkers = new Set(["2", "ready", "ready_for_pickup", "pickup_ready"]);
  const deliveryStatus = normalizeStatusValue(
    order?.delivery_status ?? payload?.delivery_status ?? payload?.data?.delivery_status
  );
  const orderStatus = normalizeStatusValue(order?.status ?? payload?.status ?? payload?.data?.status);
  const kitchenDone =
    Boolean(order?.kitchen_done_at) ||
    Boolean(order?.meta?.foodics?.kitchen_done_at) ||
    Boolean(payload?.kitchen_done_at) ||
    Boolean(payload?.data?.kitchen_done_at);

  return readyMarkers.has(deliveryStatus) || readyMarkers.has(orderStatus) || kitchenDone;
}

function shouldSuppressReadyDispatch(orderNumber) {
  const now = Date.now();
  const previous = readyDispatchCache.get(orderNumber);
  readyDispatchCache.set(orderNumber, now);

  if (!previous) return false;
  return now - previous < READY_EVENT_SUPPRESSION_WINDOW_MS;
}

function getShipdayOrderNumber(order) {
  return String(order.id || order.reference);
}

async function resolveOrder(payload, log) {
  if (payload.order && payload.order.id) {
    return payload.order;
  }

  const orderId = payload.order_id || payload.data?.order_id;
  if (!orderId) {
    throw new Error("Cannot resolve Foodics order ID from webhook payload");
  }

  log.info("Order object missing in webhook payload, fetching from Foodics API", { orderId });
  return foodicsClient.getOrderById(orderId, log);
}

function toShipdayOrderPayload(order, payload) {
  const toHhMmSs = (value) => {
    if (!value) return null;
    if (typeof value === "string" && /^\d{2}:\d{2}:\d{2}$/.test(value)) return value;

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(11, 19);
  };

  const toYyyyMmDd = (value) => {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) {
      return new Date().toISOString().slice(0, 10);
    }
    return date.toISOString().slice(0, 10);
  };

  const asNumberOrNull = (...values) => {
    for (const value of values) {
      if (value === undefined || value === null || value === "") continue;
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  };

  const items = Array.isArray(order.products)
    ? order.products.map((item) => ({
        name: item.name || item.name_localized || "Item",
        quantity: Number(item.quantity || 1),
        unitPrice: Number(item.price || 0)
      }))
    : [];

  const customerName =
    order.customer?.name || order.customer_name || order.customer_address?.name || "Foodics Customer";

  const customerPhone =
    order.customer?.phone || order.customer_phone || order.customer_address?.phone || "";

  const deliveryAddress =
    order.customer_address?.description ||
    order.customer_address?.name ||
    order.address ||
    "Address not provided";

  const totalOrderCost = Number(order.total_price ?? order.total ?? order.grand_total ?? 0);
  const expectedDeliveryDate = toYyyyMmDd(
    order.delivered_at ??
      order.delivery_time ??
      order.expected_delivery_at ??
      order.created_at ??
      payload.timestamp * 1000
  );
  const expectedPickupTime = toHhMmSs(
    order.expected_pickup_time ?? order.pickup_time ?? order.preparation_time
  );
  const expectedDeliveryTime = toHhMmSs(
    order.expected_delivery_time ?? order.delivery_time ?? order.delivered_at
  );
  const customerLatitude = asNumberOrNull(
    order.customer_address?.latitude,
    order.customer_address?.lat,
    order.customer?.latitude,
    order.customer?.lat
  );
  const customerLongitude = asNumberOrNull(
    order.customer_address?.longitude,
    order.customer_address?.lng,
    order.customer_address?.lon,
    order.customer?.longitude,
    order.customer?.lng,
    order.customer?.lon
  );
  const pickupLatitude = asNumberOrNull(
    order.branch?.latitude,
    order.branch?.lat,
    payload.business?.latitude,
    payload.business?.lat
  );
  const pickupLongitude = asNumberOrNull(
    order.branch?.longitude,
    order.branch?.lng,
    order.branch?.lon,
    payload.business?.longitude,
    payload.business?.lng,
    payload.business?.lon
  );

  const shipdayPayload = {
    orderNumber: getShipdayOrderNumber(order),
    customerName,
    customerPhoneNumber: customerPhone,
    customerAddress: deliveryAddress,
    restaurantName: payload.business?.name || order.branch?.name || "Foodics Store",
    restaurantAddress: order.branch?.name || "",
    expectedDeliveryDate,
    paymentMethod: order.payment_method?.name || "Prepaid",
    totalOrderCost,
    tax: Number(order.tax ?? 0),
    deliveryFee: Number(order.delivery_fees ?? 0),
    orderSource: "Foodics",
    orderItems: items
  };

  if (expectedPickupTime) shipdayPayload.expectedPickupTime = expectedPickupTime;
  if (expectedDeliveryTime) shipdayPayload.expectedDeliveryTime = expectedDeliveryTime;
  if (customerLatitude !== null) shipdayPayload.deliveryLatitude = customerLatitude;
  if (customerLongitude !== null) shipdayPayload.deliveryLongitude = customerLongitude;
  if (pickupLatitude !== null) shipdayPayload.pickupLatitude = pickupLatitude;
  if (pickupLongitude !== null) shipdayPayload.pickupLongitude = pickupLongitude;

  return shipdayPayload;
}

async function processWebhookEvent(payload, log, requestId) {
  const event = payload.event;

  if (!supportedEvents.has(event)) {
    log.info("Webhook event ignored; not configured for forwarding", { event });
    return;
  }

  const order = await resolveOrder(payload, log);

  if (!isDeliveryOrder(order, event)) {
    log.info("Order is not marked as delivery. Skipping Shipday forwarding", {
      event,
      orderId: order.id
    });
    return;
  }

  const orderNumber = getShipdayOrderNumber(order);

  if (isReadyForPickupUpdate(order, payload, event)) {
    if (!isStrictDeliveryOrder(order, event)) {
      log.info("Skipping ready-for-pickup transition for non-delivery order", {
        event,
        orderId: order.id,
        orderType: order.type,
        serviceType: order.service_type ?? order.fulfillment_type ?? null
      });
      return;
    }

    if (shouldSuppressReadyDispatch(orderNumber)) {
      log.info("Skipping duplicate ready-for-pickup transition", {
        event,
        orderId: order.id,
        orderNumber
      });
      return;
    }

    const shipdayOrder = await shipdayClient.getOrderByOrderNumber(orderNumber, {
      orderId: order.id,
      requestId
    });

    const candidateOrders = shipdayOrder.candidateOrders || [];
    const candidateOrderIds = candidateOrders.map((c) => c.id);

    if (candidateOrderIds.length === 0) {
      log.warn("Shipday order ID not found for ready-for-pickup transition", {
        event,
        orderId: order.id,
        orderNumber
      });
      return;
    }

    let readyUpdated = false;
    let selectedShipdayOrderId = null;
    let eligibleCandidateFound = false;

    for (const candidate of candidateOrders) {
      const candidateId = candidate.id;
      const isAlreadyReady = candidate.orderStatusAdmin === "READY_TO_PICKUP";
      const preconditionFailed = candidate.accepted === false || candidate.orderState === "NOT_ASSIGNED";

      if (isAlreadyReady) {
        log.info("Shipday order is already in ready-to-pickup state", {
          event,
          orderId: order.id,
          orderNumber,
          shipdayOrderId: candidateId
        });
        readyUpdated = true;
        selectedShipdayOrderId = candidateId;
        break;
      }

      if (preconditionFailed) {
        log.info("Skipping Shipday ready transition due to current Shipday order state", {
          event,
          orderId: order.id,
          orderNumber,
          shipdayOrderId: candidateId,
          shipdayOrderStatusAdmin: candidate.orderStatusAdmin,
          shipdayAccepted: candidate.accepted,
          shipdayOrderState: candidate.orderState
        });
        continue;
      }

      eligibleCandidateFound = true;
      try {
        await shipdayClient.markOrderReadyToPickup(candidateId, {
          orderId: order.id,
          requestId,
          maxAttempts: 1
        });
        readyUpdated = true;
        selectedShipdayOrderId = candidateId;
        break;
      } catch (error) {
        log.warn("Failed ready-for-pickup transition for candidate Shipday order ID", {
          event,
          orderId: order.id,
          orderNumber,
          shipdayOrderId: candidateId,
          externalStatusCode: error.response?.status,
          responseData: error.response?.data,
          error
        });
      }
    }

    if (!readyUpdated) {
      if (!eligibleCandidateFound) {
        log.warn("No eligible Shipday candidate order found for ready transition", {
          event,
          orderId: order.id,
          orderNumber,
          candidateOrderIds
        });
        return;
      }

      throw new Error(
        `Unable to mark order ready-for-pickup on Shipday for orderNumber=${orderNumber}`
      );
    }

    log.info("Order moved to ready-for-pickup on Shipday", {
      event,
      orderId: order.id,
      orderNumber,
      shipdayOrderId: selectedShipdayOrderId
    });
    return;
  }

  const shipdayPayload = toShipdayOrderPayload(order, payload);

  await shipdayClient.insertDeliveryOrder(shipdayPayload, {
    orderId: order.id,
    idempotencyKey: `${event}:${order.id}`,
    requestId
  });

  log.info("Delivery order forwarded to Shipday", {
    event,
    orderId: order.id,
    orderReference: order.reference
  });
}

app.listen(config.port, () => {
  logger.info("Foodics webhook server started", { port: config.port });
});
