import { logger } from "../utils/logger.js";
import axios from "axios";
import { getConfig } from "../constants/env.constants.js";
import { API_ENDPOINTS } from "../constants/api.constants.js";
import { getMondayHeaders } from "../constants/headers.constants.js";

const MONDAY_API_URL = API_ENDPOINTS.MONDAY.BASE;

// ─── Internal helper: call Monday GraphQL API ─────────────────────────────
const mondayGql = async (query, variables = {}) => {
  const config = getConfig();
  const MONDAY_API_KEY = config.MONDAY_API_KEY; // ← lazy read from config

  if (!MONDAY_API_KEY) {
    throw new Error("MONDAY_API_KEY is not set in environment variables");
  }

  const res = await axios.post(
    MONDAY_API_URL,
    { query, variables },
    {
      headers: getMondayHeaders(MONDAY_API_KEY),
    },
  );

  if (res.data?.errors?.length) {
    throw new Error(res.data.errors.map((e) => e.message).join(" | "));
  }

  return res.data.data;
};

// ─── Delete all non-default groups from a single board ─────────────────────
async function deleteAllGroupsFromBoard(boardId) {
  logger.info(`[delete-groups] Fetching groups from board ${boardId}`);

  // Monday 2024-01: board IDs are passed as Int scalars
  const query = `
    query($boardId: [ID!]) {
      boards(ids: $boardId) {
        groups {
          id
          title
        }
      }
    }
  `;

  const data = await mondayGql(query, { boardId: [String(boardId)] });
  const groups = data?.boards?.[0]?.groups || [];

  logger.info(
    `[delete-groups] Board ${boardId}: found ${groups.length} group(s)`,
  );

  let deleted = 0;

  for (const group of groups) {
    // "topics" is the default group Monday creates and cannot be deleted
    if (group.id === "topics") {
      logger.info(
        `[delete-groups] Skipping default group "topics" on board ${boardId}`,
      );
      continue;
    }

    try {
      const mutation = `
        mutation($boardId: ID!, $groupId: String!) {
          delete_group(board_id: $boardId, group_id: $groupId) {
            id
          }
        }
      `;
      await mondayGql(mutation, {
        boardId: String(boardId),
        groupId: group.id,
      });
      logger.info(
        `[delete-groups] Deleted group "${group.title}" (${group.id}) from board ${boardId}`,
      );
      deleted++;
    } catch (err) {
      logger.error(
        `[delete-groups] Failed to delete group "${group.title}" (${group.id}): ${err.message}`,
      );
    }
  }

  return { boardId, deleted, total: groups.length };
}

// ─── Main export: delete all groups from both boards
export async function deleteAllGroupsFromBoards() {
  // ← Read env vars here, at call time, NOT at module load time
  const config = getConfig();
  const MONDAY_CAMPAIGN_BOARD_ID = config.MONDAY_CAMPAIGN_BOARD_ID;
  const MONDAY_CREATIVES_BOARD_ID = config.MONDAY_CREATIVES_BOARD_ID;
  const MONDAY_API_KEY = config.MONDAY_API_KEY;

  if (
    !MONDAY_CAMPAIGN_BOARD_ID ||
    !MONDAY_CREATIVES_BOARD_ID ||
    !MONDAY_API_KEY
  ) {
    const missing = [
      !MONDAY_CAMPAIGN_BOARD_ID && "MONDAY_CAMPAIGN_BOARD_ID",
      !MONDAY_CREATIVES_BOARD_ID && "MONDAY_CREATIVES_BOARD_ID",
      !MONDAY_API_KEY && "MONDAY_API_KEY",
    ]
      .filter(Boolean)
      .join(", ");

    throw new Error(`Missing environment variable(s): ${missing}`);
  }

  logger.info(
    `[delete-groups] Starting deletion on boards: ${MONDAY_CAMPAIGN_BOARD_ID}, ${MONDAY_CREATIVES_BOARD_ID}`,
  );

  const results = [];
  results.push(await deleteAllGroupsFromBoard(MONDAY_CAMPAIGN_BOARD_ID));
  results.push(await deleteAllGroupsFromBoard(MONDAY_CREATIVES_BOARD_ID));

  const totalDeleted = results.reduce((acc, r) => acc + r.deleted, 0);
  logger.info(
    `[delete-groups] ✅ Done — ${totalDeleted} group(s) deleted across both boards`,
  );

  return results;
}
