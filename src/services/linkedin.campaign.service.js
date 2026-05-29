import axios from "axios";
import { logger } from "../utils/logger.js";
import { API_ENDPOINTS, QUERY_PARAMS } from "../constants/api.constants.js";
import { getLinkedInAdsHeaders } from "../constants/headers.constants.js";
import {
  ANALYTICS_FIELDS,
  REQUEST_TIMEOUTS,
} from "../constants/app.constants.js";

const BASE_REST = API_ENDPOINTS.LINKEDIN.BASE_REST;

// ─── Common axios instance for LinkedIn Ads API
const createLinkedInAdsClient = (token) => {
  return axios.create({
    baseURL: BASE_REST,
    headers: getLinkedInAdsHeaders(token),
    timeout: REQUEST_TIMEOUTS.EXTENDED,
  });
};

// ─── Helper: Normalize creative ID from URN format
const normalizeCreativeId = (id) => {
  if (!id) return null;
  return id.replace(/urn:li:sponsoredCreative:/, "");
};

// ─── Build dateRange param string
const buildDateRangeParam = (startDate, endDate) => {
  const end = endDate instanceof Date ? endDate : new Date();
  // Default: Jan 1, 2025 — covers all active/completed campaigns
  const start = startDate instanceof Date ? startDate : new Date(2025, 0, 1);

  logger.info(
    `[linkedin-campaign] Using date range: ${start.toISOString().split("T")[0]} → ${end.toISOString().split("T")[0]}`,
  );

  // Return the raw parenthesized string — caller must NOT encode it
  return (
    `(start:(year:${start.getFullYear()},month:${start.getMonth() + 1},day:${start.getDate()}),` +
    `end:(year:${end.getFullYear()},month:${end.getMonth() + 1},day:${end.getDate()}))`
  );
};

// ─── Build campaigns=List(...) param
// Correct format matching Postman: campaigns=List(urn%3Ali%3AsponsoredCampaign%3A123)
// Only the colons inside the URN are percent-encoded. The List() wrapper is literal.
const buildCampaignsListParam = (campaignId) => {
  const urn = `urn:li:sponsoredCampaign:${campaignId}`;
  return `List(${encodeURIComponent(urn)})`;
};

// ─── Fetch all ad accounts ──────────────────────────────────────────────────
export const fetchAdAccounts = async (token) => {
  if (!token || typeof token !== "string" || token.trim().length === 0) {
    const err = new Error("LinkedIn access token is required");
    err.statusCode = 400;
    throw err;
  }

  try {
    logger.info(`[linkedin-campaign] Fetching ad accounts`);
    const client = createLinkedInAdsClient(token);
    const res = await client.get("/adAccounts?q=search");
    const accounts = res.data?.elements || [];
    logger.info(
      `[linkedin-campaign] ✓ Fetched ${accounts.length} ad account(s)`,
    );
    return accounts;
  } catch (err) {
    logger.error(
      `[linkedin-campaign] ✗ Failed to fetch ad accounts: ${err.message}`,
    );
    logger.error(
      `[linkedin-campaign] Response status: ${err.response?.status}`,
    );
    logger.error(
      `[linkedin-campaign] Response data: ${JSON.stringify(err.response?.data)}`,
    );
    if (err.response?.status === 401) {
      err.message = "Invalid LinkedIn access token";
      err.statusCode = 401;
    } else {
      err.statusCode = err.response?.status || 500;
    }
    throw err;
  }
};

// ─── Fetch all campaigns for a given account ───────────────────────────────
export const fetchCampaignsByAccount = async (token, accountId) => {
  if (!token || typeof token !== "string" || token.trim().length === 0) {
    const err = new Error("LinkedIn access token is required");
    err.statusCode = 400;
    throw err;
  }
  if (!accountId) {
    const err = new Error("Account ID is required");
    err.statusCode = 400;
    throw err;
  }

  try {
    logger.info(
      `[linkedin-campaign] Fetching campaigns for account: ${accountId}`,
    );
    const client = createLinkedInAdsClient(token);
    const res = await client.get(
      `/adAccounts/${accountId}/adCampaignGroups?q=search`,
    );
    const campaigns = res.data?.elements || [];
    logger.info(
      `[linkedin-campaign] ✓ Fetched ${campaigns.length} campaign(s) for account ${accountId}`,
    );
    return campaigns;
  } catch (err) {
    logger.error(
      `[linkedin-campaign] ✗ Failed to fetch campaigns: ${err.message}`,
    );
    logger.error(
      `[linkedin-campaign] Response status: ${err.response?.status}`,
    );
    logger.error(
      `[linkedin-campaign] Response data: ${JSON.stringify(err.response?.data)}`,
    );
    if (err.response?.status === 401) {
      err.message = "Invalid LinkedIn access token";
      err.statusCode = 401;
    } else if (err.response?.status === 404) {
      err.message = "Account not found";
      err.statusCode = 404;
    } else {
      err.statusCode = err.response?.status || 500;
    }
    throw err;
  }
};

// ─── Fetch campaign groups ─────────────────────────────────────────────────
export const fetchCampaignGroups = async (token, accountId) => {
  if (!token || typeof token !== "string" || token.trim().length === 0) {
    const err = new Error("LinkedIn access token is required");
    err.statusCode = 400;
    throw err;
  }
  if (!accountId) {
    const err = new Error("Account ID is required");
    err.statusCode = 400;
    throw err;
  }

  try {
    logger.info(
      `[linkedin-campaign] Fetching campaign groups for account: ${accountId}`,
    );
    const client = createLinkedInAdsClient(token);
    const res = await client.get(
      `/adAccounts/${accountId}/adCampaignGroups?q=search`,
    );
    const groups = res.data?.elements || [];
    logger.info(
      `[linkedin-campaign] ✓ Fetched ${groups.length} campaign group(s)`,
    );
    return groups;
  } catch (err) {
    logger.error(
      `[linkedin-campaign] ✗ Failed to fetch campaign groups: ${err.message}`,
    );
    throw err;
  }
};

// ─── Fetch ad campaigns ────────────────────────────────────────────────────
export const fetchAdCampaigns = async (token, accountId) => {
  if (!token || typeof token !== "string" || token.trim().length === 0) {
    const err = new Error("LinkedIn access token is required");
    err.statusCode = 400;
    throw err;
  }
  if (!accountId) {
    const err = new Error("Account ID is required");
    err.statusCode = 400;
    throw err;
  }

  try {
    logger.info(
      `[linkedin-campaign] Fetching ad campaigns for account: ${accountId}`,
    );
    const client = createLinkedInAdsClient(token);
    const res = await client.get(
      `/adAccounts/${accountId}/adCampaigns?q=search`,
    );
    const campaigns = res.data?.elements || [];
    logger.info(
      `[linkedin-campaign] ✓ Fetched ${campaigns.length} ad campaign(s)`,
    );
    return campaigns;
  } catch (err) {
    logger.error(
      `[linkedin-campaign] ✗ Failed to fetch ad campaigns: ${err.message}`,
    );
    throw err;
  }
};

// ─── Fetch creatives for a campaign ───────────────────────────────────────
export const fetchCreativesByCampaign = async (
  token,
  accountId,
  campaignId,
) => {
  if (!token || typeof token !== "string" || token.trim().length === 0) {
    const err = new Error("LinkedIn access token is required");
    err.statusCode = 400;
    throw err;
  }
  if (!accountId || !campaignId) {
    const err = new Error("Account ID and Campaign ID are required");
    err.statusCode = 400;
    throw err;
  }

  try {
    logger.info(
      `[linkedin-campaign] Fetching creatives for campaign: ${campaignId}`,
    );
    const client = createLinkedInAdsClient(token);
    const res = await client.get(
      `/adAccounts/${accountId}/creatives?q=criteria&campaigns=${buildCampaignsListParam(campaignId)}`,
    );
    const creatives = res.data?.elements || [];
    logger.info(
      `[linkedin-campaign] ✓ Fetched ${creatives.length} creative(s)`,
    );
    return creatives;
  } catch (err) {
    logger.warn(
      `[linkedin-campaign] ✗ Failed to fetch creatives for campaign ${campaignId}: ${err.message}`,
    );
    return [];
  }
};

// ─── Fetch analytics using Analytics Finder (batched, one call per campaign) ─
//
// ✅ ROOT CAUSE OF ALL-ZERO ANALYTICS — FIXED HERE:
//
// The previous code used encodeURIComponent(dateRangeParam) for the dateRange
// query parameter value. This converted:
//
//   (start:(year:2025,month:1,day:1),end:(year:2026,month:4,day:17))
//
// into:
//
//   %28start%3A%28year%3A2025%2Cmonth%3A1%2Cday%3A1%29%2Cend%3A...%29
//
// LinkedIn's adAnalytics endpoint does NOT accept the encoded form.
// It silently returns 0 elements (or a 400), causing every creative to show
// zeros even though real data exists in the dashboard.
//
// The fix: pass dateRangeParam as a raw string — exactly matching the working
// Postman URL format: &dateRange=(start:(year:2026,month:1,day:15),...)
//
// Same applies to fetchCampaignAnalytics below.
//
export const fetchAnalyticsBatch = async (
  token,
  campaignIds,
  startDate = null,
  endDate = null,
) => {
  if (!campaignIds || campaignIds.length === 0) {
    logger.warn(
      `[linkedin-campaign] No campaign IDs provided - returning empty analytics`,
    );
    return [];
  }

  const client = createLinkedInAdsClient(token);

  // ✅ Raw string — NOT encodeURIComponent'd
  const dateRangeParam = buildDateRangeParam(startDate, endDate);

  logger.info(
    `[linkedin-campaign] Analytics dateRange (raw, unencoded): ${dateRangeParam}`,
  );

  const batchSize = 3;
  const results = [];

  logger.info(
    `[linkedin-campaign] Fetching analytics for ${campaignIds.length} campaign(s) in batches of ${batchSize}`,
  );

  try {
    for (let i = 0; i < campaignIds.length; i += batchSize) {
      const chunk = campaignIds.slice(i, i + batchSize);

      const promises = chunk.map(async (campaignId) => {
        try {
          // ✅ URL construction matches the working Postman call exactly:
          //
          //   dateRange  → raw parenthesized value, NOT encoded
          //                e.g. (start:(year:2025,month:1,day:1),end:(...))
          //
          //   campaigns  → List(urn%3Ali%3AsponsoredCampaign%3AIDID)
          //                Only URN colons encoded, List() wrapper is literal
          //
          //   fields     → raw comma string, NOT encoded
          //                Encoded commas (%2C) break the request
          //
          const url =
            `/adAnalytics?q=analytics` +
            `&pivot=CREATIVE` +
            `&timeGranularity=ALL` +
            `&dateRange=${dateRangeParam}` +
            `&campaigns=${buildCampaignsListParam(campaignId)}` +
            `&fields=${ANALYTICS_FIELDS}`;

          logger.info(
            `[linkedin-campaign] Requesting analytics for campaign ${campaignId}`,
          );
          logger.info(`[linkedin-campaign] Full URL: ${BASE_REST}${url}`);

          const res = await client.get(url);
          const elements = res.data?.elements || [];

          logger.info(
            `[linkedin-campaign] ✓ Campaign ${campaignId}: ${elements.length} analytics record(s)`,
          );

          return elements;
        } catch (err) {
          logger.warn(
            `[linkedin-campaign] ✗ Failed for campaign ${campaignId}: ${err.message}`,
          );
          logger.warn(`[linkedin-campaign] Status: ${err.response?.status}`);
          logger.warn(
            `[linkedin-campaign] Response body: ${JSON.stringify(err.response?.data)}`,
          );
          return [];
        }
      });

      const chunkResults = await Promise.all(promises);
      results.push(...chunkResults.flat());

      logger.info(
        `[linkedin-campaign] ✓ Batch ${Math.floor(i / batchSize) + 1} complete`,
      );
    }

    logger.info(
      `[linkedin-campaign] ✅ Total analytics records: ${results.length}`,
    );
    return results;
  } catch (err) {
    logger.error(
      `[linkedin-campaign] ✗ Batch processing failed: ${err.message}`,
    );
    return [];
  }
};

// ─── Fetch creative analytics for single campaign (convenience wrapper) ────
export const fetchCreativeAnalyticsByCampaign = async (
  token,
  campaignId,
  startDate = null,
  endDate = null,
) => {
  if (!token || typeof token !== "string" || token.trim().length === 0) {
    const err = new Error("LinkedIn access token is required");
    err.statusCode = 400;
    throw err;
  }
  if (!campaignId) {
    const err = new Error("Campaign ID is required");
    err.statusCode = 400;
    throw err;
  }
  return fetchAnalyticsBatch(token, [campaignId], startDate, endDate);
};

// ─── Parse creative analytics from Analytics Finder response ───────────────
// pivotValues[0] = "urn:li:sponsoredCreative:XXXXX" → map key = "XXXXX"
export const parseCreativeAnalytics = (analyticsElements = []) => {
  const analyticsMap = {};

  logger.info(
    `[linkedin-campaign] 📊 parseCreativeAnalytics received ${analyticsElements.length} elements`,
  );

  if (analyticsElements.length > 0) {
    logger.info(
      `[linkedin-campaign] First element sample: ${JSON.stringify(analyticsElements[0], null, 2)}`,
    );
  } else {
    logger.warn(
      `[linkedin-campaign] ⚠️  No analytics elements received! Check that the dateRange is correct and campaigns have impressions.`,
    );
  }

  analyticsElements.forEach((element, idx) => {
    try {
      const pivotValues = element.pivotValues || [];

      if (pivotValues.length < 1) {
        logger.warn(`[linkedin-campaign] Element ${idx} has no pivotValues`);
        return;
      }

      const creativeUrn = pivotValues[0];
      const creativeId = normalizeCreativeId(creativeUrn);

      if (!creativeId) {
        logger.warn(
          `[linkedin-campaign] Could not extract creative ID from: ${creativeUrn}`,
        );
        return;
      }

      logger.info(
        `[linkedin-campaign] Element ${idx}: Creative ID = ${creativeId}`,
      );

      if (!analyticsMap[creativeId]) {
        analyticsMap[creativeId] = {
          impressions: 0,
          clicks: 0,
          costInLocalCurrency: 0,
          externalWebsiteConversions: 0,
          leadGenerationMailContactInfoShares: 0,
          landingPageClicks: 0,
          likes: 0,
          shares: 0,
          videoViews: 0,
          approximateMemberReach: 0,
          dateRange: element.dateRange || null,
        };
      }

      // ✅ costInLocalCurrency is a STRING from LinkedIn ("24.247...")
      // parseFloat before += to avoid string concatenation instead of addition
      const cost = parseFloat(element.costInLocalCurrency) || 0;

      analyticsMap[creativeId].impressions += element.impressions || 0;
      analyticsMap[creativeId].clicks += element.clicks || 0;
      analyticsMap[creativeId].costInLocalCurrency += cost;
      analyticsMap[creativeId].externalWebsiteConversions +=
        element.externalWebsiteConversions || 0;
      analyticsMap[creativeId].leadGenerationMailContactInfoShares +=
        element.leadGenerationMailContactInfoShares || 0;
      analyticsMap[creativeId].landingPageClicks +=
        element.landingPageClicks || 0;
      analyticsMap[creativeId].likes += element.likes || 0;
      analyticsMap[creativeId].shares += element.shares || 0;
      analyticsMap[creativeId].videoViews += element.videoViews || 0;
      analyticsMap[creativeId].approximateMemberReach +=
        element.approximateMemberReach || 0;

      logger.info(
        `[linkedin-campaign] ✓ Creative ${creativeId}: impressions=${analyticsMap[creativeId].impressions}, clicks=${analyticsMap[creativeId].clicks}, cost=${analyticsMap[creativeId].costInLocalCurrency.toFixed(2)}`,
      );
    } catch (err) {
      logger.warn(
        `[linkedin-campaign] Error parsing element ${idx}: ${err.message}`,
      );
    }
  });

  logger.info(
    `[linkedin-campaign] ✅ Analytics map complete: ${Object.keys(analyticsMap).length} unique creatives found`,
  );
  if (Object.keys(analyticsMap).length > 0) {
    const creativeList = Object.keys(analyticsMap).slice(0, 5).join(", ");
    logger.info(`[linkedin-campaign] Sample creatives: ${creativeList}...`);
  }

  return analyticsMap;
};

// ─── Fetch campaign analytics (single campaign, direct call) ──────────────
export const fetchCampaignAnalytics = async (
  token,
  campaignId,
  startDate = null,
  endDate = null,
) => {
  if (!token || typeof token !== "string" || token.trim().length === 0) {
    const err = new Error("LinkedIn access token is required");
    err.statusCode = 400;
    throw err;
  }
  if (!campaignId) {
    const err = new Error("Campaign ID is required");
    err.statusCode = 400;
    throw err;
  }

  try {
    logger.info(
      `[linkedin-campaign] Fetching analytics for campaign: ${campaignId}`,
    );
    const client = createLinkedInAdsClient(token);

    // ✅ dateRangeParam passed as raw string — NOT encodeURIComponent'd
    const dateRangeParam = buildDateRangeParam(startDate, endDate);

    const url =
      `/adAnalytics?q=analytics&pivot=CREATIVE&timeGranularity=ALL` +
      `&dateRange=${dateRangeParam}` +
      `&campaigns=${buildCampaignsListParam(campaignId)}` +
      `&fields=${ANALYTICS_FIELDS}`;

    logger.info(`[linkedin-campaign] Full URL: ${BASE_REST}${url}`);

    const res = await client.get(url);
    const analytics = res.data?.elements || [];

    logger.info(
      `[linkedin-campaign] ✓ Fetched ${analytics.length} analytics record(s) for campaign ${campaignId}`,
    );

    return analytics;
  } catch (err) {
    logger.warn(
      `[linkedin-campaign] ✗ Failed to fetch analytics for campaign ${campaignId}: ${err.message}`,
    );
    logger.warn(`[linkedin-campaign] Status: ${err.response?.status}`);
    logger.warn(
      `[linkedin-campaign] Response: ${JSON.stringify(err.response?.data)}`,
    );
    return [];
  }
};

// ─── Format account info ───────────────────────────────────────────────────
export const formatAccountInfo = (account) => {
  return {
    id: account.id,
    name: account.name,
    type: account.type,
    status: account.status,
    currency: account.currency,
    reference: account.reference,
    servingStatuses: account.servingStatuses || [],
  };
};

// ─── Format campaign info ──────────────────────────────────────────────────
export const formatCampaignInfo = (campaign) => {
  return {
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    objectiveType: campaign.objectiveType || "UNKNOWN",
    servingStatuses: campaign.servingStatuses || [],
    account: campaign.account,
    campaignGroup: campaign.campaignGroup || null,
    runSchedule: campaign.runSchedule || null,
    backfilled: campaign.backfilled || false,
  };
};

// ─── Format campaign group info ────────────────────────────────────────────
export const formatCampaignGroupInfo = (group) => {
  return {
    id: group.id,
    name: group.name,
    status: group.status,
    objectiveType: group.objectiveType || "UNKNOWN",
    servingStatuses: group.servingStatuses || [],
    backfilled: group.backfilled || false,
  };
};

// ─── Format creative info ──────────────────────────────────────────────────
export const formatCreativeInfo = (creative) => {
  return {
    id: creative.id, // full URN: "urn:li:sponsoredCreative:XXXXX"
    name: creative.name || "N/A",
    status: creative.status,
    type: creative.type,
  };
};

// ─── Format analytics info ─────────────────────────────────────────────────
export const formatAnalyticsInfo = (analytics) => {
  if (!analytics) return {};

  return {
    impressions: analytics.impressions || 0,
    clicks: analytics.clicks || 0,
    // Round to 2 decimal places — LinkedIn returns a long float string
    costInLocalCurrency: parseFloat(
      (analytics.costInLocalCurrency || 0).toFixed(2),
    ),
    externalWebsiteConversions: analytics.externalWebsiteConversions || 0,
    leadGenerationMailContactInfoShares:
      analytics.leadGenerationMailContactInfoShares || 0,
    landingPageClicks: analytics.landingPageClicks || 0,
    likes: analytics.likes || 0,
    shares: analytics.shares || 0,
    videoViews: analytics.videoViews || 0,
    approximateMemberReach: analytics.approximateMemberReach || 0,
    dateRange: analytics.dateRange || null,
  };
};
