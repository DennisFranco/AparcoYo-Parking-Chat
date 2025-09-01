import { Schema, model, Document, Types } from "mongoose";

export interface IMessage extends Document {
  _id: Types.ObjectId;
  chatId: string;
  senderId: string;
  text: string;
  clientId?: string; // id cliente para idempotencia
  createdAt: Date;
  deliveredAt?: Date;
  seenAt?: Date;
}

const MessageSchema = new Schema<IMessage>(
  {
    chatId: { type: String, index: true, required: true },
    senderId: { type: String, required: true, index: true },
    text: { type: String, required: true },
    clientId: { type: String, index: true },
    createdAt: { type: Date, default: () => new Date(), index: true },
    deliveredAt: { type: Date },
    seenAt: { type: Date },
  },
  { timestamps: false, versionKey: false }
);

MessageSchema.index({ chatId: 1, createdAt: -1 });
MessageSchema.index(
  { chatId: 1, clientId: 1 },
  { unique: true, partialFilterExpression: { clientId: { $exists: true } } }
);

export const Message = model<IMessage>("Message", MessageSchema);
