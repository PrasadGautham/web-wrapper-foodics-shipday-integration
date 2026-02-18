# Foodics -> Shipday Webhook Integration

Production-oriented Node.js integration that:
- Receives Foodics webhook events with Express + `body-parser`
- Verifies webhook signatures with HMAC
- Handles supported order events
- Uses Foodics OAuth token flow and caches auth token in-memory
- Sends delivery orders to Shipday `POST /orders`
- Logs structured request/response events with Pino
- Retries Shipday calls with exponential backoff

## 1. Prerequisites

- Node.js 18+
- Foodics app credentials and webhook secret
- Shipday API key

## 2. Install

```bash
npm install
```

## 3. Configure environment

Copy `.env.example` to `.env` and fill all required values:

```bash
cp .env.example .env
```

Important variables:
- `FOODICS_WEBHOOK_SECRET`: shared secret for signature validation
- `FOODICS_CLIENT_ID`, `FOODICS_CLIENT_SECRET`, `FOODICS_REDIRECT_URI`, `FOODICS_AUTHORIZATION_CODE`: OAuth bootstrap inputs
- `SHIPDAY_API_KEY`: Shipday API key

## 4. Run server

```bash
npm start
```

Server routes:
- `GET /health`
- `POST /webhooks/foodics`

## 5. Foodics auth behavior

`src/foodicsClient.js` uses OAuth token endpoint (`/oauth/token`) and supports:
- `refresh_token` grant (if refresh token is present)
- fallback to `authorization_code` grant

Token cache is in-memory:
- `accessToken`
- `refreshToken`
- `expiresAt` (auto refresh before expiry)

## 6. Webhook signature validation

`src/middleware/webhookValidator.js` validates HMAC using raw body bytes and shared secret.

Header defaults to `x-foodics-signature` and can be changed by:
- `FOODICS_WEBHOOK_SIGNATURE_HEADER`

Algorithm defaults to `sha256` and can be changed by:
- `FOODICS_WEBHOOK_HASH_ALGO`

The middleware accepts either hex or base64 signature formats.

## 7. Shipday forwarding and retries

`src/shipdayClient.js` calls:
- `POST https://api.shipday.com/orders`

Headers:
- `x-api-key: <SHIPDAY_API_KEY>`

Retry policy:
- Exponential backoff for network errors, `429`, and `5xx`
- Controlled by:
  - `SHIPDAY_MAX_RETRIES`
  - `SHIPDAY_RETRY_BASE_DELAY_MS`
  - `SHIPDAY_RETRY_MAX_DELAY_MS`

## 8. Example webhook test (local)

Example payload:

```json
{
  "timestamp": 1700000000,
  "event": "order.delivery.created",
  "business": { "name": "Demo Restaurant", "reference": 12345 },
  "order": {
    "id": "ord_123",
    "reference": "10001",
    "type": 3,
    "total_price": 79.5,
    "tax": 5,
    "delivery_fees": 8,
    "branch": { "name": "Main Branch" },
    "customer": { "name": "John Doe", "phone": "15550001111" },
    "customer_address": { "description": "123 Main St" },
    "products": [{ "name": "Burger", "quantity": 2, "price": 20 }]
  }
}
```

Generate signature (PowerShell):

```powershell
$secret = "YOUR_WEBHOOK_SECRET"
$body = Get-Content .\payload.json -Raw
$hmac = New-Object System.Security.Cryptography.HMACSHA256
$hmac.Key = [Text.Encoding]::UTF8.GetBytes($secret)
$signature = [BitConverter]::ToString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($body))).Replace("-", "").ToLower()
Write-Output $signature
```

Send webhook:

```bash
curl -X POST http://localhost:3000/webhooks/foodics \
  -H "Content-Type: application/json" \
  -H "x-foodics-signature: <generated_signature>" \
  --data @payload.json
```

Expected ack response:

```json
{ "acknowledged": true, "event": "order.delivery.created" }
```

## 9. Project structure

- `src/index.js`: webhook server and event pipeline
- `src/config.js`: env parsing and validation
- `src/logger.js`: structured logger and HTTP logging middleware
- `src/foodicsClient.js`: Foodics OAuth token + API client
- `src/shipdayClient.js`: Shipday API client with retries
- `src/middleware/webhookValidator.js`: HMAC validation
