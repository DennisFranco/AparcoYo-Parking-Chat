import "dotenv/config";
import express from "express";
import cors from "cors";
import http from "http";
import mongoose from "mongoose";
import { Server } from "socket.io";
import chatsRouter from "./routes/chats";
import { Conversation } from "./models/Conversation";
import { Message } from "./models/Message";
import { makeChatId } from "./utils/makeChatId";

const PORT = Number(process.env.PORT || 4000);
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/chatdev";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const IO_PATH = process.env.IO_PATH || "/socket.io";

// Helpers de log
const now = () => new Date().toISOString();
const log = (...a: any[]) => console.log(now(), "[WS]", ...a);
const dblog = (...a: any[]) => console.log(now(), "[DB]", ...a);
const slog = (socket: any, ...a: any[]) =>
  console.log(
    now(),
    `[SOCK ${socket.id} uid=${socket?.data?.uid ?? "?"}]`,
    ...a
  );

async function bootstrap() {
  const redacted = MONGO_URI.replace(/\/\/([^@]+)@/, "//<redacted>@");
  dblog("connecting to", redacted);
  await mongoose.connect(MONGO_URI);
  dblog("connected");

  const app = express();
  app.use(
    cors({ origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",") })
  );
  app.use(express.json());

  // Health simple
  app.get("/api/health", (_req, res) => res.json({ ok: true, at: now() }));

  app.use("/api", chatsRouter);

  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    path: IO_PATH,
    cors: { origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",") },
    transports: ["websocket", "polling"],
    pingTimeout: 30000,
    pingInterval: 25000,
  });

  log("listening path:", IO_PATH);

  io.on("connection", (socket) => {
    // UID dev-only
    const uid =
      (socket.handshake.auth as any)?.uid ||
      (socket.handshake.query?.uid as string);

    socket.data = socket.data || {};
    (socket.data as any).uid = uid;

    slog(
      socket,
      "incoming connection. auth:",
      socket.handshake.auth,
      "query:",
      socket.handshake.query
    );

    if (!uid) {
      slog(socket, "missing uid -> disconnecting");
      socket.emit("error", { message: "Missing uid in auth/query" });
      socket.disconnect(true);
      return;
    }

    const personalRoom = `user:${uid}`;
    socket.join(personalRoom);
    slog(
      socket,
      "joined personal room:",
      personalRoom,
      "rooms:",
      Array.from(socket.rooms)
    );

    io.to(personalRoom).emit("presence", {
      uid,
      status: "online",
      at: now(),
    });

    // JOIN + HISTORIAL
    socket.on(
      "chat:join",
      async ({
        otherUid,
        limit,
        before,
      }: {
        otherUid: string;
        limit?: number;
        before?: string; // ISO o epoch ms
      }) => {
        try {
          slog(
            socket,
            "chat:join received -> otherUid:",
            otherUid,
            "limit:",
            limit,
            "before:",
            before
          );
          if (!otherUid) return;

          const chatId = makeChatId(uid, otherUid);
          socket.join(`chat:${chatId}`);
          slog(
            socket,
            "joined chat room:",
            `chat:${chatId}`,
            "rooms:",
            Array.from(socket.rooms)
          );

          // Asegura la conversación (sin $inc aquí → seguro poner unread)
          const res = await Conversation.updateOne(
            { _id: chatId },
            {
              $setOnInsert: {
                _id: chatId,
                members: [uid, otherUid].sort() as any,
                unread: { [uid]: 0, [otherUid]: 0 },
                lastReadAt: { [uid]: null, [otherUid]: null },
              },
            },
            { upsert: true }
          );
          slog(socket, "chat:join upsert result:", {
            acknowledged: (res as any).acknowledged,
            matchedCount: (res as any).matchedCount,
            modifiedCount: (res as any).modifiedCount,
            upsertedId: (res as any).upsertedId,
          });

          // ----> HISTORIAL <----
          const lim = Math.min(Number(limit) || 50, 100);

          // Parse de 'before' opcional (ISO o ms)
          let beforeDate: Date | null = null;
          if (before) {
            const n = Number(before);
            if (isFinite(n) && String(n) === String(before)) {
              beforeDate = new Date(n);
            } else {
              beforeDate = new Date(before);
            }
            if (isNaN(beforeDate.getTime())) beforeDate = null;
          }

          const filter: any = { chatId };
          if (beforeDate) filter.createdAt = { $lt: beforeDate };

          // Trae DESC y revierte para entregar ASC (viejo -> nuevo)
          const pageDesc = await Message.find(filter)
            .sort({ createdAt: -1 })
            .limit(lim)
            .lean();

          const items = pageDesc.slice().reverse(); // ASC
          const hasMore = pageDesc.length === lim;
          const nextCursor =
            hasMore && items.length
              ? new Date(items[0].createdAt).toISOString() // el más antiguo del bloque actual
              : null;

          socket.emit("chat:history", { chatId, items, nextCursor });
          slog(socket, "chat:history emitted ->", {
            chatId,
            count: items.length,
            nextCursor,
          });

          socket.emit("chat:joined", { chatId });
          slog(socket, "chat:joined emitted ->", { chatId });
        } catch (err) {
          slog(socket, "chat:join error:", err);
        }
      }
    );

    // SEND
    socket.on(
      "message:send",
      async (payload: {
        to: string;
        text: string;
        clientId?: string;
        chatId?: string;
      }) => {
        const dbgId = Math.random().toString(36).slice(2, 8);
        slog(socket, `[${dbgId}] message:send received ->`, payload);
        try {
          const otherUid = payload.to;
          if (!otherUid) {
            slog(socket, `[${dbgId}] missing 'to' -> ignoring`);
            return;
          }
          const text = payload.text?.trim();
          if (!text) {
            slog(socket, `[${dbgId}] empty text -> ignoring`);
            return;
          }
          const chatId = payload.chatId || makeChatId(uid, otherUid);

          // Idempotencia
          if (payload.clientId) {
            const dup = await Message.findOne({
              chatId,
              clientId: payload.clientId,
            });
            if (dup) {
              slog(socket, `[${dbgId}] duplicate by clientId -> ACK existing`, {
                serverId: String(dup._id),
              });
              socket.emit("message:ack", {
                clientId: payload.clientId,
                serverId: String(dup._id),
                createdAt: dup.createdAt,
              });
              return;
            }
          }

          const nowDate = new Date();
          const msg = await Message.create({
            chatId,
            senderId: uid,
            text,
            clientId: payload.clientId,
            createdAt: nowDate,
            deliveredAt: nowDate,
          });
          slog(socket, `[${dbgId}] message saved ->`, {
            _id: String(msg._id),
            chatId,
            text: msg.text,
          });

          // Update conversación (sin unread en $setOnInsert para evitar conflicto con $inc)
          const ures = await Conversation.updateOne(
            { _id: chatId },
            {
              $setOnInsert: {
                _id: chatId,
                members: [uid, otherUid].sort() as any,
                lastReadAt: { [uid]: null, [otherUid]: null },
              },
              $set: {
                lastMessage: { text: msg.text, senderId: uid },
                lastMessageAt: msg.createdAt,
              },
              $inc: { [`unread.${otherUid}`]: 1 },
            },
            { upsert: true }
          );
          slog(socket, `[${dbgId}] conversation updated ->`, {
            acknowledged: (ures as any).acknowledged,
            matchedCount: (ures as any).matchedCount,
            modifiedCount: (ures as any).modifiedCount,
            upsertedId: (ures as any).upsertedId,
          });

          // ACK emisor
          socket.emit("message:ack", {
            clientId: payload.clientId,
            serverId: String(msg._id),
            createdAt: msg.createdAt,
          });
          slog(socket, `[${dbgId}] message:ack emitted`);

          // Emitir a destinatario y sala
          const eventPayload = {
            _id: String(msg._id),
            chatId,
            senderId: uid,
            text: msg.text,
            createdAt: msg.createdAt,
          };
          io.to(`user:${otherUid}`)
            .to(`chat:${chatId}`)
            .emit("message:new", eventPayload);
          slog(socket, `[${dbgId}] message:new emitted -> to rooms:`, [
            `user:${otherUid}`,
            `chat:${chatId}`,
          ]);
        } catch (e) {
          slog(socket, "message:send error:", e);
        }
      }
    );

    // READ
    socket.on("chat:read", async ({ chatId }: { chatId: string }) => {
      try {
        slog(socket, "chat:read received ->", { chatId });
        if (!chatId) return;
        const r = await Conversation.updateOne(
          { _id: chatId },
          { $set: { [`lastReadAt.${uid}`]: new Date(), [`unread.${uid}`]: 0 } },
          { upsert: true }
        );
        slog(socket, "chat:read update result:", {
          acknowledged: (r as any).acknowledged,
          matchedCount: (r as any).matchedCount,
          modifiedCount: (r as any).modifiedCount,
          upsertedId: (r as any).upsertedId,
        });

        io.to(`chat:${chatId}`).emit("chat:read", {
          chatId,
          by: uid,
          at: now(),
        });
        slog(socket, "chat:read emitted ->", { chatId, by: uid });
      } catch (err) {
        slog(socket, "chat:read error:", err);
      }
    });

    // TYPING
    socket.on(
      "typing",
      ({ chatId, isTyping }: { chatId: string; isTyping: boolean }) => {
        slog(socket, "typing received ->", { chatId, isTyping });
        if (!chatId) return;
        socket
          .to(`chat:${chatId}`)
          .emit("typing", { chatId, uid, isTyping: !!isTyping });
      }
    );

    // DISCONNECT
    socket.on("disconnect", (reason) => {
      slog(socket, "disconnect ->", reason);
      io.to(personalRoom).emit("presence", {
        uid,
        status: "offline",
        at: now(),
      });
    });
  });

  httpServer.listen(PORT, () => log(`listening on :${PORT}`));
}

// Extra: captura errores globales para debug
process.on("unhandledRejection", (reason) => {
  console.error(now(), "[UNHANDLED_REJECTION]", reason);
});
process.on("uncaughtException", (err) => {
  console.error(now(), "[UNCAUGHT_EXCEPTION]", err);
});

bootstrap().catch((err) => {
  console.error("Fatal error on bootstrap", err);
  process.exit(1);
});
