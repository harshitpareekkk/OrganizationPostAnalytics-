import mondaySdk from "monday-sdk-js";
import { logger } from "../utils/logger.js";

const monday = mondaySdk();

// ─── GraphQL helper
const gql = async (token, query, variables = {}) => {
  try {
    logger.info(`[gql] Validating token...`);
    if (!token || typeof token !== "string" || token.length === 0) {
      logger.error(`[gql] Invalid token provided - empty or not a string`);
      throw new Error("Invalid token: must be a non-empty string");
    }
    logger.info(`[gql] Token validation passed`);

    logger.info(`[gql] Setting Monday token...`);
    monday.setToken(token);
    logger.info(`[gql] Token set successfully`);

    logger.info(`[gql] Executing Monday API query with apiVersion: 2023-10`);
    const res = await monday.api(query, {
      token,
      variables,
      apiVersion: "2023-10",
    });

    logger.info(`[gql] API response received`);

    if (res.errors?.length) {
      const errorDetails = res.errors.map((e) => ({
        message: e.message,
        statusCode: e.statusCode,
        errorCode: e.errorCode,
      }));
      logger.error(
        `[gql] Monday API returned ${res.errors.length} error(s): ${JSON.stringify(errorDetails)}`,
      );
      const msg = res.errors.map((e) => e.message).join(" | ");
      throw new Error(`Monday API error: ${msg}`);
    }

    logger.info(`[gql] Query executed successfully`);
    return res.data;
  } catch (err) {
    logger.error(`[gql] GraphQL execution failed: ${err.message}`);
    throw err;
  }
};

export const testMondayAccess = async (token, boardId) => {
  const query = `query { boards(ids: [${boardId}]) { id name } }`;
  try {
    logger.info(
      `[testMondayAccess] Starting board access test for boardId: ${boardId}`,
    );

    if (!token || typeof token !== "string") {
      logger.error(`[testMondayAccess] Invalid token for board access test`);
      throw new Error("Invalid token provided to testMondayAccess");
    }
    logger.info(`[testMondayAccess] Token validation passed`);

    logger.info(
      `[testMondayAccess] Executing GraphQL query to test board access`,
    );
    const data = await gql(token, query);

    const board = data?.boards?.[0];
    if (!board) {
      logger.error(
        `[testMondayAccess] Board ${boardId} returned no data - may not exist or token lacks permissions`,
      );
      throw new Error(`Board ${boardId} not accessible with provided token`);
    }

    logger.info(
      `[testMondayAccess] ✓ Board access confirmed | boardId: ${board.id} | boardName: ${board.name}`,
    );
    return board;
  } catch (err) {
    logger.error(
      `[testMondayAccess] ✗ Token/board access test FAILED: ${err.message}`,
    );
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

  try {
    logger.info(
      `[fetchBoardColumns] Starting column fetch for boardId: ${boardId}`,
    );
    const data = await gql(token, query);

    const board = data?.boards?.[0];
    if (!board) {
      logger.error(
        `[fetchBoardColumns] Board ${boardId} not found in response - token may lack permissions`,
      );
      throw new Error(
        `Board "${boardId}" not found. Check MONDAY_BOARD_ID and that the token has access to this board.`,
      );
    }

    const columns = board.columns || [];
    const columnMap = {}; // { "column title lowercased" → columnId }

    logger.info(
      `[fetchBoardColumns] ✓ Board loaded: "${board.name}" with ${columns.length} columns`,
    );

    for (const col of columns) {
      const key = col.title.toLowerCase().trim();
      columnMap[key] = col.id;
      logger.debug(
        `[fetchBoardColumns] Column: ${col.title} (type: ${col.type}, id: ${col.id})`,
      );
    }

    return { columns, columnMap };
  } catch (err) {
    logger.error(`[fetchBoardColumns] ✗ Column fetch failed: ${err.message}`);
    throw err;
  }
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
  try {
    const itemName = String(
      postObj.details?.postId || postObj.postId || "unknown",
    );
    const columnValuesStr = buildColumnValues(
      postObj,
      columnMap,
      columns,
      false,
    );

    logger.info(`[createBoardItem] Starting creation for: ${itemName}`);
    logger.info(`[createBoardItem] Board ID: ${boardId}`);
    logger.info(`[createBoardItem] Column values: ${columnValuesStr}`);

    const query = `
      mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
        create_item(
          board_id:      $boardId
          item_name:     $itemName
          column_values: $columnValues
        ) { id name }
      }
    `;

    logger.info(`[createBoardItem] Executing create_item mutation`);
    const data = await gql(token, query, {
      boardId: String(boardId),
      itemName,
      columnValues: columnValuesStr,
    });

    const itemId = data?.create_item?.id;
    if (!itemId) {
      logger.error(
        `[createBoardItem] Mutation returned no item ID - check board permissions`,
      );
      throw new Error("create_item returned no id — check board permissions");
    }

    logger.info(`[createBoardItem] ✓ Board item created: ${itemId}`);
    return String(itemId);
  } catch (err) {
    logger.error(`[createBoardItem] ✗ Item creation failed: ${err.message}`);
    throw err;
  }
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
  try {
    const columnValuesStr = buildColumnValues(
      { analytics, details: {} },
      columnMap,
      columns,
      true, // analyticsOnly = true
    );

    logger.info(`[updateBoardItem] Starting update for itemId: ${itemId}`);
    logger.info(`[updateBoardItem] Board ID: ${boardId}`);
    logger.info(`[updateBoardItem] Column values: ${columnValuesStr}`);

    const query = `
      mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
        change_multiple_column_values(
          board_id:      $boardId
          item_id:       $itemId
          column_values: $columnValues
        ) { id name }
      }
    `;

    logger.info(
      `[updateBoardItem] Executing change_multiple_column_values mutation`,
    );
    const data = await gql(token, query, {
      boardId: String(boardId),
      itemId: String(itemId),
      columnValues: columnValuesStr,
    });

    const updatedId = data?.change_multiple_column_values?.id;
    if (!updatedId) {
      logger.error(`[updateBoardItem] Mutation returned no item ID`);
      throw new Error("change_multiple_column_values returned no id");
    }

    logger.info(`[updateBoardItem] ✓ Board item updated: ${itemId}`);
    return updatedId;
  } catch (err) {
    logger.error(`[updateBoardItem] ✗ Item update failed: ${err.message}`);
    throw err;
  }
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
    logger.info(
      `[findBoardItemByPostId] Searching for post ${postId} in boardId ${boardId}`,
    );
    const data = await gql(token, query);

    const items = data?.boards?.[0]?.items_page?.items || [];
    logger.info(`[findBoardItemByPostId] Found ${items.length} items on board`);

    const match = items.find(
      (item) =>
        item.name === String(postId) || item.name?.includes(String(postId)),
    );

    if (match) {
      logger.info(
        `[findBoardItemByPostId] ✓ Found board item for post ${postId}: ${match.id}`,
      );
      return String(match.id);
    }
    logger.info(
      `[findBoardItemByPostId] No board item found for post ${postId}`,
    );
    return null;
  } catch (err) {
    logger.error(
      `[findBoardItemByPostId] ✗ Error searching for board item: ${err.message}`,
    );
    return null;
  }
};
