import mondaySdk from "monday-sdk-js";
import { logger } from "../utils/logger.js";

const monday = mondaySdk();

// ─── GraphQL helper
const gql = async (token, query, variables = {}) => {
  monday.setToken(token);
  const res = await monday.api(query, {
    token,
    variables,
    apiVersion: "2023-10",
  });

  if (res.errors?.length) {
    const msg = res.errors.map((e) => e.message).join(" | ");
    throw new Error(`Monday API error: ${msg}`);
  }

  return res.data;
};

export const testMondayAccess = async (token, boardId) => {
  const query = `query { boards(ids: [${boardId}]) { id name } }`;
  try {
    const data = await gql(token, query);
    const board = data?.boards?.[0];
    logger.info(`[board] Token valid, board access confirmed`);
    return board;
  } catch (err) {
    logger.error(`[board] Token/board access test failed: ${err.message}`);
    throw err;
  }
};

// ─── Post type → Monday status index
const POST_TYPE_INDEX = {
  IMAGE: 0,
  DOCUMENT: 1,
  VIDEO: 2,
  TEXT: 3,
  RICH: 4,
  ARTICLE: 6,
};

const toStatusValue = (postType) => {
  const index = POST_TYPE_INDEX[(postType || "").toUpperCase()];
  return index !== undefined ? { index } : null;
};

// Format a value for its column type

const formatValue = (value, colType) => {
  if (value === null || value === undefined || value === "") return null;

  switch (colType) {
    case "numeric": {
      const num = typeof value === "number" ? value : parseFloat(value);
      if (isNaN(num)) return "0";
      // Keep up to 2 decimal places, strip trailing zeros
      return String(Math.round(num * 100) / 100);
    }

    case "status":
      // Must be { index: N } — NEVER a plain string like "RICH"
      return toStatusValue(value);

    case "link":
      return { url: String(value), text: String(value) };

    case "date": {
      const d = String(value).split("T")[0];
      return d ? { date: d } : null;
    }

    case "long_text":
      return { text: String(value) };

    case "text":
    default:
      return String(value);
  }
};

// Fetch board columns
export const fetchBoardColumns = async (token, boardId) => {
  const query = `
    query {
      boards(ids: [${boardId}]) {
        id
        name
        columns {
          id
          title
          type
        }
      }
    }
  `;

  const data = await gql(token, query);
  const board = data?.boards?.[0];
  if (!board) {
    throw new Error(
      `Board "${boardId}" not found. Check MONDAY_BOARD_ID and that the token has access to this board.`,
    );
  }

  const columns = board.columns || [];
  const columnMap = {}; // { "column title lowercased" → columnId }

  logger.info(
    `[board] Board loaded: "${board.name}" with ${columns.length} columns`,
  );
  for (const col of columns) {
    const key = col.title.toLowerCase().trim();
    columnMap[key] = col.id;
  }

  return { columns, columnMap };
};

// Build column_values

const buildPostedBy = (details) => {
  const name = (details.authorName || "").trim();
  const id = (details.authorId || "").trim();
  if (!name && !id) return "";
  if (name && id && name !== id) return `${name} (${id})`;
  return name || id;
};

/**
 * @param {object}  postObj       - { details, analytics }
 * @param {object}  columnMap     - { "title lowercased" → columnId }  from fetchBoardColumns
 * @param {Array}   columns       - [{ id, title, type }]              from fetchBoardColumns
 * @param {boolean} analyticsOnly - true on update runs — skip static metadata columns
 */
export const buildColumnValues = (
  postObj,
  columnMap = {},
  columns = [],
  analyticsOnly = false,
) => {
  const analytics = postObj.analytics || {};
  const details = postObj.details || {};

  // columnId → type  (from live board fetch, so formatting is always correct)
  const colTypeMap = {};
  for (const col of columns) colTypeMap[col.id] = col.type;

  const allMappings = [
    // Analytics — updated every sync run
    {
      title: "impressions",
      value: analytics.impressionCount ?? 0,
      hintType: "numeric",
      isAnalytics: true,
    },
    {
      title: "unique impressions",
      value: analytics.uniqueImpressionsCount ?? 0,
      hintType: "numeric",
      isAnalytics: true,
    },
    {
      title: "likes",
      value: analytics.likeCount ?? 0,
      hintType: "numeric",
      isAnalytics: true,
    },
    {
      title: "comments",
      value: analytics.commentCount ?? 0,
      hintType: "numeric",
      isAnalytics: true,
    },
    {
      title: "shares",
      value: analytics.shareCount ?? 0,
      hintType: "numeric",
      isAnalytics: true,
    },
    {
      title: "clicks",
      value: analytics.clickCount ?? 0,
      hintType: "numeric",
      isAnalytics: true,
    },
    {
      title: "engagement rate",
      value: analytics.engagement ?? 0,
      hintType: "numeric",
      isAnalytics: true,
    },
    {
      title: "ctr",
      value: analytics.ctr ?? 0,
      hintType: "numeric",
      isAnalytics: true,
    },

    // Static metadata — written on create only, never overwritten on update
    {
      title: "posted by",
      value: buildPostedBy(details),
      hintType: "text",
      isAnalytics: false,
    },
    {
      title: "post url",
      value: details.postUrl || null,
      hintType: "link",
      isAnalytics: false,
    },
    {
      title: "post type",
      value: details.postType || null,
      hintType: "status",
      isAnalytics: false,
    },
    {
      title: "post date",
      value: details.createdAt || null,
      hintType: "date",
      isAnalytics: false,
    },
    {
      title: "post description",
      value: details.text || "",
      hintType: "long_text",
      isAnalytics: false,
    },
  ];

  // Hardcoded column ID safety net — always applied for analytics
  // These match the specific board's numeric column IDs
  const payload = {
    numeric_mkzwxzqk: String(analytics.impressionCount ?? 0),
    numeric_mkzw50bn: String(analytics.uniqueImpressionsCount ?? 0),
    numeric_mkzwsay8: String(analytics.likeCount ?? 0),
    numeric_mkzwwst3: String(analytics.commentCount ?? 0),
    numeric_mkzw9bxf: String(analytics.shareCount ?? 0),
    numeric_mkzwx7en: String(analytics.clickCount ?? 0),
  };

  // Apply dynamic title-based mappings (overrides hardcoded if same column)
  for (const { title, value, hintType, isAnalytics } of allMappings) {
    if (analyticsOnly && !isAnalytics) continue;

    const colId = columnMap[title];
    if (!colId) {
      if (!analyticsOnly) {
        logger.warn(`[board] Column not found on board: "${title}"`);
      }
      continue;
    }

    const actualType = colTypeMap[colId] || hintType;
    const formatted = formatValue(value, actualType);
    if (formatted !== null) payload[colId] = formatted;
  }

  return JSON.stringify(payload);
};

// Create board item
export const createBoardItem = async (
  token,
  postObj,
  columnMap,
  columns,
  boardId,
) => {
  const itemName = String(
    postObj.details?.postId || postObj.postId || "unknown",
  );
  const columnValuesStr = buildColumnValues(postObj, columnMap, columns, false);

  logger.info(`[board] Creating board item: ${itemName}`);

  const query = `
    mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_item(
        board_id:      $boardId
        item_name:     $itemName
        column_values: $columnValues
      ) { id name }
    }
  `;

  const data = await gql(token, query, {
    boardId: String(boardId),
    itemName,
    columnValues: columnValuesStr,
  });
  const itemId = data?.create_item?.id;
  if (!itemId)
    throw new Error("create_item returned no id — check board permissions");

  logger.info(`[board] Board item created: ${itemId}`);
  return String(itemId);
};

// ─── Update board item (analytics only)
export const updateBoardItem = async (
  token,
  itemId,
  analytics,
  columnMap,
  columns,
  boardId,
) => {
  const columnValuesStr = buildColumnValues(
    { analytics, details: {} },
    columnMap,
    columns,
    true, // analyticsOnly = true
  );

  logger.info(`[board] Updating board item analytics: ${itemId}`);

  const query = `
    mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(
        board_id:      $boardId
        item_id:       $itemId
        column_values: $columnValues
      ) { id name }
    }
  `;

  const data = await gql(token, query, {
    boardId: String(boardId),
    itemId: String(itemId),
    columnValues: columnValuesStr,
  });

  logger.info(`[board] Board item updated: ${itemId}`);
  return data?.change_multiple_column_values?.id;
};

// ─── Find board item by postId
export const findBoardItemByPostId = async (token, postId, boardId) => {
  const query = `
    query {
      boards(ids: [${boardId}]) {
        items_page(limit: 500) {
          items { id name }
        }
      }
    }
  `;

  try {
    const data = await gql(token, query);
    const items = data?.boards?.[0]?.items_page?.items || [];
    const match = items.find(
      (item) =>
        item.name === String(postId) || item.name?.includes(String(postId)),
    );

    if (match) {
      logger.info(`[board] Found board item for post ${postId}`);
      return String(match.id);
    }
    logger.info(`[board] No board item found for post ${postId}`);
    return null;
  } catch (err) {
    logger.error(`[board] Error searching for board item: ${err.message}`);
    return null;
  }
};
