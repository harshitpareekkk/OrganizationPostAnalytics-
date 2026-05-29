// ─── Post Type Mapping ────────────────────────────────────────────────────────

export const POST_TYPES = {
  TEXT: "TEXT",
  IMAGE: "IMAGE",
  VIDEO: "VIDEO",
  ARTICLE: "ARTICLE",
  DOCUMENT: "DOCUMENT",
  RICH: "RICH",
};

// ─── LinkedIn Post Status / Lifecycle ──────────────────────────────────────────

export const LINKEDIN_POST_STATE = {
  DRAFT: "DRAFT",
  PUBLISHED: "PUBLISHED",
};

export const LINKEDIN_VISIBILITY = {
  PUBLIC: "PUBLIC",
  CONNECTIONS: "CONNECTIONS",
  LOGGED_IN: "LOGGED_IN",
};

// ─── Campaign Status Mapping (LinkedIn → Monday) ──────────────────────────────

export const CAMPAIGN_STATUS_MAP = {
  ACTIVE: "ACTIVE",
  COMPLETED: "COMPLETED",
  PAUSED: "PAUSED",
  DRAFT: "DRAFT",
  PENDING: "PENDING",
  REMOVED: "REMOVED",
  ARCHIVED: "ARCHIVED",
};

// ─── LinkedIn Analytics Fields ────────────────────────────────────────────────

export const ANALYTICS_FIELDS =
  "pivotValues,dateRange,impressions,clicks,costInLocalCurrency," +
  "externalWebsiteConversions,leadGenerationMailContactInfoShares," +
  "landingPageClicks,likes,shares,videoViews,approximateMemberReach";

// ─── Default Values for Post Creation ──────────────────────────────────────────

export const POST_DEFAULTS = {
  // Draft posts are safe by default (not visible to public)
  IS_DRAFT: true,
  // Only logged-in members can see (safe default)
  VISIBILITY: LINKEDIN_VISIBILITY.LOGGED_IN,
};

// ─── Monday.com Post Type Status Index ────────────────────────────────────────
// Maps post types to Monday status column indices

export const MONDAY_POST_TYPE_INDEX = {
  IMAGE: 0,
  DOCUMENT: 1,
  VIDEO: 2,
  TEXT: 3,
  RICH: 4,
  ARTICLE: 6,
};

// ─── Time Constants ───────────────────────────────────────────────────────────

export const TIME_CONSTANTS = {
  MILLISECONDS_PER_DAY: 24 * 60 * 60 * 1000,
  DEFAULT_LOOKBACK_DAYS: 90,
  CUTOFF_TIME_MS: 90 * 24 * 60 * 60 * 1000,
};

// ─── Request Timeouts (ms) ────────────────────────────────────────────────────

export const REQUEST_TIMEOUTS = {
  DEFAULT: 15000, // 15 seconds
  EXTENDED: 30000, // 30 seconds for long operations
};

// ─── Error Codes (from LinkedIn, Monday) ──────────────────────────────────────

export const ERROR_CODES = {
  INVALID_CREATIVE_ID: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
};

// ─── Group Names ──────────────────────────────────────────────────────────────

export const GROUP_NAMES = {
  CAMPAIGNS: "Campaigns",
  CREATIVES: "Creatives",
};
