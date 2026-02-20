# Foodics -> Shipday Webhook Integration

Production-ready Node.js integration that:
- Receives Foodics webhook events with Express + `body-parser`
- Verifies Foodics webhook HMAC signatures
- Processes supported order events
- Forwards delivery orders to Shipday `POST /orders`
- Uses Foodics OAuth token flow with in-memory token cache/refresh
- Uses structured logging with Winston + daily rotation
- Retries Shipday failures with exponential backoff

## 1. Prerequisites

- Node.js 18+
- Foodics webhook secret
- Shipday API key
- (Optional) Foodics OAuth credentials if webhook payload does not include full order details

## 2. Install

```bash
npm install
```

## 3. Configure environment

Copy `.env.example` to `.env` and fill required values:

```bash
cp .env.example .env
```

Required:
- `FOODICS_WEBHOOK_SECRET`
- `SHIPDAY_API_KEY`

Optional Foodics OAuth (used when order lookup is needed):
- `FOODICS_CLIENT_ID`
- `FOODICS_CLIENT_SECRET`
- `FOODICS_REDIRECT_URI`
- `FOODICS_AUTHORIZATION_CODE`
- `FOODICS_REFRESH_TOKEN`
- `FOODICS_ACCESS_TOKEN`
- `FOODICS_ACCESS_TOKEN_EXPIRES_AT`

## 4. Run server

```bash
npm start
```

Routes:
- `GET /health`
- `POST /webhooks/foodics`

## 5. Foodics webhook validation

`src/middleware/webhookValidator.js`:
- validates HMAC on raw request body
- uses `FOODICS_WEBHOOK_SECRET`
- header defaults to `x-foodics-signature` (configurable by `FOODICS_WEBHOOK_SIGNATURE_HEADER`)
- hash algo defaults to `sha256` (configurable by `FOODICS_WEBHOOK_HASH_ALGO`)

## 6. Foodics auth behavior

`src/foodicsClient.js`:
- uses `/oauth/token`
- refresh flow first (`refresh_token`)
- fallback to `authorization_code`
- caches access token, refresh token, and expiration in memory

## 7. Shipday forwarding

`src/shipdayClient.js` calls:
- `POST https://api.shipday.com/orders`

Auth:
- `Authorization: Basic <SHIPDAY_API_KEY>`

Retry policy:
- retries network errors, `429`, and `5xx`
- exponential backoff controlled by:
  - `SHIPDAY_MAX_RETRIES`
  - `SHIPDAY_RETRY_BASE_DELAY_MS`
  - `SHIPDAY_RETRY_MAX_DELAY_MS`

## 8. Logging

`src/logger.js` uses Winston + `winston-daily-rotate-file`:
- JSON file logs
- daily rotate: `logs/app-YYYY-MM-DD.log`
- gzip compression enabled
- retention: 14 days
- automatic old log cleanup

Request context:
- `src/middleware/requestContext.js` generates UUID `requestId` per request
- `requestId` is attached to all request-scoped logs

Dev vs prod:
- `NODE_ENV=development`: file logs + readable console logs
- `NODE_ENV=production`: file logs only

## 9. Local webhook test

Use included Postman assets:
- `postman/Foodics-Shipday-Webhook.postman_collection.json`
- `postman/Foodics-Local.postman_environment.json`

Or use curl:

```bash
curl -X POST http://localhost:3000/webhooks/foodics \
  -H "Content-Type: application/json" \
  -H "x-foodics-signature: <generated_signature>" \
  --data @payload.json
```

Expected ack:

```json
{ "acknowledged": true, "event": "order.delivery.created" }
```

## 10. Project structure

- `src/index.js`: server and webhook pipeline
- `src/config.js`: env parsing and validation
- `src/logger.js`: Winston logging configuration + rotation
- `src/foodicsClient.js`: Foodics OAuth + API client
- `src/shipdayClient.js`: Shipday API client + retries
- `src/middleware/requestContext.js`: per-request UUID logger context
- `src/middleware/webhookValidator.js`: Foodics signature validation

## 11. Testing with ngrok (real webhook callbacks)

Yes, ngrok free tier can be used for webhook testing.

### A. Install ngrok

On Windows (recommended):

```powershell
winget install --id Ngrok.Ngrok -e
```

Verify:

```powershell
ngrok version
```

### B. Configure ngrok auth token

1. Create/login account at `https://dashboard.ngrok.com/`
2. Copy your authtoken
3. Run:

```powershell
ngrok config add-authtoken <YOUR_NGROK_AUTHTOKEN>
```

### C. Run your app and tunnel

Terminal 1:

```powershell
npm run start:server
```

Terminal 2:

```powershell
npm run start:tunnel
```

Alternative if ngrok is not globally installed:

```powershell
npm run start:tunnel:npx
```

ngrok will print a public HTTPS URL like:

`https://abcd-1234.ngrok-free.app`

### D. Configure Foodics webhook URL

Set webhook endpoint in Foodics to:

`https://abcd-1234.ngrok-free.app/webhooks/foodics`

### E. Validate

1. Send/create/update an order in Foodics
2. Confirm local app logs incoming webhook + ack
3. Confirm Shipday forwarding logs

Notes:
- Postman pre-request signature script is only for local simulation.
- Real Foodics webhooks provide their own signature header.
- If ngrok URL changes (free tier), update webhook URL in Foodics.
