import {
  fetchAdAccounts,
  fetchCampaignGroups,
  fetchAdCampaigns,
  fetchCreativesByCampaign,
  fetchAnalyticsBatch,
  parseCreativeAnalytics,
  formatAccountInfo,
  formatCampaignGroupInfo,
  formatCampaignInfo,
  formatCreativeInfo,
  formatAnalyticsInfo,
} from "../../services/linkedin.campaign.service.js";
import { pushLinkedInDataToMondayBoards } from "../../services/campaign.monday.service.js";
import { logger } from "../../utils/logger.js";
import { StatusCodes } from "../../constants/statusCodes.constants.js";
import { MESSAGES } from "../../constants/messages.constant.js";
import { getConfig } from "../../constants/env.constants.js";

// Helper: strip the "urn:li:sponsoredCreative:" prefix to get the plain numeric ID
const normalizeCreativeId = (id) => {
  if (!id) return null;
  return id.replace(/urn:li:sponsoredCreative:/, "");
};

// Helper: parse a YYYY-MM-DD query param into a Date, or return null
const parseDateParam = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
};

export const getAdAccounts = async (req, res) => {
  try {
    // ── Auth
    const token = req.session?.token;
    if (!token) {
      logger.error(`[campaign] No LinkedIn token in session`);
      return res.status(StatusCodes.UNAUTHORIZED).json({
        success: false,
        error: MESSAGES.UNAUTHORIZED,
      });
    }

    // ── Get board IDs from config (lazy load at request time)
    const config = getConfig();
    const MONDAY_CAMPAIGN_BOARD_ID = config.MONDAY_CAMPAIGN_BOARD_ID;
    const MONDAY_CREATIVES_BOARD_ID = config.MONDAY_CREATIVES_BOARD_ID;

    // ── Optional analytics date window
    const startDate = parseDateParam(req.query.startDate);
    const endDate = parseDateParam(req.query.endDate);
    const skipMonday = req.query.skipMonday === "true";

    if (startDate || endDate) {
      logger.info(
        `[campaign] Analytics date range: ` +
          `${startDate?.toISOString() ?? "default"} → ${endDate?.toISOString() ?? "today"}`,
      );
    }

    logger.info(`[campaign]  Starting LinkedIn Campaign Orchestration`);

    // ── STEP 1: Account
    logger.info(`[campaign] Step 1/6: Fetching account`);
    const accounts = await fetchAdAccounts(token);

    if (accounts.length === 0) {
      logger.warn(`[campaign] No ad accounts found`);
      return res.status(StatusCodes.OK).json({
        success: true,
        message: "No ad accounts found",
        data: null,
      });
    }

    const account = accounts[0];
    const formattedAccount = formatAccountInfo(account);
    const accountId = account.id;
    logger.info(`[campaign] Account: ${formattedAccount.name} (${accountId})`);

    // ── STEP 2 & 3: Campaign Groups + Ad Campaigns (parallel)
    logger.info(
      `[campaign] Step 2/6: Fetching campaign groups + ad campaigns (parallel)`,
    );
    const [rawCampaignGroups, rawAdCampaigns] = await Promise.all([
      fetchCampaignGroups(token, accountId).catch((err) => {
        logger.warn(`[campaign] Campaign groups fetch failed: ${err.message}`);
        return [];
      }),
      fetchAdCampaigns(token, accountId).catch((err) => {
        logger.warn(`[campaign] Ad campaigns fetch failed: ${err.message}`);
        return [];
      }),
    ]);

    const campaignGroups = rawCampaignGroups.map(formatCampaignGroupInfo);
    const adCampaigns = rawAdCampaigns.map(formatCampaignInfo);
    logger.info(
      `[campaign] ${campaignGroups.length} campaign group(s), ${adCampaigns.length} campaign(s)`,
    );

    // ── STEP 4: Map campaigns → groups
    logger.info(`[campaign] Step 3/6: Mapping campaigns to groups`);
    const campaignGroupMap = {};
    campaignGroups.forEach((group) => {
      campaignGroupMap[`urn:li:sponsoredCampaignGroup:${group.id}`] = {
        ...group,
        campaigns: [],
      };
    });
    adCampaigns.forEach((campaign) => {
      const key = campaign.campaignGroup;
      if (key && campaignGroupMap[key]) {
        campaignGroupMap[key].campaigns.push(campaign);
      }
    });
    const mappedCampaignGroups = Object.values(campaignGroupMap);
    logger.info(`[campaign] Campaigns mapped to groups`);

    // ── STEP 5: Fetch creatives for all campaigns (parallel)
    logger.info(`[campaign] Step 4/6: Fetching creatives (parallel)`);
    const allCreatives = await Promise.all(
      adCampaigns.map((campaign) =>
        fetchCreativesByCampaign(token, accountId, campaign.id).then(
          (creatives) => ({ campaignId: campaign.id, creatives }),
        ),
      ),
    );
    logger.info(`[campaign] Creatives fetched for all campaigns`);

    // ── STEP 5b: Fetch analytics (batched)
    logger.info(`[campaign] Step 5/6: Fetching analytics (batch)`);
    const campaignIds = adCampaigns.map((c) => c.id);
    const rawAnalytics = await fetchAnalyticsBatch(
      token,
      campaignIds,
      startDate,
      endDate,
    );
    const creativeAnalyticsMap = parseCreativeAnalytics(rawAnalytics);
    logger.info(
      `[campaign] Analytics fetched: ${Object.keys(creativeAnalyticsMap).length} creative(s) with data`,
    );

    // ── STEP 6: Assemble final structure
    logger.info(`[campaign] Step 6/6: Assembling response`);

    // Build a map: campaignId → { campaignId, creatives[] }
    const detailsMap = {};
    allCreatives.forEach(({ campaignId, creatives }) => {
      const creativesWithAnalytics = creatives.map((creative) => {
        const creativeInfo = formatCreativeInfo(creative);
        const normalizedId = normalizeCreativeId(creative.id);
        const rawData = normalizedId
          ? creativeAnalyticsMap[normalizedId] || {}
          : {};
        return {
          ...creativeInfo,
          analytics: formatAnalyticsInfo(rawData),
        };
      });
      detailsMap[campaignId] = {
        campaignId,
        creatives: creativesWithAnalytics,
      };
    });

    // Stitch creatives into the campaign group tree
    const finalCampaignGroups = mappedCampaignGroups.map((group) => ({
      ...group,
      campaigns: group.campaigns.map((campaign) => ({
        ...campaign,
        creatives: detailsMap[campaign.id]?.creatives || [],
        totalCreatives: detailsMap[campaign.id]?.creatives?.length || 0,
      })),
    }));

    const responseData = {
      account: formattedAccount,
      totalCampaignGroups: finalCampaignGroups.length,
      totalAdCampaigns: adCampaigns.length,
      campaignGroups: finalCampaignGroups,
    };

    logger.info(`[campaign] LinkedIn data assembled`);

    // ── STEP 7: Push to Monday.com
    // Called directly here — no separate HTTP call, no body-parsing issues.
    let mondaySummary = null;

    if (skipMonday) {
      logger.info(`[campaign] Monday push skipped (?skipMonday=true)`);
    } else {
      logger.info(`[campaign] Pushing to Monday.com boards...`);
      try {
        mondaySummary = await pushLinkedInDataToMondayBoards(responseData);
        logger.info(
          `[campaign]  Monday push done — ` +
            `${mondaySummary.campaignItemsCreated} campaigns, ` +
            `${mondaySummary.creativeItemsCreated} creatives pushed`,
        );
      } catch (mondayErr) {
        // Monday push failure should NOT fail the whole request — LinkedIn data
        // is still valid. Log it and include the error in the response.
        logger.error(`[campaign] Monday push failed: ${mondayErr.message}`);
        mondaySummary = { error: mondayErr.message };
      }
    }

    return res.status(StatusCodes.OK).json({
      success: true,
      message: MESSAGES.OK,
      data: responseData,
      monday: mondaySummary
        ? {
            pushed: !mondaySummary.error,
            summary: mondaySummary,
          }
        : { pushed: false, skipped: true },
    });
  } catch (err) {
    logger.error(`[campaign] Orchestration error: ${err.message}`);
    logger.error(`[campaign] Stack: ${err.stack}`);
    return res
      .status(err.statusCode || StatusCodes.INTERNAL_SERVER_ERROR)
      .json({
        success: false,
        error: err.message || MESSAGES.INTERNAL_SERVER_ERROR,
      });
  }
};
