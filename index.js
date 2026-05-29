import dotenv from "dotenv";
dotenv.config();

import express from "express";
import linkedinAuthRoutes from "./src/routes/Linkedin.auth.routes.js";
import syncRoutes from "./src/routes/sync.routes.js";
import campaignRoutes from "./src/routes/campaign.routes.js";
import postRoutes from "./src/routes/likedinPost.routes.js";
import { initializeConfig } from "./src/constants/config.loader.js";
import { logger } from "./src/utils/logger.js";

// Initialize and validate configuration on startup
const config = initializeConfig();

const app = express();
app.use(express.json());
app.use("/api/linkedin-auth", linkedinAuthRoutes);
app.use("/api", syncRoutes);
app.use("/api/campaign", campaignRoutes);
app.use("/api/orgpage", postRoutes);

const PORT = config.PORT;
app.listen(PORT, () => {
  logger.info(`server Application listening on port ${PORT}`);
});

export default app;
