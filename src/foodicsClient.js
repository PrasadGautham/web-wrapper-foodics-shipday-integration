import axios from "axios";
import config from "./config.js";
import { getLogger } from "./logger.js";

const logger = getLogger("foodicsClient");

class FoodicsClient {
  constructor() {
    this.http = axios.create({
      baseURL: config.foodics.apiBaseUrl,
      timeout: 15000,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      }
    });

    this.token = {
      accessToken: config.foodics.accessToken || null,
      refreshToken: config.foodics.refreshToken || null,
      expiresAt: config.foodics.accessTokenExpiresAt || null
    };

    this.refreshPromise = null;
  }

  async getAccessToken() {
    if (this.isAccessTokenValid()) {
      return this.token.accessToken;
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshAccessToken().finally(() => {
        this.refreshPromise = null;
      });
    }

    await this.refreshPromise;
    return this.token.accessToken;
  }

  isAccessTokenValid() {
    if (!this.token.accessToken) return false;
    if (!this.token.expiresAt) return true;

    const now = Date.now();
    const refreshSkewMs = 60 * 1000;
    return now + refreshSkewMs < this.token.expiresAt;
  }

  async refreshAccessToken() {
    if (this.token.refreshToken) {
      try {
        const response = await axios.post(
          `${config.foodics.authBaseUrl}/oauth/token`,
          {
            grant_type: "refresh_token",
            refresh_token: this.token.refreshToken,
            client_id: config.foodics.clientId,
            client_secret: config.foodics.clientSecret,
            redirect_uri: config.foodics.redirectUri
          },
          {
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json"
            },
            timeout: 15000
          }
        );

        this.updateTokenCache(response.data);
        logger.info("Foodics access token refreshed successfully", {
          externalStatusCode: response.status
        });
        return;
      } catch (error) {
        logger.warn("Foodics refresh token flow failed, attempting authorization_code flow", {
          externalStatusCode: error.response?.status,
          error
        });
      }
    }

    await this.fetchAccessTokenFromAuthorizationCode();
  }

  async fetchAccessTokenFromAuthorizationCode() {
    if (
      !config.foodics.authorizationCode ||
      !config.foodics.clientId ||
      !config.foodics.clientSecret ||
      !config.foodics.redirectUri
    ) {
      throw new Error("Missing Foodics OAuth configuration for authorization_code flow.");
    }

    const response = await axios.post(
      `${config.foodics.authBaseUrl}/oauth/token`,
      {
        grant_type: "authorization_code",
        code: config.foodics.authorizationCode,
        client_id: config.foodics.clientId,
        client_secret: config.foodics.clientSecret,
        redirect_uri: config.foodics.redirectUri
      },
      {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        timeout: 15000
      }
    );

    this.updateTokenCache(response.data);
    logger.info("Foodics access token obtained using authorization_code flow", {
      externalStatusCode: response.status
    });
  }

  updateTokenCache(tokenPayload) {
    this.token.accessToken = tokenPayload.access_token;
    this.token.refreshToken = tokenPayload.refresh_token || this.token.refreshToken;

    if (tokenPayload.expires_in) {
      this.token.expiresAt = Date.now() + tokenPayload.expires_in * 1000;
    } else {
      this.token.expiresAt = null;
    }
  }

  async getOrderById(orderId, requestLog) {
    if (!orderId) {
      throw new Error("orderId is required to fetch order from Foodics API");
    }

    const accessToken = await this.getAccessToken();
    const response = await this.http.get(`/orders/${orderId}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const activeLog = requestLog || logger;
    activeLog.info("Fetched order details from Foodics API", {
      orderId,
      externalStatusCode: response.status
    });

    return response.data?.data ?? response.data;
  }
}

const foodicsClient = new FoodicsClient();

export default foodicsClient;
