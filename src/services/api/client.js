import axios from "axios";
import { MONDAY_API_URL } from "./endpoints.js";
import { logger } from "../../utils/logger.js";

let mondayToken = null;

const axiosInstance = axios.create({
  baseURL: MONDAY_API_URL,
  headers: {
    "Content-Type": "application/json",
    "API-Version": "2024-10",
  },
  timeout: 15000,
});

// Inject token on every request — raw token value, no "Bearer" prefix
axiosInstance.interceptors.request.use((config) => {
  if (mondayToken) {
    config.headers.Authorization = mondayToken;
  }
  return config;
});

axiosInstance.interceptors.response.use(
  (response) => response,
  (error) => {
    logger.error(
      `[api] Request failed: ${error?.response?.data || error.message}`,
    );
    throw error;
  },
);

export const setMondayToken = (token) => {
  mondayToken = token;
};

export default axiosInstance;
