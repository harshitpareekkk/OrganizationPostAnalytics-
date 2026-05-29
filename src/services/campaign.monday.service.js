import axios from "axios";
import { logger } from "../utils/logger.js";
import { getConfig } from "../constants/env.constants.js";
import { API_ENDPOINTS } from "../constants/api.constants.js";
import { getMondayHeaders } from "../constants/headers.constants.js";
import {
  CAMPAIGN_STATUS_MAP,
  REQUEST_TIMEOUTS,
} from "../constants/app.constants.js";

const MONDAY_API_URL = API_ENDPOINTS.MONDAY.BASE;

// ─── Lazy axios instance (reads API key at call time, not module load) ────────
const getMondayApi = () => {
  const config = getConfig();
  const MONDAY_API_KEY = config.MONDAY_API_KEY;
  if (!MONDAY_API_KEY || MONDAY_API_KEY.trim() === "") {
    throw new Error(
      "MONDAY_API_KEY is missing or empty. Set it in your .env file.",
    );
  }
  return axios.create({
    baseURL: MONDAY_API_URL,
    headers: getMondayHeaders(MONDAY_API_KEY),
    timeout: REQUEST_TIMEOUTS.EXTENDED,
  });
};

// ─── Board IDs (read lazily at call time, never at module load) ───────────────
const getBoardIds = () => {
  const config = getConfig();
  const campaignBoardId = config.MONDAY_CAMPAIGN_BOARD_ID;
  const creativesBoardId = config.MONDAY_CREATIVES_BOARD_ID;
  if (!campaignBoardId || !creativesBoardId) {
    const missing = [
      !campaignBoardId && "MONDAY_CAMPAIGN_BOARD_ID",
      !creativesBoardId && "MONDAY_CREATIVES_BOARD_ID",
    ]
      .filter(Boolean)
      .join(", ");
    throw new Error(`Missing environment variable(s): ${missing}`);
  }
  return { campaignBoardId, creativesBoardId };
};

// ─── GraphQL error check ──────────────────────────────────────────────────────
const checkGraphQLErrors = (responseData, context) => {
  if (responseData?.errors?.length) {
    const msg = responseData.errors.map((e) => e.message).join("; ");
    logger.error(`[monday] GraphQL error in ${context}: ${msg}`);
    throw new Error(`Monday.com API error (${context}): ${msg}`);
  }
};

// ─── Fetch all columns for a board ───────────────────────────────────────────
async function fetchBoardColumns(boardId) {
  const query = `
    query($boardId: [ID!]) {
      boards(ids: $boardId) {
        columns { id title type }
      }
    }
  `;
  const res = await getMondayApi().post("", {
    query,
    variables: { boardId: [String(boardId)] },
  });
  checkGraphQLErrors(res.data, `fetchBoardColumns(${boardId})`);
  const columns = res.data?.data?.boards?.[0]?.columns || [];
  logger.info(
    `[monday] Board ${boardId} columns: ${columns.map((c) => `"${c.title}"(${c.id}:${c.type})`).join(", ")}`,
  );
  return columns;
}

// ─── Build title→{id,type} map (case-insensitive keys) ───────────────────────
const buildColumnMap = (columns) => {
  const map = {};
  for (const col of columns) {
    map[col.title.toLowerCase().trim()] = { id: col.id, type: col.type };
  }
  return map;
};

const mapCampaignStatus = (status) => {
  if (!status) return null;
  const upper = status.toUpperCase();
  if (upper in CAMPAIGN_STATUS_MAP) {
    return CAMPAIGN_STATUS_MAP[upper]; // may be a string label
  }
  logger.warn(
    `[monday] Unrecognised campaign status "${status}" — status column will be blank`,
  );
  return null;
};

// ─── Format a value for a Monday column type ──────────────────────────────────
//
//  numbers / numeric → raw JS number, including 0.
//                      Zero is now sent explicitly so the cell shows "0"
//                      instead of being left blank.
//
//  status            → { label: "VALUE" } — label must exist in the board.
//
//  date              → { date: "YYYY-MM-DD" }
//
//  text / long_text  → plain string
//
//  link              → { url, text }
//
const formatForColumn = (value, type) => {
  if (value === null || value === undefined || value === "") return null;

  switch (type) {
    case "numbers":
    case "numeric": {
      const n = typeof value === "number" ? value : parseFloat(value);
      // ✅ Send 0 explicitly — Monday will display "0" in the cell.
      // (Previously zero was skipped; now the user wants 0 to be filled.)
      return isNaN(n) ? null : n;
    }

    case "status":
      if (!value) return null;
      return { label: String(value) };

    case "date": {
      const d = String(value).split("T")[0];
      return d ? { date: d } : null;
    }

    case "link":
      return { url: String(value), text: String(value) };

    case "long_text":
      return { text: String(value) };

    case "text":
    default:
      return String(value);
  }
};

// ─── Build column_values payload from a field map
// fieldMap: { "column title": rawValue }
// columnMap: built by buildColumnMap()
// Returns a plain JS object — JSON.stringify()'d inside createItem().
const buildPayload = (fieldMap, columnMap) => {
  const payload = {};
  for (const [titleKey, rawValue] of Object.entries(fieldMap)) {
    if (rawValue === null || rawValue === undefined) continue;

    const col = columnMap[titleKey.toLowerCase().trim()];
    if (!col) {
      logger.warn(
        `[monday] Column not found on board: "${titleKey}" — skipping`,
      );
      continue;
    }

    const formatted = formatForColumn(rawValue, col.type);
    if (formatted !== null && formatted !== undefined) {
      payload[col.id] = formatted;
    }
  }
  return payload;
};

// ─── ensureGroup
export async function ensureGroup(boardId, groupName) {
  const query = `
    mutation createGroup($boardId: ID!, $groupName: String!) {
      create_group(board_id: $boardId, group_name: $groupName) { id }
    }
  `;
  const variables = { boardId: String(boardId), groupName: String(groupName) };

  logger.info(`[monday] Creating group "${groupName}" on board ${boardId}`);
  const res = await getMondayApi().post("", { query, variables });
  checkGraphQLErrors(res.data, "ensureGroup");

  const groupId = res.data?.data?.create_group?.id;
  if (!groupId) {
    throw new Error(`Failed to create group "${groupName}" — no ID returned`);
  }
  logger.info(`[monday] Group "${groupName}" created with id=${groupId}`);
  return groupId;
}

// createItem
// Monday's JSON! GraphQL variable type requires column_values to be sent as a
// JSON *string* (JSON.stringify'd), not a plain object.

export async function createItem(boardId, groupId, itemName, columnValues) {
  const query = `
    mutation createItem(
      $boardId: ID!,
      $groupId: String!,
      $itemName: String!,
      $colVals: JSON!
    ) {
      create_item(
        board_id: $boardId,
        group_id: $groupId,
        item_name: $itemName,
        column_values: $colVals
      ) { id }
    }
  `;

  const variables = {
    boardId: String(boardId),
    groupId: String(groupId),
    itemName: String(itemName || "Unnamed").slice(0, 255),
    colVals: JSON.stringify(columnValues),
  };

  logger.info(
    `[monday] Creating item "${itemName}" on board ${boardId} / group ${groupId}`,
  );
  const res = await getMondayApi().post("", { query, variables });
  checkGraphQLErrors(res.data, "createItem");

  const itemId = res.data?.data?.create_item?.id;
  if (!itemId) {
    logger.error(
      `[monday] createItem unexpected response: ${JSON.stringify(res.data)}`,
    );
    throw new Error(`Failed to create item "${itemName}" — no ID returned`);
  }
  logger.info(`[monday] Item "${itemName}" created with id=${itemId}`);
  return itemId;
}

//  aggregateAnalytics
export function aggregateAnalytics(creatives = []) {
  const agg = {
    impressions: 0,
    clicks: 0,
    spend: 0,
    lp_clicks: 0,
    likes: 0,
    shares: 0,
    video_views: 0,
    conversions: 0,
    lead_gen: 0,
    reach: 0,
  };
  for (const c of creatives) {
    const a = c.analytics || {};
    agg.impressions += a.impressions || 0;
    agg.clicks += a.clicks || 0;
    agg.spend += a.costInLocalCurrency || 0;
    agg.lp_clicks += a.landingPageClicks || 0;
    agg.likes += a.likes || 0;
    agg.shares += a.shares || 0;
    agg.video_views += a.videoViews || 0;
    agg.conversions += a.externalWebsiteConversions || 0;
    agg.lead_gen += a.leadGenerationMailContactInfoShares || 0;
    agg.reach += a.approximateMemberReach || 0;
  }
  return agg;
}

// ─── buildCampaignFields
// { "Exact Monday Column Title": value } for Board 1 (LinkedIn Campaigns).
// Titles are lowercased in buildPayload() for case-insensitive matching.
//
function buildCampaignFields(campaign, group, accountId, agg) {
  const startDate = campaign.runSchedule?.start
    ? new Date(campaign.runSchedule.start).toISOString().split("T")[0]
    : null;
  const endDate = campaign.runSchedule?.end
    ? new Date(campaign.runSchedule.end).toISOString().split("T")[0]
    : null;

  const mappedStatus = mapCampaignStatus(campaign.status);

  return {
    // ── Identity (text)
    "campaign id": String(campaign.id || ""),
    "campaign group id": String(group.id || ""),
    "campaign group name": String(group.name || ""),
    account: String(accountId || ""),
    "objective type": String(campaign.objectiveType || ""),
    "serving status": (campaign.servingStatuses || []).join(", "),
    backfilled: campaign.backfilled ? "Yes" : "No",

    // ── Status — only include when we have a recognised label
    ...(mappedStatus ? { "campaign status": mappedStatus } : {}),

    // ── Counts + aggregated analytics (numeric — 0 is now sent explicitly)
    "total campaign creatives": campaign.creatives?.length ?? 0,
    impressions: agg.impressions,
    clicks: agg.clicks,
    "cost-in local currency": parseFloat((agg.spend || 0).toFixed(2)),
    "landing page clicks": agg.lp_clicks,
    likes: agg.likes,
    shares: agg.shares,
    "video views": agg.video_views,
    "approximate member reach": agg.reach,
    conversions: agg.conversions,
    "lead gen": agg.lead_gen,

    // ── Dates
    ...(startDate ? { "start date": startDate } : {}),
    ...(endDate ? { "end date": endDate } : {}),
  };
}

// ─── buildCreativeFields
// { "Exact Monday Column Title": value } for Board 2 (LinkedIn Creatives).
//
function buildCreativeFields(creative, campaign, group, accountId) {
  const a = creative.analytics || {};

  const analyticsStart = a.dateRange?.start
    ? `${a.dateRange.start.year}-${String(a.dateRange.start.month).padStart(2, "0")}-${String(a.dateRange.start.day).padStart(2, "0")}`
    : null;

  const analyticsEnd = a.dateRange?.end
    ? `${a.dateRange.end.year}-${String(a.dateRange.end.month).padStart(2, "0")}-${String(a.dateRange.end.day).padStart(2, "0")}`
    : null;

  return {
    // ── Identity (text)
    "creative id": String(creative.id || ""),
    "campaign name": String(campaign.name || ""),
    "campaign id": String(campaign.id || ""),
    "account id": String(accountId || ""),

    // ── Analytics (numeric — 0 is now sent explicitly so cells show "0")
    impressions: a.impressions ?? 0,
    clicks: a.clicks ?? 0,
    "cost-in local currency": parseFloat(
      (a.costInLocalCurrency ?? 0).toFixed(2),
    ),
    "landing page clicks": a.landingPageClicks ?? 0,
    likes: a.likes ?? 0,
    shares: a.shares ?? 0,
    "video views": a.videoViews ?? 0,
    "approximate member reach": a.approximateMemberReach ?? 0,
    conversions: a.externalWebsiteConversions ?? 0,
    "lead gen": a.leadGenerationMailContactInfoShares ?? 0,

    // ── Dates
    ...(analyticsStart ? { "analytics start date": analyticsStart } : {}),
    ...(analyticsEnd ? { "analytics end date": analyticsEnd } : {}),
  };
}

// ─── pushLinkedInDataToMondayBoards
//
// Called directly from campaignAccountFetch.controller after LinkedIn data is
// assembled. No separate HTTP call needed — runs in the same process.
//
// Board 1 (Campaigns):  Group = Campaign Group Name  │  Item = Campaign
// Board 2 (Creatives):  Group = Campaign Name        │  Item = Creative
//
export async function pushLinkedInDataToMondayBoards(linkedInData) {
  const { account, campaignGroups = [] } = linkedInData;
  const accountId = account?.id;
  const { campaignBoardId, creativesBoardId } = getBoardIds();

  logger.info(`[monday] Starting Monday.com board push`);
  logger.info(`[monday] Board 1 (Campaigns): ${campaignBoardId}`);
  logger.info(`[monday] Board 2 (Creatives): ${creativesBoardId}`);
  logger.info(`[monday] Account: ${account?.name} (${accountId})`);
  logger.info(`[monday] Campaign groups: ${campaignGroups.length}`);

  // Fetch real column IDs from both boards at runtime
  logger.info(`[monday] Fetching column definitions...`);
  const [campaignColumns, creativesColumns] = await Promise.all([
    fetchBoardColumns(campaignBoardId),
    fetchBoardColumns(creativesBoardId),
  ]);
  const campaignColumnMap = buildColumnMap(campaignColumns);
  const creativesColumnMap = buildColumnMap(creativesColumns);

  logger.info(
    `[monday] Campaign board: ${Object.keys(campaignColumnMap).length} column(s)`,
  );
  logger.info(
    `[monday] Creatives board: ${Object.keys(creativesColumnMap).length} column(s)`,
  );

  const summary = {
    groupsOnCampaignBoard: 0,
    campaignItemsCreated: 0,
    groupsOnCreativesBoard: 0,
    creativeItemsCreated: 0,
    skippedCreativeGroups: 0,
    errors: [],
  };

  // ── BOARD 1: Campaigns
  logger.info(`[monday] Step 1/2: Pushing campaigns to Board 1`);

  for (const group of campaignGroups) {
    let campaignGroupId;
    try {
      campaignGroupId = await ensureGroup(campaignBoardId, group.name);
      summary.groupsOnCampaignBoard++;
    } catch (err) {
      const msg = `Campaign group "${group.name}": ${err.message}`;
      logger.error(`[monday] ${msg}`);
      summary.errors.push(msg);
      continue;
    }

    for (const campaign of group.campaigns || []) {
      try {
        const agg = aggregateAnalytics(campaign.creatives || []);
        const fields = buildCampaignFields(campaign, group, accountId, agg);
        const colVals = buildPayload(fields, campaignColumnMap);

        logger.info(
          `[monday] Campaign "${campaign.name}" → payload keys: ${Object.keys(colVals).join(", ")}`,
        );

        await createItem(
          campaignBoardId,
          campaignGroupId,
          campaign.name,
          colVals,
        );
        summary.campaignItemsCreated++;
      } catch (err) {
        const msg = `Campaign item "${campaign.name}": ${err.message}`;
        logger.error(`[monday] ${msg}`);
        summary.errors.push(msg);
      }
    }

    logger.info(
      `[monday] Board1 | "${group.name}" created with ${group.campaigns?.length ?? 0} campaign(s)`,
    );
  }

  // ── BOARD 2: Creatives
  logger.info(`[monday] Step 2/2: Pushing creatives to Board 2`);

  for (const group of campaignGroups) {
    for (const campaign of group.campaigns || []) {
      if (!campaign.creatives || campaign.creatives.length === 0) {
        logger.info(
          `[monday] Skipping Board2 group for "${campaign.name}" (no creatives)`,
        );
        summary.skippedCreativeGroups++;
        continue;
      }

      let creativeGroupId;
      try {
        creativeGroupId = await ensureGroup(creativesBoardId, campaign.name);
        summary.groupsOnCreativesBoard++;
      } catch (err) {
        const msg = `Creatives group for "${campaign.name}": ${err.message}`;
        logger.error(`[monday] ${msg}`);
        summary.errors.push(msg);
        continue;
      }

      for (const creative of campaign.creatives) {
        try {
          const fields = buildCreativeFields(
            creative,
            campaign,
            group,
            accountId,
          );
          const colVals = buildPayload(fields, creativesColumnMap);

          logger.info(
            `[monday] Creative "${creative.name}" has payload keys: ${Object.keys(colVals).join(", ")}`,
          );

          await createItem(
            creativesBoardId,
            creativeGroupId,
            creative.name || String(creative.id),
            colVals,
          );
          summary.creativeItemsCreated++;
        } catch (err) {
          const msg = `Creative "${creative.name}" in "${campaign.name}": ${err.message}`;
          logger.error(`[monday] ${msg}`);
          summary.errors.push(msg);
        }
      }

      logger.info(
        `[monday] Board2 | "${campaign.name}" has ${campaign.creatives.length} creative(s)`,
      );
    }
  }
  logger.info(
    `[monday] Push completed: ` +
      `${summary.campaignItemsCreated} campaigns, ` +
      `${summary.creativeItemsCreated} creatives pushed. ` +
      `Errors: ${summary.errors.length}`,
  );
  if (summary.errors.length > 0) {
    logger.warn(`[monday] Errors: ${JSON.stringify(summary.errors)}`);
  }
  return summary;
}
