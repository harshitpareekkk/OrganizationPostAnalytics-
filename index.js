import dotenv from "dotenv";
dotenv.config();

import express from "express";
import syncRoutes from "./src/routes/sync.routes.js";
import { logger } from "./src/utils/logger.js";

const app = express();
app.use(express.json());
app.use("/api", syncRoutes);

const PORT = process.env.PORT || 4000;
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
  });
}

module.exports = app;
