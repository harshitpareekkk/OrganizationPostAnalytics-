import axios from "axios";
import { logger } from "../utils/logger.js";

// ─── Use axios directly against Monday's REST/GraphQL endpoint ────────────────
// The monday-sdk-js sets token globally which causes race conditions when
// multiple requests run concurrently. axios + per-request headers is safer.
const MONDAY_API_URL = "https://api.monday.com/v2";
const MONDAY_API_VERSION = "2024-10"; // Updated from stale 2023-10

// ─── GraphQL helper ───────────────────────────────────────────────────────────
const gql = async (token, query, variables = {}) => {
  if (!token || typeof token !== "string" || token.length === 0) {
    logger.error(`[gql] ✗ Invalid token — empty or not a string`);
    throw new Error("Invalid token: must be a non-empty string");
  }

  logger.info(`[gql] Executing Monday API query`);

  try {
    const res = await axios.post(
      MONDAY_API_URL,
      { query, variables },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: token, // Monday accepts raw token (no "Bearer" prefix)
          "API-Version": MONDAY_API_VERSION,
        },
        timeout: 30000,
      },
    );

    const body = res.data;

    if (body.errors?.length) {
      const msgs = body.errors.map((e) => e.message).join(" | ");
      logger.error(`[gql] Monday API error(s): ${msgs}`);
      throw new Error(`Monday API error: ${msgs}`);
    }

    logger.info(`[gql] ✓ Query executed successfully`);
    return body.data;
  } catch (err) {
    // Enrich axios HTTP errors with status code for better debugging
    if (err.response) {
      logger.error(
        `[gql] HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`,
      );
      throw new Error(
        `Monday API HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`,
      );
    }
    logger.error(`[gql] GraphQL execution failed: ${err.message}`);
    throw err;
  }
};

// ─── Test board access ────────────────────────────────────────────────────────
export const testMondayAccess = async (token, boardId) => {
  // boardId must be an integer in the GraphQL query — sanitise it
  const safeBoardId = parseInt(boardId, 10);
  if (isNaN(safeBoardId)) {
    throw new Error(`Invalid boardId: "${boardId}" is not a number`);
  }

  const query = `query { boards(ids: [${safeBoardId}]) { id name } }`;

  try {
    logger.info(
      `[testMondayAccess] Testing board access for boardId: ${safeBoardId}`,
    );

    if (!token || typeof token !== "string") {
      throw new Error("Invalid token provided to testMondayAccess");
    }

    const data = await gql(token, query);
    const board = data?.boards?.[0];

    if (!board) {
      throw new Error(
        `Board ${safeBoardId} not accessible — check MONDAY_BOARD_ID and token permissions`,
      );
    }

    logger.info(
      `[testMondayAccess] ✓ Board confirmed | id: ${board.id} | name: ${board.name}`,
    );
    return board;
  } catch (err) {
    logger.error(`[testMondayAccess] ✗ FAILED: ${err.message}`);
    throw err;
  }
};

// ─── Post type → Monday status index ─────────────────────────────────────────
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

// ─── Format a value for its column type ──────────────────────────────────────
const formatValue = (value, colType) => {
  if (value === null || value === undefined || value === "") return null;

  switch (colType) {
    case "numeric": {
      const num = typeof value === "number" ? value : parseFloat(value);
      if (isNaN(num)) return "0";
      return String(Math.round(num * 100) / 100);
    }

    case "status":
      // Must be { index: N } — never a plain string
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

// ─── Fetch board columns ──────────────────────────────────────────────────────
export const fetchBoardColumns = async (token, boardId) => {
  const safeBoardId = parseInt(boardId, 10);
  if (isNaN(safeBoardId)) {
    throw new Error(`Invalid boardId: "${boardId}" is not a number`);
  }

  const query = `
    query {
      boards(ids: [${safeBoardId}]) {
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
      `[fetchBoardColumns] Fetching columns for boardId: ${safeBoardId}`,
    );
    const data = await gql(token, query);

    const board = data?.boards?.[0];
    if (!board) {
      throw new Error(
        `Board "${safeBoardId}" not found — check MONDAY_BOARD_ID and token permissions`,
      );
    }

    const columns = board.columns || [];
    const columnMap = {}; // { "column title lowercased" → columnId }

    logger.info(
      `[fetchBoardColumns] ✓ Board "${board.name}" | ${columns.length} columns`,
    );

    for (const col of columns) {
      const key = col.title.toLowerCase().trim();
      columnMap[key] = col.id;
      logger.info(
        `[fetchBoardColumns]   └─ "${col.title}" | type: ${col.type} | id: ${col.id}`,
      );
    }

    return { columns, columnMap };
  } catch (err) {
    logger.error(`[fetchBoardColumns] ✗ Failed: ${err.message}`);
    throw err;
  }
};

// ─── Build posted-by string ───────────────────────────────────────────────────
const buildPostedBy = (details) => {
  const name = (details.authorName || "").trim();
  const id = (details.authorId || "").trim();
  if (!name && !id) return "";
  if (name && id && name !== id) return `${name} (${id})`;
  return name || id;
};

// ─── Build column_values payload ──────────────────────────────────────────────
/**
 * @param {object}  postObj       - { details, analytics }
 * @param {object}  columnMap     - { "title lowercased" → columnId }
 * @param {Array}   columns       - [{ id, title, type }]
 * @param {boolean} analyticsOnly - true on update runs — skip static metadata
 */
export const buildColumnValues = (
  postObj,
  columnMap = {},
  columns = [],
  analyticsOnly = false,
) => {
  const analytics = postObj.analytics || {};
  const details = postObj.details || {};

  // columnId → type
  const colTypeMap = {};
  for (const col of columns) colTypeMap[col.id] = col.type;

  const allMappings = [
    // ── Analytics (updated every sync)
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

    // ── Static metadata (written on create only)
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

  // ── Hardcoded column ID safety net (always applied for analytics) ──────────
  // These match this specific board's column IDs — ensures analytics always land
  // even if column titles change on the board.
  const payload = {
    numeric_mkzwxzqk: String(analytics.impressionCount ?? 0),
    numeric_mkzw50bn: String(analytics.uniqueImpressionsCount ?? 0),
    numeric_mkzwsay8: String(analytics.likeCount ?? 0),
    numeric_mkzwwst3: String(analytics.commentCount ?? 0),
    numeric_mkzw9bxf: String(analytics.shareCount ?? 0),
    numeric_mkzwx7en: String(analytics.clickCount ?? 0),
  };

  // ── Dynamic title-based mappings (override hardcoded if same column) ────────
  for (const { title, value, hintType, isAnalytics } of allMappings) {
    if (analyticsOnly && !isAnalytics) continue;

    const colId = columnMap[title];
    if (!colId) {
      if (!analyticsOnly) {
        logger.warn(`[board] Column not found on board: "${title}" — skipping`);
      }
      continue;
    }

    const actualType = colTypeMap[colId] || hintType;
    const formatted = formatValue(value, actualType);
    if (formatted !== null) payload[colId] = formatted;
  }

  return JSON.stringify(payload);
};

// ─── Create board item ────────────────────────────────────────────────────────
export const createBoardItem = async (
  token,
  postObj,
  columnMap,
  columns,
  boardId,
) => {
  const safeBoardId = String(parseInt(boardId, 10));

  // FIX: item name was the full postId URN which can be very long.
  // Monday item names have a 255-char limit — truncate safely.
  const rawName = String(
    postObj.details?.postId || postObj.postId || "unknown",
  );
  const itemName = rawName.length > 255 ? rawName.slice(0, 255) : rawName;

  const columnValuesStr = buildColumnValues(postObj, columnMap, columns, false);

  logger.info(
    `[createBoardItem] Creating item: ${itemName} on board ${safeBoardId}`,
  );
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

  try {
    const data = await gql(token, query, {
      boardId: safeBoardId,
      itemName,
      columnValues: columnValuesStr,
    });

    const itemId = data?.create_item?.id;
    if (!itemId) {
      throw new Error("create_item returned no id — check board permissions");
    }

    logger.info(`[createBoardItem] ✓ Created item: ${itemId}`);
    return String(itemId);
  } catch (err) {
    logger.error(`[createBoardItem] ✗ Failed: ${err.message}`);
    throw err;
  }
};

// ─── Update board item (analytics only) ──────────────────────────────────────
export const updateBoardItem = async (
  token,
  itemId,
  analytics,
  columnMap,
  columns,
  boardId,
) => {
  const safeBoardId = String(parseInt(boardId, 10));
  const safeItemId = String(parseInt(itemId, 10));

  // FIX: Validate itemId is a real integer before mutation — avoids cryptic errors
  if (isNaN(parseInt(itemId, 10))) {
    throw new Error(`Invalid itemId "${itemId}" — cannot update board item`);
  }

  const columnValuesStr = buildColumnValues(
    { analytics, details: {} },
    columnMap,
    columns,
    true, // analyticsOnly = true
  );

  logger.info(
    `[updateBoardItem] Updating itemId: ${safeItemId} on board ${safeBoardId}`,
  );
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

  try {
    const data = await gql(token, query, {
      boardId: safeBoardId,
      itemId: safeItemId,
      columnValues: columnValuesStr,
    });

    const updatedId = data?.change_multiple_column_values?.id;
    if (!updatedId) {
      throw new Error("change_multiple_column_values returned no id");
    }

    logger.info(`[updateBoardItem] ✓ Updated item: ${safeItemId}`);
    return updatedId;
  } catch (err) {
    logger.error(`[updateBoardItem] ✗ Failed: ${err.message}`);
    throw err;
  }
};

// ─── Find board item by postId ────────────────────────────────────────────────
// FIX: Original query fetched up to 500 items but didn't handle pagination.
// If the board has >500 items the target post would never be found.
// Now uses cursor-based pagination to scan all items.
export const findBoardItemByPostId = async (token, postId, boardId) => {
  const safeBoardId = parseInt(boardId, 10);
  if (isNaN(safeBoardId)) {
    logger.error(`[findBoardItemByPostId] Invalid boardId: ${boardId}`);
    return null;
  }

  const targetName = String(postId);
  logger.info(
    `[findBoardItemByPostId] Searching for "${targetName}" in board ${safeBoardId}`,
  );

  let cursor = null;
  let pageNum = 0;

  do {
    pageNum++;

    // Build query — use cursor on subsequent pages
    const query = cursor
      ? `
          query {
            boards(ids: [${safeBoardId}]) {
              items_page(limit: 100, cursor: "${cursor}") {
                cursor
                items { id name }
              }
            }
          }
        `
      : `
          query {
            boards(ids: [${safeBoardId}]) {
              items_page(limit: 100) {
                cursor
                items { id name }
              }
            }
          }
        `;

    let data;
    try {
      data = await gql(token, query);
    } catch (err) {
      logger.error(
        `[findBoardItemByPostId] ✗ Page ${pageNum} query failed: ${err.message}`,
      );
      return null;
    }

    const page = data?.boards?.[0]?.items_page || {};
    const items = page.items || [];
    cursor = page.cursor || null; // null means last page

    logger.info(
      `[findBoardItemByPostId] Page ${pageNum}: ${items.length} items | cursor=${cursor ? "present" : "done"}`,
    );

    const match = items.find(
      (item) => item.name === targetName || item.name?.includes(targetName),
    );

    if (match) {
      logger.info(
        `[findBoardItemByPostId] ✓ Found item ${match.id} for post ${targetName}`,
      );
      return String(match.id);
    }
  } while (cursor); // keep going until no more pages

  logger.info(
    `[findBoardItemByPostId] No item found for post ${targetName} after ${pageNum} page(s)`,
  );
  return null;
};
