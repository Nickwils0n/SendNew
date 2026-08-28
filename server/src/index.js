require("dotenv").config();
const http = require("http");

// Last line of defense: Node terminates the whole process on an unhandled
// promise rejection by default (since v15). Every route/ws handler already
// catches its own errors, but this stops one missed spot from taking down
// every other connected company/device.
process.on("unhandledRejection", (err) => {
  console.error("unhandled rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("uncaught exception:", err);
});

const express = require("express");
const cors = require("cors");

const agentAuthRoutes = require("./routes/agentAuth");
const agentAttachmentsRoutes = require("./routes/agentAttachments");
const mediaRoutes = require("./routes/media");
const adminRoutes = require("./routes/admin");
const messageRoutes = require("./routes/messages");
const { attachWsServer } = require("./wsHub");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/agent", agentAuthRoutes);
app.use("/agent", agentAttachmentsRoutes);
app.use("/media", mediaRoutes);
app.use("/admin", adminRoutes);
app.use("/api", messageRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

const port = process.env.PORT || 3000;
const server = http.createServer(app);
attachWsServer(server);

server.listen(port, () => {
  console.log(`sendnew-server listening on :${port}`);
});
