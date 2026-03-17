import dotenv from "dotenv";
dotenv.config();

import express from "express";
import syncRoutes from "./src/routes/sync.routes.js";
import { logger } from "./src/utils/logger.js";

const app = express();
app.use(express.json());
app.use("/api", syncRoutes);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  logger.info(`Server started successfully on port ${PORT}`);
});
