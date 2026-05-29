// ─── API Endpoints ────────────────────────────────────────────────────────────
// Central hub for all external API URLs

export const API_ENDPOINTS = {
  LINKEDIN: {
    // Version 2 API (legacy)
    BASE_V2: "https://api.linkedin.com/v2",
    SHARES: "https://api.linkedin.com/v2/shares",
    ORGANIZATIONS: "https://api.linkedin.com/v2/me/adcertificationsV2?q=owners",
    ORG_ACL: "https://api.linkedin.com/v2/organizationAcls?q=organization",

    // REST API (new)
    BASE_REST: "https://api.linkedin.com/rest",
    POSTS: "https://api.linkedin.com/rest/posts",
    VIDEOS: "https://api.linkedin.com/rest/videos",
    UGCPOSTS: "https://api.linkedin.com/v2/ugcPosts",

    // LinkedIn Ads API
    ACCOUNTS: "https://api.linkedin.com/rest/adAccounts",
    CAMPAIGNS: "https://api.linkedin.com/rest/adCampaigns",
    CAMPAIGN_GROUPS: "https://api.linkedin.com/rest/adCampaignGroups",
    CREATIVES: "https://api.linkedin.com/rest/adCreatives",
    ANALYTICS_FINDER: "https://api.linkedin.com/rest/adAnalyticsV2?q=analytics",
  },

  MONDAY: {
    BASE: "https://api.monday.com/v2",
    GRAPHQL: "https://api.monday.com/v2",
  },
};

// ─── Route Paths ──────────────────────────────────────────────────────────────

export const ROUTE_PATHS = {
  // Sync endpoints
  SYNC: "/api/sync",
  STORAGE: "/api/storage",
  STORAGE_BY_ID: "/api/storage/:postId",

  // Campaign endpoints
  CAMPAIGN_COMPLETE: "/api/campaign/complete",
  CAMPAIGN_PUSH: "/api/campaign/push-monday",
  CAMPAIGN_DELETE_GROUPS: "/api/campaign/delete-all-groups",

  // LinkedIn Org Page endpoints
  ORG_ORGANIZATIONS: "/api/orgpage/organizations",
  ORG_CREATE_POST: "/api/orgpage/create",
};

// ─── Query Parameters Limits ───────────────────────────────────────────────────

export const QUERY_PARAMS = {
  PAGINATION: {
    DEFAULT_PAGE_SIZE: 50,
    MAX_PAGE_SIZE: 500,
    LINKEDIN_PAGE_SIZE: 50,
  },

  MULTER: {
    MAX_FILES: 9,
    MAX_FILE_SIZE: 200 * 1024 * 1024, // 200 MB
    MAX_IMAGE_SIZE: 5 * 1024 * 1024, // 5 MB per image
  },

  ANALYTICS: {
    DEFAULT_LOOKBACK_DAYS: 90,
  },
};
