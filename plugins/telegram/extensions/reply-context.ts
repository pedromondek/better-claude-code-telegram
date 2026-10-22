import type { Messages } from "./i18n.ts";

export interface RepliedMessage {
  text?: string;
  caption?: string;
  from?: { is_bot?: boolean };
}

export function withReplyContext(
  text: string,
  replied: RepliedMessage | undefined,
  messages: Messages,
): string {
  const message: RepliedMessage = replied ?? {};
  const repliedText = message.text ?? message.caption;

  if (!repliedText?.trim()) return text;

  const header = messages.replyHeader(message.from?.is_bot === true);

  return `${header}:\n«${repliedText.trim()}»\n\n${text}`;
}
