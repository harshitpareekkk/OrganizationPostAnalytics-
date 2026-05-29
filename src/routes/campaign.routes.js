import express from "express";
import { authorizeRequest } from "../middlewares/authorizeRequest.js";
import { getAdAccounts } from "../controllers/campaign/campaignAccountFetch.controller.js";
import { pushLinkedInDataToMonday } from "../controllers/campaign/BoardPushingCampaignData.controller.js";
import { deleteAllGroupsController } from "../controllers/campaign/deleteAllGroups.controller.js";
const router = express.Router();

// route that fetch all campaign Deatails and store on monday board
router.get("/complete", authorizeRequest, getAdAccounts);

//  POST /api/campaign/push-monday
router.post("/push-monday", authorizeRequest, pushLinkedInDataToMonday);

//  DELETE /api/campaign/delete-all-groups : Help to delete all groups from campaign as well as creatives board
router.delete(
  "/delete-all-groups",
  authorizeRequest,
  deleteAllGroupsController,
);

export default router;
