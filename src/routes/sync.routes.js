import express from "express";
import { authorizeRequest } from "../middlewares/authorizeRequest.js";
import { syncLinkedInPosts } from "../controllers/sync.controller.js";
import {
  getAllStoredPostsHandler,
  getStoredPostHandler,
  deleteAllStoredPostsHandler,
  deleteStoredPostHandler,
} from "../services/monday.storage.service.js";

const router = express.Router();

// ── POST /api/sync
router.post("/sync", authorizeRequest, syncLinkedInPosts);

// ── GET /api/storage --> get all stored posts for this account
router.get("/storage", authorizeRequest, getAllStoredPostsHandler);

// ── GET /api/storage/:postId ---> getting a particular stored post by its postId (LinkedIn post URN)
router.get("/storage/:postId", authorizeRequest, getStoredPostHandler);

// ── DELETE /api/storage --> delete all stored posts for this account
router.delete("/storage", authorizeRequest, deleteAllStoredPostsHandler);

// ── DELETE /api/storage/:postId ---> deleting a particular post from storage
router.delete("/storage/:postId", authorizeRequest, deleteStoredPostHandler);

export default router;
