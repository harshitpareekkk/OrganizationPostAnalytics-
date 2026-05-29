// ─── Environment Configuration ────────────────────────────────────────────────
// Central hub for all environment variables with defaults and validation

export const getEnvConfig = () => {
  const isProduction = process.env.NODE_ENV === "production";

  const config = {
    // Application
    NODE_ENV: process.env.NODE_ENV || "development",
    PORT: parseInt(process.env.PORT || "8080", 10),

    // LinkedIn
    LINKEDIN_ACCESS_TOKEN: process.env.LINKEDIN_ACCESS_TOKEN,
    LINKEDIN_ORG_ID: process.env.LINKEDIN_ORG_ID,

    // Monday.com
    MONDAY_API_KEY: process.env.MONDAY_API_KEY,
    MONDAY_SIGNING_SECRET: process.env.MONDAY_SIGNING_SECRET,
    MONDAY_APP_ID: process.env.MONDAY_APP_ID,
    MONDAY_CAMPAIGN_BOARD_ID: process.env.MONDAY_CAMPAIGN_BOARD_ID,
    MONDAY_CREATIVES_BOARD_ID: process.env.MONDAY_CREATIVES_BOARD_ID,
  };

  // Validate required environment variables in production
  if (isProduction) {
    const required = [
      "LINKEDIN_ACCESS_TOKEN",
      "LINKEDIN_ORG_ID",
      "MONDAY_API_KEY",
      "MONDAY_SIGNING_SECRET",
      "MONDAY_APP_ID",
      "MONDAY_CAMPAIGN_BOARD_ID",
      "MONDAY_CREATIVES_BOARD_ID",
    ];

    const missing = required.filter((key) => !config[key]);

    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables in production: ${missing.join(", ")}`,
      );
    }
  }

  return config;
};

// Cached config instance
let cachedConfig = null;

export const getConfig = () => {
  if (!cachedConfig) {
    cachedConfig = getEnvConfig();
  }
  return cachedConfig;
};
