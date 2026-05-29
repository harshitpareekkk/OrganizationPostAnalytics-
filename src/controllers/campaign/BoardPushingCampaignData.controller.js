import { StatusCodes } from "../../constants/statusCodes.constants.js";
import { logger } from "../../utils/logger.js";
import { pushLinkedInDataToMondayBoards } from "../../services/campaign.monday.service.js";

export const pushLinkedInDataToMonday = async (req, res) => {
  // ── Debug: log what we received ──────────────────────────────────────────
  logger.info(
    `[monday-push] Content-Type: ${req.headers["content-type"] ?? "NOT SET"}`,
  );
  logger.info(`[monday-push] req.body exists: ${!!req.body}`);
  logger.info(
    `[monday-push] req.body keys: ${req.body ? Object.keys(req.body).join(", ") : "NONE"}`,
  );

  try {
    const data = req.body?.data;

    if (!data) {
      logger.error(
        `[monday-push] No data in request body. ` +
          `Make sure you set Content-Type: application/json and send { "data": { ... } }.`,
      );
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        error:
          'Missing request body. Send Content-Type: application/json with body: { "data": { "account": {...}, "campaignGroups": [...] } }',
      });
    }

    if (!data.account || !Array.isArray(data.campaignGroups)) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        error:
          "Invalid data structure. Expected { account: {...}, campaignGroups: [...] }",
      });
    }

    logger.info(
      `[monday-push] Received data: account=${data.account?.name}, ` +
        `groups=${data.campaignGroups?.length}`,
    );

    const summary = await pushLinkedInDataToMondayBoards(data);

    return res.status(StatusCodes.OK).json({
      success: true,
      message: "LinkedIn data pushed to Monday.com boards successfully",
      summary,
    });
  } catch (err) {
    logger.error(`[monday-push] Error: ${err.message}`);
    logger.error(`[monday-push] Stack: ${err.stack}`);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: err.message,
    });
  }
};
