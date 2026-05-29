// ─── API Headers & Versioning ─────────────────────────────────────────────────

export const API_VERSIONS = {
  LINKEDIN_REST: "202503", // New REST API version
  LINKEDIN_LEGACY: "2023-10", // Legacy UGC API version
  MONDAY_V2: "2024-10",
  RESTLI_PROTOCOL: "2.0.0",
};

export const AUTH_HEADERS = {
  // Bearer token format
  BEARER_PREFIX: "Bearer ",
  // Monday.com expects raw token, no prefix
  MONDAY_HEADER: "Authorization",
};

// ─── Header Builders ──────────────────────────────────────────────────────────

/**
 * Headers for LinkedIn v2/ugcPosts API (legacy, for articles and images)
 */
export const getLinkedInUGCHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "X-Restli-Protocol-Version": API_VERSIONS.RESTLI_PROTOCOL,
});

/**
 * Headers for LinkedIn /rest/posts and /rest/videos APIs (new)
 */
export const getLinkedInRESTHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "LinkedIn-Version": API_VERSIONS.LINKEDIN_REST,
  "X-Restli-Protocol-Version": API_VERSIONS.RESTLI_PROTOCOL,
});

/**
 * Headers for LinkedIn Ads API
 */
export const getLinkedInAdsHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "LinkedIn-Version": API_VERSIONS.LINKEDIN_REST,
  "X-Restli-Protocol-Version": API_VERSIONS.RESTLI_PROTOCOL,
});

/**
 * Headers for Monday.com GraphQL API
 */
export const getMondayHeaders = (token) => ({
  Authorization: token, // Monday expects raw token, no "Bearer" prefix
  "Content-Type": "application/json",
  "API-Version": API_VERSIONS.MONDAY_V2,
});

// ─── Common Content Types ─────────────────────────────────────────────────────

export const CONTENT_TYPES = {
  JSON: "application/json",
  FORM_DATA: "multipart/form-data",
  TEXT: "text/plain",
};

// ─── JWT & Auth Constants ─────────────────────────────────────────────────────

export const JWT_CONSTANTS = {
  ALGORITHM: "HS256",
};
