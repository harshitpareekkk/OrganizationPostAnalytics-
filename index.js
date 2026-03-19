import dotenv from "dotenv";
dotenv.config();

import express from "express";
import syncRoutes from "./src/routes/sync.routes.js";

const app = express();
app.use(express.json());
app.use("/api", syncRoutes);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});

export default app;
