import { Schema, model, Document } from "mongoose";

export interface IConversation extends Document {
  _id: string; // chatId = sorted(uidA, uidB)
  members: [string, string];
  lastMessage?: { text: string; senderId: string };
  lastMessageAt?: Date;
  unread: Record<string, number>; // { [uid]: count }
  lastReadAt: Record<string, Date | null>;
  createdAt: Date;
  updatedAt: Date;
}

const ConversationSchema = new Schema<IConversation>(
  {
    _id: { type: String },
    members: { type: [String], required: true },
    lastMessage: { text: String, senderId: String },
    lastMessageAt: { type: Date, index: true },
    unread: { type: Schema.Types.Mixed, default: {} },
    lastReadAt: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, versionKey: false }
);

ConversationSchema.index({ lastMessageAt: -1 });

export const Conversation = model<IConversation>(
  "Conversation",
  ConversationSchema
);
