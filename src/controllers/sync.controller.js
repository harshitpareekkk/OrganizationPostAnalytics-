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

export const syncLinkedInPosts = async (req, res) => {
  try {
    logger.info("sync Starting LinkedIn posts synchronization");
    // Token
    const shortLivedToken = req.session?.shortLivedToken;

    if (!shortLivedToken) {
      logger.error("[sync] No shortLivedToken in session");
      return res.status(StatusCodes.UNAUTHORIZED).json({
        success: false,
        error: MESSAGES.UNAUTHORIZED,
      });
    }

    logger.info(`[sync] Token ready | accountId=${req.session?.accountId}`);

    // Board ID
    const boardId = String(
      req.body?.payload?.inputFields?.boardId ||
        process.env.MONDAY_BOARD_ID ||
        "",
    );

    if (!boardId) {
      logger.error("[sync] Missing boardId");
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        error: MESSAGES.BAD_REQUEST,
      });
    }

    const boardSource = req.body?.payload?.inputFields?.boardId
      ? "Monday automation inputFields"
      : ".env MONDAY_BOARD_ID";
    logger.info(`[sync] Board ID: ${boardId} (from ${boardSource})`);

    try {
      await testMondayAccess(shortLivedToken, boardId);
    } catch (err) {
      logger.error(`[sync] Board access test failed: ${err.message}`);
      return res.status(StatusCodes.UNAUTHORIZED).json({
        success: false,
        error: `Cannot access board ${boardId}: ${err.message}`,
      });
    }

    // Step 1: Fetch board columns
    logger.info("sync Fetching Monday board columns");
    let columns = [];
    let columnMap = {};
    try {
      ({ columns, columnMap } = await fetchBoardColumns(
        shortLivedToken,
        boardId,
      ));
      logger.info(`[sync] Board columns fetched: ${columns.length} columns`);
    } catch (err) {
      logger.error(`[sync] Board columns fetch failed: ${err.message}`);
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        error: `Board columns fetch failed: ${err.message}`,
      });
    }

    // Step 2: Fetch LinkedIn posts
    logger.info("[sync] Fetching LinkedIn posts (90 days)");
    const posts = await fetchLastThreeMonthsPosts();
    logger.info(`[sync] Posts fetched: ${posts.length}`);

    if (posts.length === 0) {
      logger.info("[sync] No posts found, sync completed");
      return res.json({
        success: true,
        summary: { total: 0, created: 0, updated: 0, unchanged: 0, failed: 0 },
        results: [],
      });
    }

    const results = [];

    // ── Step 3: Process each post — STRICTLY one at a time
    for (const post of posts) {
      const postId = post.id;
      logger.info(`[sync] Processing post: ${postId}`);

      const details = extractPostDetails(post, post._resolvedAuthorName || "");

      // Storage check FIRST — before analytics fetch — keeps loop strictly sequential
      const postCheckResult = await getStoredPost(shortLivedToken, postId);

      // Handle token validation error from service
      if (
        !postCheckResult.success &&
        postCheckResult.statusCode === StatusCodes.UNAUTHORIZED
      ) {
        return res.status(postCheckResult.statusCode).json({
          success: false,
          error: postCheckResult.error,
        });
      }

      const existingPost = postCheckResult.success
        ? postCheckResult.data
        : null;

      // Fetch analytics once per post
      const analytics = await fetchPostStats(postId);

      if (!existingPost) {
        logger.info(`[sync] Post ${postId} is new, creating`);

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
        const saved = await savePostToStorage(shortLivedToken, postObj);
        if (!saved.success) {
          logger.error(
            `[sync] Failed to save post ${postId} to storage: ${saved.error}`,
          );
          results.push({
            postId,
            postedAt: details.createdAt,
            status: "SAVE_FAILED",
          });
          continue;
        }
        logger.info(`[sync] Post ${postId} saved to storage`);

        // (b) Create board row  (item_name = postId)
        let boardItemId = null;
        try {
          boardItemId = await createBoardItem(
            shortLivedToken,
            postObj,
            columnMap,
            columns,
            boardId,
          );
          logger.info(
            `[sync] Board item created for post ${postId}: ${boardItemId}`,
          );
        } catch (err) {
          logger.error(
            `[sync] Failed to create board item for ${postId}: ${err.message}`,
          );
        }

        // (c) Save boardItemId to storage so next sync can update directly
        if (boardItemId) {
          const updateRes = await updatePostInStorage(shortLivedToken, postId, {
            ...postObj,
            boardItemId,
          });
          if (updateRes.success) {
            logger.info(`[sync] Board item ID saved for post ${postId}`);
          } else {
            logger.warn(
              `[sync] Failed to save board item ID for post ${postId}`,
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
          logger.info(`[sync] Post ${postId} analytics changed, updating`);

          const updatedPost = {
            ...existingPost,
            analytics,
            updatedAt: new Date().toISOString(),
          };

          // Update storage
          const updateRes = await updatePostInStorage(
            shortLivedToken,
            postId,
            updatedPost,
          );
          if (updateRes.success) {
            logger.info(`[sync] Post ${postId} updated in storage`);
          } else {
            logger.error(
              `[sync] Failed to update post in storage: ${updateRes.error}`,
            );
          }

          // Find board item ID
          let boardItemId = existingPost.boardItemId || null;
          if (!boardItemId) {
            logger.info(
              `[sync] Searching for board item ID for post ${postId}`,
            );
            boardItemId = await findBoardItemByPostId(
              shortLivedToken,
              postId,
              boardId,
            );
            if (boardItemId) {
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
                  `[sync] Failed to save board item ID for post ${postId}`,
                );
              }
            }
          }

          if (boardItemId) {
            try {
              await updateBoardItem(
                shortLivedToken,
                boardItemId,
                analytics,
                columnMap,
                columns,
                boardId,
              );
              logger.info(`[sync] Board item updated for post ${postId}`);
            } catch (err) {
              logger.error(
                `[sync] Failed to update board item: ${err.message}`,
              );
            }
          } else {
            // No board item found — create one now as recovery
            logger.warn(
              `[sync] No board item found for post ${postId}, creating as recovery`,
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
                  `[sync] Board item created for post ${postId} (recovery)`,
                );
              } else {
                logger.warn(
                  `[sync] Board item created but storage update failed for post ${postId}`,
                );
              }
            } catch (err) {
              logger.error(
                `[sync] Failed to create board item (recovery): ${err.message}`,
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
          logger.info(`[sync] Post ${postId} unchanged, skipping`);
          results.push({
            postId,
            postedAt: details.createdAt,
            boardItemId: existingPost.boardItemId || null,
            status: "UNCHANGED",
          });
        }
      }
    } // ← each post fully completes before next starts

    // ── Summary ───────────────────────────────────────────────
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
      `[sync] Synchronization completed | Total: ${summary.total} | Created: ${summary.created} | Updated: ${summary.updated}`,
    );
    return res.json({ success: true, summary, results });
  } catch (err) {
    logger.error(`[sync] Synchronization failed: ${err.message}`);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.INTERNAL_SERVER_ERROR,
    });
  }
};
