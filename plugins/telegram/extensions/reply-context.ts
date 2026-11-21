import type { Messages } from "./i18n.ts";

export interface RepliedMessage {
  text?: string;
  caption?: string;
  from?: { id: number; first_name: string };
}

export interface ReplyParticipants {
  senderId: number;
  botId: number;
}

function headerFor(
  from: RepliedMessage["from"],
  { senderId, botId }: ReplyParticipants,
  messages: Messages,
): string {
  if (from === undefined || from.id === senderId) {
    return messages.replyHeader(false);
  }

  return from.id === botId
    ? messages.replyHeader(true)
    : messages.replyHeaderOther(from.first_name);
}

export function withReplyContext(
  text: string,
  replied: RepliedMessage | undefined,
  participants: ReplyParticipants,
  messages: Messages,
): string {
  const message: RepliedMessage = replied ?? {};
  const repliedText = message.text ?? message.caption;

  if (!repliedText?.trim()) return text;

  const header = headerFor(message.from, participants, messages);

  return `${header}:\n«${repliedText.trim()}»\n\n${text}`;
}
