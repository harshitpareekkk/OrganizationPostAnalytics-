import express from "express";
import { authorizeRequest } from "../middlewares/authorizeRequest.js";
import {
  uploadMedia,
  getMyOrganizations,
  createPost,
} from "../controllers/linkedinPost.controller.js";

const router = express.Router();

// Route for fetching organizationID
router.get("/organizations", authorizeRequest, getMyOrganizations);

// Route for posting a post on linkedin as a Draft
router.post(
  "/create",
  authorizeRequest,
  uploadMedia.array("media", 9), // support max 9 files as per linkedIn posting limit
  createPost,
);

export default router;
