import express from "express";
import bodyParser from "body-parser";

import config from "./config.js";
import logger, { httpLogger } from "./logger.js";
import foodicsClient from "./foodicsClient.js";
import shipdayClient from "./shipdayClient.js";
import validateFoodicsWebhookSignature from "./middleware/webhookValidator.js";

const app = express();

app.use(
  bodyParser.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    }
  })
);
app.use(httpLogger);

const supportedEvents = new Set(config.forwardEvents);

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post(
  "/webhooks/foodics",
  validateFoodicsWebhookSignature,
  async (req, res) => {
    const event = req.body?.event;

    if (!event) {
      req.log.warn({ body: req.body }, "Webhook payload missing event");
      return res.status(400).json({ acknowledged: false, error: "Missing event" });
    }

    res.status(200).json({ acknowledged: true, event });

    processWebhookEvent(req.body, req.log).catch((error) => {
      req.log.error(
        {
          err: error.message,
          stack: error.stack,
          event,
          orderId: req.body?.order?.id
        },
        "Failed to process Foodics webhook event"
      );
    });
  }
);

app.use((err, req, res, _next) => {
  req.log?.error({ err: err.message, stack: err.stack }, "Unhandled server error");
  res.status(500).json({ acknowledged: false, error: "Internal server error" });
});

function isDeliveryOrder(order, eventName) {
  if (!order) return false;

  if (eventName.includes("order.delivery.")) return true;

  const orderType = Number(order.type);
  const deliveryTypeMatch = orderType === 3;
  const hasAddress = Boolean(order.customer_address?.description || order.customer_address?.name);

  return deliveryTypeMatch || hasAddress;
}

async function resolveOrder(payload, log) {
  if (payload.order && payload.order.id) {
    return payload.order;
  }

  const orderId = payload.order_id || payload.data?.order_id;
  if (!orderId) {
    throw new Error("Cannot resolve Foodics order ID from webhook payload");
  }

  log.info({ orderId }, "Order object missing in webhook payload, fetching from Foodics API");
  return foodicsClient.getOrderById(orderId);
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
    order.customer?.name ||
    order.customer_name ||
    order.customer_address?.name ||
    "Foodics Customer";

  const customerPhone =
    order.customer?.phone ||
    order.customer_phone ||
    order.customer_address?.phone ||
    "";

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
    orderNumber: String(order.reference || order.id),
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

async function processWebhookEvent(payload, log) {
  const event = payload.event;

  if (!supportedEvents.has(event)) {
    log.info({ event }, "Webhook event ignored; not configured for forwarding");
    return;
  }

  const order = await resolveOrder(payload, log);

  if (!isDeliveryOrder(order, event)) {
    log.info(
      { event, orderId: order.id },
      "Order is not marked as delivery. Skipping Shipday forwarding"
    );
    return;
  }

  const shipdayPayload = toShipdayOrderPayload(order, payload);

  await shipdayClient.insertDeliveryOrder(shipdayPayload, {
    orderId: order.id,
    idempotencyKey: `${event}:${order.id}`
  });

  log.info(
    {
      event,
      orderId: order.id,
      orderReference: order.reference
    },
    "Delivery order forwarded to Shipday"
  );
}

app.listen(config.port, () => {
  logger.info({ port: config.port }, "Foodics webhook server started");
});
