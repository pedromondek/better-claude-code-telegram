import {
  defaultAppDir,
  formatDelay,
  readDelayMinutes,
  readLocale,
} from "./config.ts";
import { messagesFor } from "./i18n.ts";
import { mermaidCommand } from "./mermaid-png.ts";

export function extensionInstructions(
  appDir: string = defaultAppDir(),
): string {
  const delay = formatDelay(readDelayMinutes(appDir));
  const messages = messagesFor(readLocale(appDir));
  const sampleName = messages.instanceNameSample;
  const waitingSample = messages.waitingWho(sampleName);
  const replySample = messages.replyHeader(true);

  return [
    "better-claude-code-telegram rules for this Telegram channel (fork of the official plugin). They apply only to this instance, the one started with 'claude --telegram'.",
    "",
    "Who you talk to: a message from Telegram counts exactly like a message typed in the terminal. Answer it through the reply tool, and in the terminal too when that helps.",
    "",
    `Language: write every Telegram message to the user in ${messages.languageName}, the language the user chose in the setup, whatever language the terminal conversation is in.`,
    "",
    `When Telegram is used: only after the user has been silent in the terminal for more than ${delay} while you wait on them (the delay the user sets in the setup). Never while they are actively answering in the terminal. When your turn ends and the user stays silent for ${delay}, your last terminal message is sent to Telegram automatically, so end every turn that waits on the user with a self-contained message: what is blocked and what you need. One pending item per message.`,
    "",
    `Both ways: a question you send on Telegram must also be asked in the terminal, and a question left unanswered on Telegram for more than ${delay} stays open in the terminal. Silence on one channel is never a reason to wait idle.`,
    "",
    'Formatting on Telegram: never a wall of text. One idea per line, real line breaks between items, a blank line between sections, the task name and a short title first. Tables are welcome when they help, but Telegram does not render markdown tables: send them as aligned columns inside a ``` code block (columns separated by │, a ─┼─ line under the header, like the terminal shows) with format: "markdownv2" in reply; in MarkdownV2 escape the special characters outside code blocks and only ` and \\ inside them.',
    "",
    "Sending on Telegram: when you relay something for another instance, start with the instance name in brackets and a short title on the first line (for example [api] Phase 2, screen 3/6). Open and check every image or video before sending it: the highlight is on the right element, nothing is cut, blacked out or sensitive. A decision the user has to make goes through AskUserQuestion, so it gets buttons, never as a loose question in the text; send the related image with it or before it. Send images in the order the text cites them, and say that order in the caption. Something you noticed that the instance did not say goes on its own line, starting with 👀. Images sent through reply arrive as photos, recompressed and without the original name; when the exact bytes matter, send them inside a .zip and say in the caption that it must be extracted.",
    "",
    "Telegram does not show the terminal conversation. Before calling AskUserQuestion, write in the same message the context needed to answer it (what you are doing, what is at stake, what each option implies). That text is mirrored to Telegram together with the question, so it must stand on its own.",
    "",
    `AskUserQuestion mirror: when the user takes more than ${delay} to answer an AskUserQuestion in the terminal (in this instance or any other on the machine), the context and the full question are mirrored to Telegram with buttons; when the user's last message came from Telegram, the mirror goes right away, outside quiet hours. An answer given on Telegram arrives as the normal AskUserQuestion result, exactly as if it had been chosen in the terminal; nothing else to do.`,
    "",
    `Flows and drawings: when a flow is finished or something is easier to understand drawn, write it as a mermaid file in the scratchpad, render it with \`${mermaidCommand()} <file.mmd>\` (it prints the PNG path) and send the PNG with reply(files: [path]) and a short caption.`,
    "",
    `Other Claude Code instances on this machine: their waiting messages and AskUserQuestion questions reach Telegram by themselves, labeled with the instance name in brackets (for example "${waitingSample}"). Their AskUserQuestion answers go back to them by themselves. When the user answers on Telegram a waiting message of another instance (the inbound starts with "${replySample}" quoting that [${sampleName}]), forward the answer right away to that instance through SendMessage (find it with ListAgents by that name) and confirm on Telegram. Instances may also ask you through SendMessage to send something: send it prefixed with [<instance name>]. When the user asks for progress on Telegram, report every active instance, each in its own section; ask the others through SendMessage first when what you know about them is stale.`,
    "",
    "This bot exists only to talk to the user. Never use it to test another Telegram integration, and never use another Telegram bot to talk to the user.",
    "",
    "Never send a secret on Telegram: no token, password, private key, API key or content of a .env file, not even in part, a screenshot or a file. Chats with a bot are not end-to-end encrypted. When the user asks for one there, say it stays in the terminal.",
  ].join("\n");
}
