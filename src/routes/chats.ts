// src/routes/chats.ts
import { Router } from "express";
import { Conversation } from "../models/Conversation";
import { Message } from "../models/Message";

const router = Router();

// Ping / salud
router.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * GET /api/chats?uid=USER_ID
 * Lista las conversaciones de un usuario ordenadas por lastMessageAt DESC.
 * Devuelve unread solo para ese uid (ya resuelto) y otros campos útiles.
 */
router.get("/chats", async (req, res) => {
  try {
    const uid = String(req.query.uid || "");
    if (!uid)
      return res
        .status(400)
        .json({ ok: false, msg: "uid is required (query)" });

    const chats = await Conversation.find({ members: uid })
      .sort({ lastMessageAt: -1 })
      .lean();

    const items = chats.map((c: any) => ({
      chatId: String(c._id),
      members: c.members,
      lastMessageAt: c.lastMessageAt ?? null,
      lastMessage: c.lastMessage ?? null,
      unread: c.unread && typeof c.unread[uid] === "number" ? c.unread[uid] : 0,
      lastReadAt: c.lastReadAt?.[uid] ?? null,
    }));

    res.json({ ok: true, items });
  } catch (err: any) {
    console.error("[API] /chats error:", err);
    res.status(500).json({ ok: false, msg: err?.message || "Server error" });
  }
});

/**
 * GET /api/chats/:chatId/messages
 * Query params:
 *  - limit: número de mensajes a devolver (1..100, default 50)
 *  - before | cursor: ISO date (o epoch ms) para paginar hacia atrás (mensajes más antiguos)
 *
 * Comportamiento:
 *  - Sin cursor: trae los últimos N mensajes (más nuevos), los ordena ASC para la UI.
 *  - Con cursor/before: trae N mensajes más antiguos que el cursor, ordena ASC.
 *  - nextCursor: createdAt del mensaje más antiguo del bloque devuelto (ISO) si hay más por cargar.
 */
router.get("/chats/:chatId/messages", async (req, res) => {
  try {
    const { chatId } = req.params;

    // Sanitizar limit
    const limRaw = Number(req.query.limit);
    const limit = Math.min(
      Math.max(isFinite(limRaw) && limRaw > 0 ? limRaw : 50, 1),
      100
    );

    // Acepta before o cursor como sinónimos
    const cursorParam = (req.query.before ?? req.query.cursor) as
      | string
      | undefined;

    let cursorDate: Date | null = null;
    if (cursorParam) {
      // Acepta ISO o epoch ms
      const maybeMs = Number(cursorParam);
      if (isFinite(maybeMs) && String(maybeMs) === cursorParam) {
        cursorDate = new Date(maybeMs);
      } else {
        cursorDate = new Date(cursorParam);
      }
      if (isNaN(cursorDate.getTime())) {
        return res
          .status(400)
          .json({ ok: false, msg: "Invalid 'before/cursor' date" });
      }
    }

    const filter: any = { chatId };
    if (cursorDate) filter.createdAt = { $lt: cursorDate };

    // Trae DESC y revierte para entregar ASC (viejo -> nuevo)
    const pageDesc = await Message.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const items = pageDesc.slice().reverse(); // ASC

    // Si devolvimos exactamente 'limit', asumimos que puede haber más antiguos.
    const hasMore = pageDesc.length === limit;
    const nextCursor =
      hasMore && items.length
        ? new Date(items[0].createdAt).toISOString() // el más antiguo del bloque actual
        : null;

    res.json({ ok: true, items, nextCursor, count: items.length });
  } catch (err: any) {
    console.error("[API] /chats/:chatId/messages error:", err);
    res.status(500).json({ ok: false, msg: err?.message || "Server error" });
  }
});

export default router;
