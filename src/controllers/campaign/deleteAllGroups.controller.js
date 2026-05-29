import { StatusCodes } from "../../constants/statusCodes.constants.js";
import { MESSAGES } from "../../constants/messages.constant.js";
import { logger } from "../../utils/logger.js";
import { deleteAllGroupsFromBoards } from "../../services/deleteAllGroups.monday.service.js";

// Controller to delete all groups from both boards
export const deleteAllGroupsController = async (req, res) => {
  try {
    // Optionally, you can require an admin token or some auth here
    logger.info(
      "[delete-groups] Request received to delete all groups from both boards",
    );
    const summary = await deleteAllGroupsFromBoards();
    return res.status(StatusCodes.OK).json({
      success: true,
      message: "All groups deleted from both boards successfully.",
      summary,
    });
  } catch (err) {
    logger.error(`[delete-groups] Error: ${err.message}`);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: err.message || MESSAGES.INTERNAL_SERVER_ERROR,
    });
  }
};
