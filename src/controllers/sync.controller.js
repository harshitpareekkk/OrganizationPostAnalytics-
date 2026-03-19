import axios from "axios";
import jwt from "jsonwebtoken";
import {
  fetchLastThreeMonthsPosts,
  fetchPostStats,
  extractPostDetails,
} from "../services/linkedin.service.js";
import {
  getStoredPost,
  savePostToStorage,
  updatePostInStorage,
} from "../services/monday.storage.service.js";
import {
  fetchBoardColumns,
  createBoardItem,
  updateBoardItem,
  findBoardItemByPostId,
  testMondayAccess,
} from "../services/monday.board.service.js";
import { hasMetricsChanged } from "../utils/diff.util.js";
import { logger } from "../utils/logger.js";
import { StatusCodes } from "../constants/statusCodes.constants.js";
import { MESSAGES } from "../constants/messages.constant.js";

// ─── Helper: Generate signed JWT token for Monday callback ───
const getAuthToken = () => {
  const signingSecret = process.env.MONDAY_SIGNING_SECRET;
  const appId = Number(process.env.MONDAY_APP_ID);

  if (isNaN(appId)) {
    logger.error("[sync] MONDAY_APP_ID must be set to a numeric value in .env");
    throw new Error("Invalid MONDAY_APP_ID");
  }

  return jwt.sign({ appId }, signingSecret);
};

export const syncLinkedInPosts = async (req, res) => {
  let callbackUrl = null;
  try {
    logger.info(
      "═════════════════════════════════════════════════════════════",
    );
    logger.info("[sync] ▶ Starting LinkedIn posts synchronization");
    logger.info(`[sync] Request method: ${req.method}`);
    logger.info(`[sync] Request path: ${req.path}`);
    logger.info(
      "[sync] ─────────────────────────────────────────────────────────",
    );

    // Extract callbackUrl and token from Monday's payload (seamless authentication)
    const payload = req.body?.payload;

    logger.info(`[sync] Step 1: Validate payload`);
    logger.info(
      `[sync] └─ Payload object: ${payload ? "✓ Received" : "✗ MISSING"}`,
    );

    if (!payload) {
      logger.error("[sync] ✗ FATAL: No payload in request body");
      logger.error(
        `[sync] Request body keys: ${Object.keys(req.body || {}).join(", ")}`,
      );
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        error: "Missing payload in request body",
      });
    }

    callbackUrl = payload?.callbackUrl;
    logger.info(
      `[sync] └─ Callback URL: ${callbackUrl ? "✓ Present" : "✗ Missing"}`,
    );

    // IMPORTANT: Use shortLivedToken from payload for Monday API calls (seamless auth)
    const shortLivedToken = payload?.shortLivedToken;

    logger.info(`[sync] Step 2: Validate authentication token`);
    logger.info(
      `[sync] └─ shortLivedToken: ${shortLivedToken ? "✓ Found" : "✗ MISSING"}`,
    );
    logger.info(
      `[sync] └─ Token length: ${shortLivedToken?.length || 0} chars`,
    );

    if (!shortLivedToken || typeof shortLivedToken !== "string") {
      logger.error(
        `[sync] ✗ AUTHORIZATION FAILED: No or invalid shortLivedToken in payload`,
      );
      logger.error(
        `[sync] Payload keys received: ${Object.keys(payload).join(", ")}`,
      );
      return res.status(StatusCodes.UNAUTHORIZED).json({
        success: false,
        error:
          "Missing shortLivedToken from Monday payload - authorization failed",
      });
    }
    logger.info(`[sync] └─ Token validation: ✓ PASSED`);

    // Extract accountId from payload
    const accountId = payload?.accountId;
    logger.info(`[sync] Step 3: Extract account metadata`);
    logger.info(`[sync] └─ Account ID: ${accountId || "unknown"}`);

    // Board ID
    const boardId = String(
      payload?.inputFields?.boardId || process.env.MONDAY_BOARD_ID || "",
    );

    if (!boardId) {
      logger.error("[sync] ✗ CONFIGURATION ERROR: Missing boardId");
      logger.error(
        `[sync] inputFields.boardId: ${payload?.inputFields?.boardId}`,
      );
      logger.error(
        `[sync] MONDAY_BOARD_ID env: ${process.env.MONDAY_BOARD_ID}`,
      );
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        error: MESSAGES.BAD_REQUEST,
      });
    }

    const boardSource = req.body?.payload?.inputFields?.boardId
      ? "Monday automation inputFields"
      : ".env MONDAY_BOARD_ID";
    logger.info(`[sync] └─ Board ID: ${boardId} (from: ${boardSource})`);

    logger.info(`[sync] Step 4: Test Monday board access`);
    try {
      await testMondayAccess(shortLivedToken, boardId);
      logger.info(`[sync] └─ Board access test: ✓ PASSED`);
    } catch (err) {
      logger.error(`[sync] ✗ BOARD ACCESS FAILED: ${err.message}`);
      logger.error(
        `[sync] This indicates an authorization issue with the provided token`,
      );
      return res.status(StatusCodes.UNAUTHORIZED).json({
        success: false,
        error: `Cannot access board ${boardId}: ${err.message}`,
      });
    }

    // Step 1: Fetch board columns
    logger.info(`[sync] Step 5: Fetch board structure`);
    let columns = [];
    let columnMap = {};
    try {
      ({ columns, columnMap } = await fetchBoardColumns(
        shortLivedToken,
        boardId,
      ));
      logger.info(`[sync] └─ Columns fetched: ✓ ${columns.length} columns`);
    } catch (err) {
      logger.error(`[sync] ✗ COLUMN FETCH FAILED: ${err.message}`);
      logger.error(
        `[sync] This is typically an authorization issue - verify token has board access`,
      );
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        error: `Board columns fetch failed: ${err.message}`,
      });
    }

    // Step 2: Fetch LinkedIn posts
    logger.info("[sync] Step 6: Fetch LinkedIn posts");
    const posts = await fetchLastThreeMonthsPosts();
    logger.info(
      `[sync] └─ Posts fetched: ✓ ${posts.length} posts from 90 days`,
    );

    if (posts.length === 0) {
      logger.info("[sync] └─ No posts to sync, completing");
      return res.json({
        success: true,
        summary: { total: 0, created: 0, updated: 0, unchanged: 0, failed: 0 },
        results: [],
      });
    }

    const results = [];

    // ── Step 3: Process each post — STRICTLY one at a time
    logger.info(`[sync] Step 7: Process ${posts.length} posts sequentially`);
    for (const post of posts) {
      const postId = post.id;
      logger.info(`[sync] ├─ Processing post: ${postId}`);

      const details = extractPostDetails(post, post._resolvedAuthorName || "");

      // Storage check FIRST — before analytics fetch — keeps loop strictly sequential
      logger.info(`[sync] │  ├─ Check if post exists in storage`);
      const postCheckResult = await getStoredPost(shortLivedToken, postId);

      // Handle token validation error from service
      if (
        !postCheckResult.success &&
        postCheckResult.statusCode === StatusCodes.UNAUTHORIZED
      ) {
        logger.error(
          `[sync] │  ✗ TOKEN INVALID - Storage service returned 401`,
        );
        logger.error(`[sync] │  Details: ${postCheckResult.error}`);
        return res.status(postCheckResult.statusCode).json({
          success: false,
          error: postCheckResult.error,
        });
      }

      const existingPost = postCheckResult.success
        ? postCheckResult.data
        : null;

      logger.info(
        `[sync] │  └─ Storage check: ${existingPost ? "Exists" : "New post"}`,
      );

      // Fetch analytics once per post
      const analytics = await fetchPostStats(postId);

      if (!existingPost) {
        logger.info(`[sync] │  └─ Action: CREATE new board item`);

        const postObj = {
          postId,
          details,
          analytics,
          boardItemId: null,
          boardId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        // (a) Save to Monday Storage
        logger.info(`[sync] │     ├─ Saving to Monday Storage...`);
        const saved = await savePostToStorage(shortLivedToken, postObj);
        if (!saved.success) {
          logger.error(`[sync] │     ✗ Storage save failed: ${saved.error}`);
          results.push({
            postId,
            postedAt: details.createdAt,
            status: "SAVE_FAILED",
          });
          continue;
        }
        logger.info(`[sync] │     └─ Saved to storage: ✓`);

        // (b) Create board row  (item_name = postId)
        logger.info(`[sync] │     ├─ Creating Monday board item...`);
        let boardItemId = null;
        try {
          boardItemId = await createBoardItem(
            shortLivedToken,
            postObj,
            columnMap,
            columns,
            boardId,
          );
          logger.info(`[sync] │     └─ Board item created: ✓ ${boardItemId}`);
        } catch (err) {
          logger.error(`[sync] │     ✗ Board creation failed: ${err.message}`);
        }

        // (c) Save boardItemId to storage so next sync can update directly
        if (boardItemId) {
          logger.info(`[sync] │     ├─ Updating storage with boardItemId...`);
          const updateRes = await updatePostInStorage(shortLivedToken, postId, {
            ...postObj,
            boardItemId,
          });
          if (updateRes.success) {
            logger.info(`[sync] │     └─ Board item ID stored: ✓`);
          } else {
            logger.warn(
              `[sync] │     ✗ Failed to store board item ID: ${updateRes.error}`,
            );
          }
        }

        results.push({
          postId,
          postedAt: details.createdAt,
          boardItemId: boardItemId || null,
          status: boardItemId ? "CREATED" : "CREATED_STORAGE_ONLY",
        });
      } else {
        const analyticsChanged = hasMetricsChanged(
          existingPost.analytics,
          analytics,
        );

        if (analyticsChanged) {
          logger.info(`[sync] │  └─ Action: UPDATE analytics`);

          const updatedPost = {
            ...existingPost,
            analytics,
            updatedAt: new Date().toISOString(),
          };

          // Update storage
          logger.info(`[sync] │     ├─ Updating storage...`);
          const updateRes = await updatePostInStorage(
            shortLivedToken,
            postId,
            updatedPost,
          );
          if (updateRes.success) {
            logger.info(`[sync] │     └─ Storage updated: ✓`);
          } else {
            logger.error(
              `[sync] │     ✗ Storage update failed: ${updateRes.error}`,
            );
          }

          // Find board item ID
          let boardItemId = existingPost.boardItemId || null;
          if (!boardItemId) {
            logger.info(`[sync] │     ├─ Searching for board item...`);
            boardItemId = await findBoardItemByPostId(
              shortLivedToken,
              postId,
              boardId,
            );
            if (boardItemId) {
              logger.info(`[sync] │     └─ Found: ${boardItemId}`);
              const updateRes = await updatePostInStorage(
                shortLivedToken,
                postId,
                {
                  ...updatedPost,
                  boardItemId,
                },
              );
              if (!updateRes.success) {
                logger.warn(
                  `[sync] │     ✗ Failed to store found board item ID`,
                );
              }
            } else {
              logger.info(`[sync] │     └─ Board item not found`);
            }
          }

          if (boardItemId) {
            try {
              logger.info(`[sync] │     ├─ Updating board analytics...`);
              await updateBoardItem(
                shortLivedToken,
                boardItemId,
                analytics,
                columnMap,
                columns,
                boardId,
              );
              logger.info(`[sync] │     └─ Board updated: ✓`);
              results.push({
                postId,
                postedAt: details.createdAt,
                boardItemId,
                status: "UPDATED",
              });
            } catch (err) {
              logger.error(
                `[sync] │     ✗ Board update failed: ${err.message}`,
              );
              results.push({
                postId,
                postedAt: details.createdAt,
                boardItemId,
                status: "UPDATE_FAILED",
              });
            }
          } else {
            // No board item found — create one now as recovery
            logger.warn(
              `[sync] │  ✗ No board item found for post ${postId}, attempting recovery`,
            );
            try {
              boardItemId = await createBoardItem(
                shortLivedToken,
                updatedPost,
                columnMap,
                columns,
                boardId,
              );
              const updateRes = await updatePostInStorage(
                shortLivedToken,
                postId,
                {
                  ...updatedPost,
                  boardItemId,
                },
              );
              if (updateRes.success) {
                logger.info(
                  `[sync] │  └─ Board item created successfully (recovery)`,
                );
              } else {
                logger.warn(
                  `[sync] │  └─ Board item created but storage update failed`,
                );
              }
            } catch (err) {
              logger.error(
                `[sync] │  ✗ Recovery creation failed: ${err.message}`,
              );
            }
          }

          results.push({
            postId,
            postedAt: details.createdAt,
            boardItemId: boardItemId || null,
            status: "UPDATED",
          });
        } else {
          logger.info(`[sync] │  └─ Action: SKIP (no analytics changes)`);
          results.push({
            postId,
            postedAt: details.createdAt,
            boardItemId: existingPost.boardItemId || null,
            status: "UNCHANGED",
          });
        }
      }
    } // ← each post fully completes before next starts

    // ── Step 8: Compilation ─────────────────────────────────────────
    logger.info(`[sync] Step 8: Compilation complete`);
    const summary = {
      total: results.length,
      created: results.filter(
        (r) => r.status === "CREATED" || r.status === "CREATED_STORAGE_ONLY",
      ).length,
      updated: results.filter((r) => r.status === "UPDATED").length,
      unchanged: results.filter((r) => r.status === "UNCHANGED").length,
      failed: results.filter((r) => r.status.includes("FAILED")).length,
    };

    logger.info(
      `[sync] └─ Created: ${summary.created}, Updated: ${summary.updated}, Unchanged: ${summary.unchanged}, Failed: ${summary.failed}`,
    );

    // ─── Final callback (if provided) ──────────────────────────────────
    if (callbackUrl) {
      logger.info(`[sync] Step 9: Send callback to Monday`);
      try {
        const authToken = getAuthToken();

        // Correct payload structure for Monday async callback
        const callbackPayload = {
          success: true,
          outputFields: {},
        };

        logger.info(`[sync] └─ Sending to: ${callbackUrl}`);
        await axios.post(callbackUrl, callbackPayload, {
          timeout: 10000,
          headers: {
            "Content-Type": "application/json",
            Authorization: authToken,
          },
        });
        logger.info(`[sync] └─ Callback sent: ✓`);
      } catch (callbackErr) {
        logger.error(
          `[sync] └─ Callback error (non-fatal): ${callbackErr.message}`,
        );
      }
    } else {
      logger.warn(`[sync] └─ No callback URL provided by Monday`);
    }

    logger.info(
      `[sync] ═════════════════════════════════════════════════════════════`,
    );
    logger.info(`[sync] ▶ Sync completed successfully`);
    logger.info(
      `[sync] ═════════════════════════════════════════════════════════════`,
    );

    return res.json({ success: true, summary, results });
  } catch (err) {
    logger.error(
      `[sync] ═════════════════════════════════════════════════════════════`,
    );
    logger.error(`[sync] ✗✗✗ SYNC FAILED ✗✗✗`);
    logger.error(`[sync] Error message: ${err.message}`);
    logger.error(`[sync] Error stack: ${err.stack}`);
    logger.error(
      `[sync] ═════════════════════════════════════════════════════════════`,
    );

    // ─── SEND ERROR CALLBACK TO MONDAY ───────────────────────────────────
    if (callbackUrl) {
      try {
        const authToken = getAuthToken();

        logger.info(`[sync] Sending error callback to: ${callbackUrl}`);
        await axios.post(
          callbackUrl,
          {
            success: false,
            outputFields: {},
          },
          {
            timeout: 10000,
            headers: {
              "Content-Type": "application/json",
              Authorization: authToken,
            },
          },
        );
        logger.info(`[sync] Error callback sent`);
      } catch (callbackErr) {
        logger.warn(
          `[sync] Could not send error callback: ${callbackErr.message}`,
        );
      }
    } else {
      logger.warn(`[sync] No callback URL provided by Monday`);
    }

    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.INTERNAL_SERVER_ERROR,
    });
  }
};
