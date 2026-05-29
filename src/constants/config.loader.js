// Configuration Loader Utility

import { getConfig } from "./env.constants.js";
import { logger } from "../utils/logger.js";

/**
 * Initialize and validate configuration on app startup
 * Should be called immediately after dotenv.config() in index.js
 */
export const initializeConfig = () => {
  try {
    const config = getConfig();


    logger.info(`[config] Application Configuration Initialized`);
    logger.info(`[config] Environment: ${config.NODE_ENV}`);

    logger.info(`[config] Port: ${config.PORT}`);

    logger.info(
      `[config] LinkedIn Token: ${config.LINKEDIN_ACCESS_TOKEN ? "Set" : "Missing"}`,
    );
    logger.info(
      `[config] LinkedIn Org ID: ${config.LINKEDIN_ORG_ID ? "Set" : "Missing"}`,
    );
    logger.info(
      `[config] Monday API Key: ${config.MONDAY_API_KEY ? "Set" : "Missing"}`,
    );
    logger.info(
      `[config] Monday Signing Secret: ${config.MONDAY_SIGNING_SECRET ? "Set" : "Missing"}`,
    );
    logger.info(
      `[config] Monday Campaign Board: ${config.MONDAY_CAMPAIGN_BOARD_ID || "NOT SET"}`,
    );
    logger.info(
      `[config] Monday Creatives Board: ${config.MONDAY_CREATIVES_BOARD_ID || "NOT SET"}`,
    );

    return config;
  } catch (error) {
    logger.error(`[config] Configuration Error: ${error.message}`);
    process.exit(1);
  }
};

export default getConfig;
