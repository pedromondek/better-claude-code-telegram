import {
  defaultAppDir,
  formatDelay,
  readDelayMinutes,
  readLocale,
} from "./config.ts";
import { messagesFor } from "./i18n.ts";

export const CHANNEL_GUIDE_SKILL = "telegram:channel-guide";

export function extensionInstructions(
  appDir: string = defaultAppDir(),
): string {
  const questionDelay = formatDelay(
    readDelayMinutes(appDir, process.env, "questions"),
  );
  const waitingDelay = formatDelay(
    readDelayMinutes(appDir, process.env, "waiting"),
  );
  const messages = messagesFor(readLocale(appDir));
  const sampleName = messages.instanceNameSample;
  const waitingSample = messages.waitingWho(sampleName);
  const replySample = messages.replyHeader(true);

  return [
    "better-claude-code-telegram rules for this Telegram channel (fork of the official plugin), only for the instance started with 'claude --telegram'.",
    "",
    "Never send a secret on Telegram: no token, password, private key, API key or .env content, not even in part, a screenshot or a file. Bot chats are not end-to-end encrypted; if asked there, say it stays in the terminal.",
    "",
    "This bot exists only to talk to the user: never test another Telegram integration with it, never reach the user through another bot.",
    "",
    `Who you talk to: a Telegram message counts as one typed in the terminal. Answer it with the reply tool, in ${messages.languageName} (the setup language), whatever the terminal language.`,
    "",
    `AskUserQuestion: decisions go through it, never as a loose question in the text. Telegram does not show the terminal, so put in the same message the context needed to answer (what you are doing, what is at stake, what each option implies). After more than ${questionDelay} without an answer in the terminal, or at once when the user's last message came from Telegram (outside quiet hours), context and question are mirrored there; an answer given there returns as the normal result.`,
    "",
    `Waiting: after more than ${waitingDelay} of terminal silence while you wait on the user, your last terminal message goes to Telegram by itself, so end every turn that waits with a self-contained message (what is blocked, what you need, one item per message). A question sent on Telegram is also asked in the terminal; silence on one channel is no reason to wait idle.`,
    "",
    "Formatting on Telegram: never a wall of text; one idea per line, a blank line between sections, the task name and a short title first.",
    "",
    `Tables, images, videos and drawings: before sending a table, an image or a video, and when a flow is easier to understand drawn, load the ${CHANNEL_GUIDE_SKILL} skill.`,
    "",
    `Other instances: their waiting messages and questions reach Telegram by themselves ("${waitingSample}") and their answers come back by themselves. An inbound starting with "${replySample}" that quotes [${sampleName}] goes at once to that instance by SendMessage (ListAgents by name), then is confirmed on Telegram. What an instance asks you to send starts with [<name>] and a short title (e.g. [api] Phase 2); what you noticed that it did not say goes on its own line starting with 👀. Asked for progress, report every active instance in its own section, asking them by SendMessage when what you know is stale.`,
  ].join("\n");
}
