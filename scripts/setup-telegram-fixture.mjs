import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MESSAGES } from "../plugins/telegram-hooks/lib/messages.mjs";
import {
  NOW,
  REPO_ROOT,
  materialize,
  placeholders,
  snapshot,
  writeFixture,
} from "./fixture-support.mjs";
import {
  buildAccess,
  createTelegramApi,
  findPairingCandidate,
  isPaired,
  lastUpdateId,
  pairingCode,
  pairingLink,
  parseEnvToken,
  telegramApiRoot,
} from "./setup.mjs";
import { fail, warn } from "./ui.mjs";

const SELF = fileURLToPath(import.meta.url);
const SETUP_URL = pathToFileURL(join(REPO_ROOT, "scripts", "setup.mjs")).href;
const INTERNALS =
  "ensureToken, loadSavedBot, ensurePairing, journal, interruption";
const HOOK = `export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (url !== ${JSON.stringify(SETUP_URL)}) return loaded;
  return { ...loaded, source: String(loaded.source) + "\\nexport { ${INTERNALS} };\\n" };
}`;
const REGISTER = `import{register}from"node:module";register(${JSON.stringify(
  `data:text/javascript,${encodeURIComponent(HOOK)}`,
)});`;
const CHILD_FLAGS = [
  `--import=data:text/javascript,${encodeURIComponent(REGISTER)}`,
];
const TOKEN = "123:FAKE";
const OTHER_TOKEN = "456:OTHER";
const CODE_BYTES = [0xab, 0xcd, 0xef, 0x01];
const CODE = "abcdef01";
const ENV_FILE = "state/.env";
const ACCESS_FILE = "state/access.json";
const PID_FILE = "state/bot.pid";
const SAVED_ENV = `TELEGRAM_BOT_TOKEN=${TOKEN}\n`;
const BOT = { token: TOKEN, username: "e2e_bot" };

const json = (value) => JSON.stringify(value);
const reply = (method, body, extra = {}) => ({
  method,
  status: 200,
  body: json(body),
  ...extra,
});
const raw = (method, body, status = 200) => ({ method, status, body });
const ok = (method, result) => reply(method, { ok: true, result });
const refused = (method, description = "Unauthorized") =>
  reply(method, { ok: false, description });
const drop = (method) => ({ method, drop: true });
const hold = (method) => ({ method, hold: true });
const getMe = (bot = {}) =>
  ok("getMe", { username: "e2e_bot", can_join_groups: false, ...bot });
const noWebhook = ok("getWebhookInfo", { url: "" });
const message = (updateId, from, text, chat = "private") => ({
  update_id: updateId,
  message: { chat: { type: chat }, from, text },
});
const dev = { id: 42, username: "dev" };
const stranger = { id: 13, username: "stranger" };
const access = (extra = {}) =>
  json({ dmPolicy: "allowlist", allowFrom: ["42"], ...extra });

const pure = {
  parseEnvToken: [
    `OTHER=1\nTELEGRAM_BOT_TOKEN=${TOKEN}\n`,
    "OTHER=1\n",
    "",
    "TELEGRAM_BOT_TOKEN=",
    "TELEGRAM_BOT_TOKEN= \n",
    "TELEGRAM_BOT_TOKEN=  a b  \r\nX=1",
    "X=1\rTELEGRAM_BOT_TOKEN=c d",
    " TELEGRAM_BOT_TOKEN=x",
    "TELEGRAM_BOT_TOKEN=\nTELEGRAM_BOT_TOKEN=second",
    "telegram_bot_token=x",
  ].map((input) => ({ input, output: parseEnvToken(input) })),
  isPaired: [
    {},
    { access: null },
    { access: { allowFrom: ["1"] } },
    { access: { allowFrom: [] } },
    { access: { allowFrom: "12" } },
    { access: { allowFrom: [null] } },
    { access: { allowFrom: {} } },
    { access: [] },
    { access: "allowFrom" },
    { access: 0 },
    { access: { dmPolicy: "allowlist" } },
  ].map((input) => ({ ...input, output: isPaired(input.access) })),
  buildAccess: [
    { current: null, userId: "42" },
    {
      current: {
        dmPolicy: "pairing",
        allowFrom: ["7", "42"],
        groups: { "-1": { requireMention: true, allowFrom: [] } },
        pending: { abc: {} },
        ackReaction: "eyes",
      },
      userId: "99",
    },
    { current: { pending: 1, extra: true, allowFrom: [] }, userId: "5" },
    { current: { 2: "b", 1: "a", z: 0 }, userId: "5" },
    { current: "ab", userId: "5" },
    { current: [3, 4], userId: "5" },
    { current: 7, userId: "5" },
    { current: false, userId: "undefined" },
  ].map((input) => ({
    ...input,
    output: `${JSON.stringify(buildAccess(input.current, input.userId), null, 2)}\n`,
  })),
  pairingCode: [CODE_BYTES, [0, 1, 2, 255], [16, 32, 0x7f, 0x80]].map(
    (bytes) => ({
      bytes,
      output: pairingCode(() => Buffer.from(bytes)),
    }),
  ),
  pairingLink: [
    ["e2e_bot", CODE],
    ["undefined", "00010203"],
    ["a b", "x"],
  ].map(([username, code]) => ({
    username,
    code,
    output: pairingLink(username, code),
  })),
  findPairingCandidate: [
    {},
    { updates: null },
    { updates: 5 },
    { updates: "ab" },
    { updates: {} },
    { updates: [] },
    { updates: [null] },
    { updates: [5, "x", true, []] },
    { updates: [{ message: null }, { message: 5 }, { message: { chat: 5 } }] },
    { updates: [{ update_id: 1, callback_query: {} }] },
    {
      updates: [
        { update_id: 1, message: { chat: { type: "group" }, from: { id: 9 } } },
        message(2, dev, `/start ${CODE}`),
      ],
    },
    { updates: [message(3, { id: 7, first_name: "Ana" }, `  ${CODE}  `)] },
    {
      updates: [
        message(4, stranger, "/start"),
        message(5, stranger, "hi"),
        message(6, dev, `/start ${CODE}`),
      ],
    },
    { updates: [message(4, stranger, "/start"), message(5, stranger, "hi")] },
    { updates: [message(7, dev, `/start  ${CODE}`)] },
    { updates: [message(7, dev, `/START ${CODE}`)] },
    { updates: [message(7, dev, `${CODE}x`)] },
    { updates: [message(7, dev, ` ${CODE}\n`)] },
    { updates: [message(8, dev, `/start ${CODE}`, "Private")] },
    { updates: [message(8, null, CODE)] },
    { updates: [message(8, 0, CODE)] },
    { updates: [message(8, 5, CODE)] },
    { updates: [message(8, "x", CODE)] },
    { updates: [message(8, {}, CODE)] },
    { updates: [message(8, { id: null }, CODE)] },
    { updates: [message(8, { id: 1e21, username: 0, first_name: {} }, CODE)] },
    { updates: [message(8, { id: "7", username: "" }, CODE)] },
    { updates: [message(8, { id: 7.5, username: 5 }, CODE)] },
    { updates: [message(8, { id: [1, 2], username: ["a", "b"] }, CODE)] },
    { updates: [message(8, { id: -3, first_name: null }, CODE)] },
    {
      updates: [
        { message: { chat: { type: "private" }, from: dev, text: CODE } },
      ],
    },
    {
      updates: [
        {
          update_id: "9",
          message: { chat: { type: "private" }, from: dev, text: CODE },
        },
      ],
    },
    { updates: [message(9, dev, 5)] },
    { updates: [message(9, dev, null)] },
    { updates: [message(9, dev, ["ab"])] },
    { updates: [message(9, dev, {})] },
    { updates: [message(9, dev, true)] },
    {
      updates: [
        { update_id: 9, message: { chat: { type: "private" }, from: dev } },
      ],
    },
    { updates: [message(9, dev, 5, "group"), message(10, null, 5)] },
    { updates: [message(9, dev, `/start ${CODE}`)], code: "" },
    { updates: [message(9, dev, "/start")], code: "" },
    { updates: [message(9, dev, "")], code: "" },
  ].map((input) => {
    const code = input.code ?? CODE;

    try {
      const found = findPairingCandidate(input.updates, code);

      return { ...input, code, output: found === null ? null : json(found) };
    } catch (error) {
      return { ...input, code, error: error.message };
    }
  }),
  lastUpdateId: [
    {},
    { updates: null },
    { updates: 5 },
    { updates: "ab" },
    { updates: {} },
    { updates: [] },
    { updates: [null] },
    { updates: [{ update_id: 5 }, { update_id: 9 }, { update_id: 7 }] },
    { updates: [{ update_id: -5 }] },
    { updates: [{ update_id: "5" }] },
    { updates: [{ update_id: " 12 " }] },
    { updates: [{ update_id: "0x10" }] },
    { updates: [{ update_id: "x" }, { update_id: 9 }] },
    { updates: [{}] },
    { updates: [{ update_id: [7] }] },
    { updates: [{ update_id: ["8"] }, { update_id: 3 }] },
    { updates: [{ update_id: [1, 2] }] },
    { updates: [{ update_id: [] }] },
    { updates: [{ update_id: {} }] },
    { updates: [{ update_id: true }] },
    { updates: [{ update_id: false }] },
    { updates: [{ update_id: null }] },
    { updates: [{ update_id: 2.5 }] },
    { updates: [{ update_id: "Infinity" }] },
    { updates: [{ update_id: 2 ** 53 + 2 }] },
    { updates: [5, "x"] },
  ].map((input) => {
    try {
      return { ...input, output: json(lastUpdateId(input.updates)) };
    } catch (error) {
      return { ...input, error: error.message };
    }
  }),
  telegramApiRoot: [
    {},
    { root: "" },
    { root: "http://127.0.0.1:9999" },
    { root: " " },
  ].map((input) => ({
    ...input,
    output: telegramApiRoot(
      input.root === undefined
        ? {}
        : { BETTER_CC_TELEGRAM_API_ROOT: input.root },
    ),
  })),
};

const telegram = { replies: [], requests: [], used: new Set() };

function pickReply(method, body) {
  let chatId = null;

  try {
    chatId = String(JSON.parse(body).chat_id);
  } catch {}

  const index = telegram.replies.findIndex(
    (candidate, position) =>
      !telegram.used.has(position) &&
      candidate.method === method &&
      (candidate.chatId === undefined || candidate.chatId === chatId),
  );

  if (index === -1) return raw(method, json({ ok: false }), 500);

  telegram.used.add(index);

  return telegram.replies[index];
}

const server = createServer((request, response) => {
  const chunks = [];

  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const method = (request.url ?? "").split("/").pop() ?? "";

    telegram.requests.push({
      method: request.method,
      path: request.url,
      contentType: request.headers["content-type"] ?? null,
      body,
    });

    const answer = pickReply(method, body);

    if (answer.drop) {
      request.socket.destroy();
      return;
    }

    if (answer.hold) return;

    response.writeHead(answer.status, {
      "content-type": "application/json",
      connection: "close",
    });
    response.end(
      answer.bytes === undefined
        ? Buffer.from(answer.body)
        : Buffer.from(answer.bytes),
    );
  });
});

function normalizedRequests(requests) {
  const out = [];
  let run = [];
  const flush = () => {
    out.push(
      ...run.toSorted((left, right) =>
        left.body < right.body ? -1 : Number(left.body > right.body),
      ),
    );
    run = [];
  };

  for (const request of requests) {
    if (request.path.endsWith("/getChat")) {
      run.push(request);
      continue;
    }

    flush();
    out.push(request);
  }

  flush();

  return out;
}

const api = [];

function addApi(name, options) {
  api.push({
    name,
    locale: options.locale ?? "en-us",
    method: options.method ?? "getMe",
    params: options.params ?? {},
    root: options.root ?? "",
    replies: options.replies,
  });
}

addApi("calls the bot method with JSON params and returns the result", {
  params: { a: 1 },
  replies: [ok("getMe", { username: "bcct_bot" })],
});
addApi("a result that is missing is undefined", {
  replies: [reply("getMe", { ok: true })],
});
addApi("a refusal in en-us", { replies: [refused("getMe")] });
addApi("a refusal in pt-br", {
  locale: "pt-br",
  replies: [refused("getMe")],
});
addApi("a refusal without a description", {
  replies: [reply("getMe", { ok: false })],
});
addApi("a refusal with a null description", {
  replies: [reply("getMe", { ok: false, description: null })],
});
addApi("a refusal with a number as the description", {
  replies: [reply("getMe", { ok: false, description: 5 })],
});
addApi("a truthy ok that is not true", {
  replies: [reply("getMe", { ok: "yes", result: [1] })],
});
addApi("a falsy ok that is not false", {
  replies: [reply("getMe", { ok: 0, result: 1 })],
});
addApi("a null body", { replies: [raw("getMe", "null")] });
addApi("a text body", { replies: [raw("getMe", '"ok"')] });
addApi("a body that is not JSON", { replies: [raw("getMe", "<html>")] });
addApi("a body with a byte order mark", {
  replies: [raw("getMe", `﻿${json({ ok: true, result: 2 })}`)],
});
addApi("a server error that still says ok", {
  replies: [raw("getMe", json({ ok: true, result: "x" }), 500)],
});
addApi("a dropped connection in en-us", { replies: [drop("getMe")] });
addApi("a dropped connection in pt-br", {
  locale: "pt-br",
  replies: [drop("getMe")],
});
addApi("the params of a long poll", {
  method: "getUpdates",
  params: { offset: 7, timeout: 30, allowed_updates: ["message"] },
  replies: [ok("getUpdates", [])],
});
addApi("a message with text outside ASCII", {
  method: "sendMessage",
  params: { chat_id: "42", text: "Pareado com o Claude Code.\n\nçé 😀" },
  replies: [ok("sendMessage", { message_id: 1 })],
});
addApi("an API root with a path", {
  root: "/base",
  replies: [ok("getMe", true)],
});

const flows = [];

function addFlow(name, options) {
  flows.push({
    name,
    kind: options.kind,
    locale: options.locale ?? "en-us",
    offerSaved: options.offerSaved ?? false,
    bot: options.bot ?? BOT,
    userIds: options.userIds ?? [],
    input: options.input ?? "",
    files: options.files ?? {},
    replies: options.replies ?? [],
    random: options.random ?? CODE_BYTES,
    clockStep: options.clockStep ?? 0,
    abortAfter: options.abortAfter ?? null,
    running: options.running ?? false,
    terminal: options.terminal ?? null,
    forceColor: options.forceColor ?? false,
  });
}

addFlow("token: a fresh token is checked and saved privately", {
  kind: "token",
  input: `  ${TOKEN}  \n`,
  replies: [getMe()],
});
addFlow("token: a bot that can join groups gets the warning", {
  kind: "token",
  input: `${TOKEN}\n`,
  replies: [getMe({ can_join_groups: true })],
});
addFlow("token: only true counts as joining groups", {
  kind: "token",
  input: `${TOKEN}\n`,
  replies: [getMe({ can_join_groups: "true" })],
});
addFlow("token: the warning in pt-br with colors", {
  kind: "token",
  locale: "pt-br",
  forceColor: true,
  input: `${TOKEN}\n`,
  replies: [getMe({ can_join_groups: true })],
});
addFlow("token: on a terminal the check spins and the line is replaced", {
  kind: "token",
  terminal: 80,
  input: `${TOKEN}\n`,
  replies: [getMe()],
});
addFlow("token: on a narrow terminal the spinner label is cut", {
  kind: "token",
  locale: "pt-br",
  terminal: 12,
  input: `${TOKEN}\n`,
  replies: [getMe({ can_join_groups: true })],
});
addFlow("token: a refused token saves nothing", {
  kind: "token",
  input: `${TOKEN}\n`,
  replies: [refused("getMe", "Not Found")],
});
addFlow("token: a refused token on a terminal clears the spinner", {
  kind: "token",
  terminal: 80,
  input: `${TOKEN}\n`,
  replies: [refused("getMe", "Not Found")],
});
addFlow("token: a network failure saves nothing, in pt-br", {
  kind: "token",
  locale: "pt-br",
  input: `${TOKEN}\n`,
  replies: [drop("getMe")],
});
addFlow("token: an empty answer still asks Telegram", {
  kind: "token",
  input: "   \n",
  replies: [refused("getMe", "Not Found")],
});
addFlow("token: the input ends before the token", {
  kind: "token",
  input: "",
});
addFlow("token: a missing result saves the file and then fails", {
  kind: "token",
  input: `${TOKEN}\n`,
  replies: [reply("getMe", { ok: true })],
});
addFlow("token: a null result saves the file and then fails", {
  kind: "token",
  input: `${TOKEN}\n`,
  replies: [ok("getMe", null)],
});
addFlow("token: a result that is not an object has no username", {
  kind: "token",
  input: `${TOKEN}\n`,
  replies: [ok("getMe", 5)],
});
addFlow("token: an odd username is shown as JavaScript shows it", {
  kind: "token",
  input: `${TOKEN}\n`,
  replies: [getMe({ username: ["a", "b"], can_join_groups: true })],
});
addFlow("token: an existing .env is replaced", {
  kind: "token",
  input: `${OTHER_TOKEN}\n`,
  files: {
    "state/": "",
    [ENV_FILE]: { content: "OLD=1\nTELEGRAM_BOT_TOKEN=x\n", mode: 0o644 },
    "state/other": "kept",
  },
  replies: [getMe()],
});
addFlow("token: a missing parent folder is created privately", {
  kind: "token",
  input: `${TOKEN}\n`,
  replies: [getMe()],
});
addFlow("token: the saved bot is offered and Enter keeps it", {
  kind: "token",
  offerSaved: true,
  input: "\n",
  files: { [ENV_FILE]: SAVED_ENV },
  replies: [getMe({ can_join_groups: true })],
});
addFlow("token: the saved bot is kept with yes in pt-br", {
  kind: "token",
  locale: "pt-br",
  offerSaved: true,
  input: "Sim\n",
  files: { [ENV_FILE]: SAVED_ENV },
  replies: [getMe()],
});
addFlow("token: the saved bot is offered with colors", {
  kind: "token",
  offerSaved: true,
  forceColor: true,
  input: "y\n",
  files: { [ENV_FILE]: SAVED_ENV },
  replies: [getMe()],
});
addFlow("token: declining the saved bot asks for another token", {
  kind: "token",
  offerSaved: true,
  input: `n\n${OTHER_TOKEN}\n`,
  files: { [ENV_FILE]: SAVED_ENV },
  replies: [getMe(), getMe({ username: "other_bot" })],
});
addFlow("token: any other answer declines the saved bot", {
  kind: "token",
  offerSaved: true,
  input: `ok\n${OTHER_TOKEN}\n`,
  files: { [ENV_FILE]: SAVED_ENV },
  replies: [getMe(), getMe({ username: "other_bot" })],
});
addFlow("token: a saved token Telegram refuses is not offered", {
  kind: "token",
  offerSaved: true,
  input: `${OTHER_TOKEN}\n`,
  files: { [ENV_FILE]: SAVED_ENV },
  replies: [refused("getMe"), getMe({ username: "other_bot" })],
});
addFlow("token: a saved token that cannot be checked is not offered", {
  kind: "token",
  offerSaved: true,
  input: `${OTHER_TOKEN}\n`,
  files: { [ENV_FILE]: SAVED_ENV },
  replies: [drop("getMe"), getMe({ username: "other_bot" })],
});
addFlow("token: a saved bot without a result is not offered", {
  kind: "token",
  offerSaved: true,
  input: `${OTHER_TOKEN}\n`,
  files: { [ENV_FILE]: SAVED_ENV },
  replies: [reply("getMe", { ok: true }), getMe({ username: "other_bot" })],
});
addFlow("token: a saved bot that is not an object is offered as undefined", {
  kind: "token",
  offerSaved: true,
  input: "\n",
  files: { [ENV_FILE]: SAVED_ENV },
  replies: [ok("getMe", 7)],
});
addFlow("token: a saved token that is blank is not offered", {
  kind: "token",
  offerSaved: true,
  input: `${TOKEN}\n`,
  files: { [ENV_FILE]: "TELEGRAM_BOT_TOKEN=  \n" },
  replies: [getMe()],
});
addFlow("token: without offering, the saved token is not checked", {
  kind: "token",
  input: `${OTHER_TOKEN}\n`,
  files: { [ENV_FILE]: SAVED_ENV },
  replies: [getMe({ username: "other_bot" })],
});
addFlow("token: offering with no saved token asks for one", {
  kind: "token",
  offerSaved: true,
  input: `${TOKEN}\n`,
  replies: [getMe()],
});
addFlow("token: the input ends on the saved bot question", {
  kind: "token",
  offerSaved: true,
  input: "",
  files: { [ENV_FILE]: SAVED_ENV },
  replies: [getMe()],
});
addFlow("token: the saved bot check spins on a terminal", {
  kind: "token",
  offerSaved: true,
  terminal: 80,
  input: "\n",
  files: { [ENV_FILE]: SAVED_ENV },
  replies: [getMe()],
});

addFlow("saved bot: no saved token asks for the token step", {
  kind: "savedBot",
});
addFlow("saved bot: no saved token in pt-br", {
  kind: "savedBot",
  locale: "pt-br",
});
addFlow("saved bot: a blank token counts as none", {
  kind: "savedBot",
  files: { [ENV_FILE]: "TELEGRAM_BOT_TOKEN= \n" },
});
addFlow("saved bot: the saved token is checked", {
  kind: "savedBot",
  files: { [ENV_FILE]: `X=1\nTELEGRAM_BOT_TOKEN= ${TOKEN} \n` },
  replies: [getMe({ can_join_groups: true })],
});
addFlow("saved bot: the check spins on a terminal", {
  kind: "savedBot",
  terminal: 80,
  files: { [ENV_FILE]: SAVED_ENV },
  replies: [getMe()],
});
addFlow("saved bot: a refused token stops", {
  kind: "savedBot",
  files: { [ENV_FILE]: SAVED_ENV },
  replies: [refused("getMe")],
});
addFlow("saved bot: a null result stops", {
  kind: "savedBot",
  files: { [ENV_FILE]: SAVED_ENV },
  replies: [ok("getMe", null)],
});
addFlow("saved bot: a missing result stops", {
  kind: "savedBot",
  files: { [ENV_FILE]: SAVED_ENV },
  replies: [reply("getMe", { ok: true })],
});

const backlog = ok("getUpdates", []);
const codeMessage = (updateId = 7, from = dev, text = `/start ${CODE}`) =>
  ok("getUpdates", [message(updateId, from, text)]);
const finishing = [ok("getUpdates", []), ok("sendMessage", { message_id: 1 })];
const fresh = (extra = []) => [
  noWebhook,
  backlog,
  codeMessage(),
  ...finishing,
  ...extra,
];

addFlow("pairing: a fresh pairing saves the account and greets it", {
  kind: "pairing",
  input: "\n",
  files: { "state/": "" },
  replies: fresh(),
});
addFlow("pairing: in pt-br with colors", {
  kind: "pairing",
  locale: "pt-br",
  forceColor: true,
  input: "s\n",
  files: { "state/": "" },
  replies: fresh(),
});
addFlow("pairing: on a terminal every wait spins", {
  kind: "pairing",
  terminal: 80,
  input: "\n",
  files: { "state/": "" },
  replies: fresh(),
});
addFlow("pairing: another code makes another link", {
  kind: "pairing",
  random: [0, 1, 2, 3],
  input: "\n",
  files: { "state/": "" },
  replies: [noWebhook, backlog, codeMessage(7, dev, "00010203"), ...finishing],
});
addFlow("pairing: the backlog is skipped and strangers are ignored", {
  kind: "pairing",
  input: "y\n",
  files: { "state/": "" },
  replies: [
    noWebhook,
    ok("getUpdates", [message(5, stranger, "old"), message(3, dev, CODE)]),
    ok("getUpdates", [
      message(6, stranger, "/start"),
      message(9, { id: 9 }, `/start ${CODE}`, "group"),
    ]),
    ok("getUpdates", []),
    ok("getUpdates", [message(11, { id: 7, first_name: "Ana" }, `  ${CODE} `)]),
    ...finishing,
  ],
});
addFlow("pairing: the offset never goes back", {
  kind: "pairing",
  input: "\n",
  files: { "state/": "" },
  replies: [
    noWebhook,
    ok("getUpdates", [message(20, stranger, "x")]),
    ok("getUpdates", [message(4, stranger, "x")]),
    codeMessage(30),
    ...finishing,
  ],
});
addFlow("pairing: an update id that is text adds as JavaScript adds", {
  kind: "pairing",
  input: "\n",
  files: { "state/": "" },
  replies: [
    noWebhook,
    ok("getUpdates", [{ update_id: "8" }]),
    ok("getUpdates", [
      {
        update_id: "9",
        message: { chat: { type: "private" }, from: dev, text: CODE },
      },
    ]),
    ...finishing,
  ],
});
addFlow("pairing: an update id that is missing turns the offsets into null", {
  kind: "pairing",
  input: "\n",
  files: { "state/": "" },
  replies: [
    noWebhook,
    ok("getUpdates", [{}]),
    ok("getUpdates", [
      { message: { chat: { type: "private" }, from: dev, text: CODE } },
    ]),
    ...finishing,
  ],
});
addFlow("pairing: an account without a username shows the first name", {
  kind: "pairing",
  input: "\n",
  files: { "state/": "" },
  replies: [
    noWebhook,
    backlog,
    codeMessage(7, { id: 7, first_name: "Ana" }, CODE),
    ...finishing,
  ],
});
addFlow("pairing: an account without a name shows undefined", {
  kind: "pairing",
  input: "\n",
  files: { "state/": "" },
  replies: [noWebhook, backlog, codeMessage(7, { id: 7 }, CODE), ...finishing],
});
addFlow("pairing: declining the account cancels without saving", {
  kind: "pairing",
  input: "n\n",
  files: { "state/": "" },
  replies: fresh(),
});
addFlow("pairing: the input ends on the confirmation", {
  kind: "pairing",
  input: "",
  files: { "state/": "" },
  replies: fresh(),
});
addFlow("pairing: an open Telegram instance stops before Telegram", {
  kind: "pairing",
  running: true,
  files: { [PID_FILE]: "{pid}\n" },
  replies: fresh(),
});
addFlow("pairing: an open Telegram instance in pt-br", {
  kind: "pairing",
  locale: "pt-br",
  running: true,
  files: { [PID_FILE]: "{pid}" },
});
addFlow("pairing: a bot with a webhook cannot pair", {
  kind: "pairing",
  replies: [ok("getWebhookInfo", { url: "https://example.com/hook" })],
});
addFlow("pairing: a bot with a webhook in pt-br on a terminal", {
  kind: "pairing",
  locale: "pt-br",
  terminal: 80,
  replies: [ok("getWebhookInfo", { url: "https://example.com/hook" })],
});
addFlow("pairing: a webhook info without a result stops", {
  kind: "pairing",
  replies: [reply("getWebhookInfo", { ok: true })],
});
addFlow("pairing: a webhook info with a null result stops", {
  kind: "pairing",
  replies: [ok("getWebhookInfo", null)],
});
addFlow("pairing: a webhook info that is not an object goes on", {
  kind: "pairing",
  input: "\n",
  files: { "state/": "" },
  replies: [ok("getWebhookInfo", 1), backlog, codeMessage(), ...finishing],
});
addFlow("pairing: a refused webhook check stops", {
  kind: "pairing",
  replies: [refused("getWebhookInfo")],
});
addFlow("pairing: a refused backlog stops", {
  kind: "pairing",
  replies: [noWebhook, refused("getUpdates", "Conflict")],
});
addFlow("pairing: a backlog that is not a list stops after the code", {
  kind: "pairing",
  replies: [noWebhook, ok("getUpdates", {})],
});
addFlow("pairing: a backlog with a null update stops after the code", {
  kind: "pairing",
  terminal: 80,
  replies: [noWebhook, ok("getUpdates", [null])],
});
addFlow("pairing: a refused long poll stops", {
  kind: "pairing",
  replies: [noWebhook, backlog, refused("getUpdates", "Conflict")],
});
addFlow("pairing: a long poll that is not a list stops", {
  kind: "pairing",
  replies: [noWebhook, backlog, ok("getUpdates", "x")],
});
addFlow("pairing: a long poll with a bad text stops", {
  kind: "pairing",
  replies: [noWebhook, backlog, ok("getUpdates", [message(7, dev, 5)])],
});
addFlow("pairing: no code within three minutes", {
  kind: "pairing",
  clockStep: 61_000,
  replies: [noWebhook, backlog, ok("getUpdates", []), ok("getUpdates", [])],
});
addFlow("pairing: no code within three minutes in pt-br", {
  kind: "pairing",
  locale: "pt-br",
  clockStep: 90_000,
  replies: [noWebhook, backlog, ok("getUpdates", [])],
});
addFlow("pairing: the deadline counts from the first check", {
  kind: "pairing",
  clockStep: 180_000,
  replies: [noWebhook, backlog],
});
addFlow("pairing: an interruption stops the long poll", {
  kind: "pairing",
  abortAfter: 400,
  replies: [noWebhook, backlog, hold("getUpdates")],
});
addFlow("pairing: a failed greeting keeps the saved account", {
  kind: "pairing",
  input: "\n",
  files: { "state/": "" },
  replies: [
    noWebhook,
    backlog,
    codeMessage(),
    ok("getUpdates", []),
    refused("sendMessage", "Forbidden"),
  ],
});
addFlow("pairing: a failed confirmation of the updates skips the greeting", {
  kind: "pairing",
  terminal: 80,
  input: "\n",
  files: { "state/": "" },
  replies: [noWebhook, backlog, codeMessage(), drop("getUpdates")],
});
addFlow("pairing: a paired account is kept on Enter", {
  kind: "pairing",
  input: "\n",
  files: { [ACCESS_FILE]: access() },
  replies: [ok("getChat", { id: 42, username: "dev" })],
});
addFlow("pairing: a paired account is kept with no, in pt-br", {
  kind: "pairing",
  locale: "pt-br",
  input: "não\n",
  files: { [ACCESS_FILE]: access() },
  replies: [ok("getChat", { id: 42, first_name: "Dev" })],
});
addFlow("pairing: keeping on a terminal spins while naming the accounts", {
  kind: "pairing",
  terminal: 80,
  input: "keep\n",
  files: { [ACCESS_FILE]: access() },
  replies: [ok("getChat", { id: 42, username: "dev" })],
});
addFlow("pairing: several paired accounts are named in order", {
  kind: "pairing",
  input: "\n",
  files: { [ACCESS_FILE]: access({ allowFrom: ["42", "7", "13", 5] }) },
  replies: [
    reply(
      "getChat",
      { ok: true, result: { username: "dev" } },
      { chatId: "42" },
    ),
    reply(
      "getChat",
      { ok: true, result: { first_name: "Ana" } },
      { chatId: "7" },
    ),
    reply("getChat", { ok: false }, { chatId: "13" }),
    reply(
      "getChat",
      { ok: true, result: { username: "", first_name: "" } },
      { chatId: "5" },
    ),
  ],
});
addFlow("pairing: an account that cannot be named shows its id", {
  kind: "pairing",
  input: "\n",
  files: { [ACCESS_FILE]: access() },
  replies: [drop("getChat")],
});
addFlow("pairing: replacing a paired account pairs again", {
  kind: "pairing",
  input: "replace\n\n",
  files: {
    [ACCESS_FILE]: json({
      dmPolicy: "pairing",
      allowFrom: ["7"],
      groups: { "-1": { requireMention: true } },
      pending: { abc: {} },
      ackReaction: "eyes",
    }),
  },
  replies: [ok("getChat", { id: 7, username: "old" }), ...fresh()],
});
addFlow("pairing: replacing with yes in pt-br", {
  kind: "pairing",
  locale: "pt-br",
  input: "sim\ns\n",
  files: { [ACCESS_FILE]: access() },
  replies: [ok("getChat", { id: 42, username: "dev" }), ...fresh()],
});
addFlow("pairing: an empty allowlist pairs without asking", {
  kind: "pairing",
  input: "\n",
  files: { [ACCESS_FILE]: access({ allowFrom: [], extra: 1 }) },
  replies: fresh(),
});
addFlow("pairing: an access file that is not JSON starts from scratch", {
  kind: "pairing",
  input: "\n",
  files: { [ACCESS_FILE]: "{oops" },
  replies: fresh(),
});
addFlow("pairing: an access file with text spreads its characters", {
  kind: "pairing",
  input: "\n",
  files: { [ACCESS_FILE]: '"ab"' },
  replies: fresh(),
});
addFlow("pairing: an access file with a list spreads its items", {
  kind: "pairing",
  input: "\n",
  files: { [ACCESS_FILE]: "[1, 2]" },
  replies: fresh(),
});
addFlow("pairing: an access file with null starts from scratch", {
  kind: "pairing",
  input: "\n",
  files: { [ACCESS_FILE]: "null" },
  replies: fresh(),
});
addFlow("pairing: an access file with numeric keys keeps them first", {
  kind: "pairing",
  input: "\n",
  files: { [ACCESS_FILE]: json({ z: 1, 10: "b", 2: "a", allowFrom: "x" }) },
  replies: fresh(),
});
addFlow("pairing: an existing access file is replaced privately", {
  kind: "pairing",
  input: "\n",
  files: { [ACCESS_FILE]: { content: json({ allowFrom: [] }), mode: 0o644 } },
  replies: fresh(),
});
addFlow("pairing: the bot without a username still makes a link", {
  kind: "pairing",
  bot: { token: TOKEN, username: "undefined" },
  input: "\n",
  files: { "state/": "" },
  replies: fresh(),
});

addFlow("accounts: each id is named in the order given", {
  kind: "accounts",
  userIds: ["42", "7", 13],
  replies: [
    reply(
      "getChat",
      { ok: true, result: { username: "dev", first_name: "D" } },
      { chatId: "42" },
    ),
    reply(
      "getChat",
      { ok: true, result: { first_name: "Ana" } },
      { chatId: "7" },
    ),
    reply("getChat", { ok: true, result: null }, { chatId: "13" }),
  ],
});
addFlow("accounts: odd names and ids show as JavaScript shows them", {
  kind: "accounts",
  userIds: [null, [1, 2], { a: 1 }, 1.5],
  replies: [
    reply("getChat", { ok: true, result: { username: 5 } }, { chatId: "null" }),
    reply(
      "getChat",
      { ok: true, result: { first_name: ["x", "y"] } },
      { chatId: "1,2" },
    ),
    reply(
      "getChat",
      { ok: true, result: "chat" },
      { chatId: "[object Object]" },
    ),
    reply(
      "getChat",
      { ok: true, result: { username: null, first_name: 0 } },
      { chatId: "1.5" },
    ),
  ],
});
addFlow("accounts: no ids is an empty list", { kind: "accounts" });

const FLOWS = {
  async token(setup, scenario, stateDir, messages) {
    const bot = await setup.ensureToken(stateDir, messages, {
      offerSaved: scenario.offerSaved,
    });

    if (bot.canJoinGroups) {
      console.log(warn(messages.groupsWarning(bot.username)));
    }

    return { ...bot, username: `${bot.username}` };
  },
  async savedBot(setup, _scenario, stateDir, messages) {
    const bot = await setup.loadSavedBot(stateDir, messages);

    return { ...bot, username: `${bot.username}` };
  },
  async pairing(setup, scenario, stateDir, messages) {
    await setup.ensurePairing(stateDir, scenario.bot, messages);

    return null;
  },
  accounts(setup, scenario, _stateDir, messages) {
    return setup.pairedAccounts(scenario.userIds, scenario.bot.token, messages);
  },
};

async function runChild(scenarioText, resultFile) {
  const scenario = JSON.parse(scenarioText);
  const require = createRequire(import.meta.url);
  const crypto = require("node:crypto");
  let ticks = 0;

  crypto.randomBytes = (size) => Buffer.from(scenario.random.slice(0, size));
  syncBuiltinESMExports();
  Date.now = () =>
    (new Error("clock").stack ?? "")
      .split("\n")[2]
      ?.includes("waitForPairingMessage")
      ? NOW + ticks++ * scenario.clockStep
      : NOW;

  if (scenario.terminal !== null) {
    process.stdout.isTTY = true;
    process.stdout.columns = scenario.terminal;
  }

  const setup = await import(SETUP_URL);
  const tracked = [];
  const stateDir = process.env.TELEGRAM_STATE_DIR;
  const messages = MESSAGES[scenario.locale];

  setup.journal.trackDir = (dir) => tracked.push({ kind: "dir", path: dir });
  setup.journal.trackFile = (file) =>
    tracked.push({ kind: "file", path: file });

  const timer =
    scenario.abortAfter === null
      ? null
      : setTimeout(() => setup.interruption.abort(), scenario.abortAfter);
  let outcome;

  try {
    outcome = {
      value: await FLOWS[scenario.kind](setup, scenario, stateDir, messages),
    };
  } catch (error) {
    console.error(fail(error.message));
    process.exitCode = 1;
    outcome = { error: error.message };
  }

  if (timer !== null) clearTimeout(timer);

  writeFileSync(resultFile, json({ ...outcome, tracked }));
}

function inRoot(work) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bcct-fixture-")));

  return work(root).finally(() =>
    rmSync(root, { recursive: true, force: true }),
  );
}

function helperProcess() {
  const child = spawn("sh", ["-c", "sleep 600; :", "server.ts"], {
    stdio: "ignore",
  });

  for (let tries = 0; tries < 200; tries += 1) {
    const shown = spawnSync("ps", ["-p", String(child.pid), "-o", "args="], {
      encoding: "utf8",
    }).stdout;

    if (shown.includes("server.ts")) return child;

    spawnSync("sleep", ["0.01"]);
  }

  throw new Error("the helper process never showed up");
}

function runNode(args, input, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { env, stdio: "pipe" });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (status) =>
      done({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
    child.stdin.end(input);
  });
}

const SPINNER_FRAMES = new Set([
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
]);
const CYAN = "\u001B[36m";

function withoutRepaints(text) {
  const [first, ...parts] = text.split("\r");
  let out = first;

  for (const part of parts) {
    const frame = part.startsWith(CYAN) ? part.slice(CYAN.length) : part;

    if (!SPINNER_FRAMES.has([...frame][0]) || part.includes("\n")) {
      out += `\r${part}`;
    }
  }

  return out;
}

function withPid(text, pid) {
  return typeof text === "string" ? text.replaceAll("{pid}", pid) : text;
}

function placeholdersIn(value, root) {
  return JSON.parse(placeholders(json(value), root));
}

function runFlow(scenario, apiRoot) {
  return inRoot(async (root) => {
    const helper = scenario.running ? helperProcess() : null;
    const pid = helper === null ? "" : String(helper.pid);
    const results = realpathSync(mkdtempSync(join(tmpdir(), "bcct-result-")));
    const resultFile = join(results, "result.json");

    try {
      materialize(
        root,
        Object.fromEntries(
          Object.entries(scenario.files).map(([path, spec]) => [
            path,
            typeof spec === "string"
              ? withPid(spec, pid)
              : { ...spec, content: withPid(spec.content, pid) },
          ]),
        ),
      );
      telegram.replies = scenario.replies;
      telegram.requests = [];
      telegram.used = new Set();

      const result = await runNode(
        [...CHILD_FLAGS, SELF, "--child", json(scenario), resultFile],
        scenario.input,
        {
          HOME: join(root, "home"),
          PATH: "/usr/bin:/bin",
          LANG: "C",
          CLAUDE_CONFIG_DIR: join(root, "claude"),
          TELEGRAM_STATE_DIR: join(root, "state"),
          BETTER_CC_TELEGRAM_DIR: join(root, "app"),
          BETTER_CC_TELEGRAM_API_ROOT: apiRoot,
          ...(scenario.forceColor ? { FORCE_COLOR: "1" } : {}),
        },
      );
      const outcome = JSON.parse(readFileSync(resultFile, "utf8"));
      const clean = (text) =>
        placeholders(pid === "" ? text : text.replaceAll(pid, "{pid}"), root);

      return {
        ...scenario,
        status: result.status,
        stdout: clean(withoutRepaints(result.stdout)),
        stderr: clean(result.stderr),
        outcome: placeholdersIn(outcome, root),
        requests: normalizedRequests(telegram.requests),
        after: JSON.parse(clean(json(snapshot(root)))),
      };
    } finally {
      helper?.kill();
      rmSync(results, { recursive: true, force: true });
    }
  });
}

async function runApi(scenario, apiRoot) {
  telegram.replies = scenario.replies;
  telegram.requests = [];
  telegram.used = new Set();

  let outcome;

  try {
    const result = await createTelegramApi(
      TOKEN,
      fetch,
      MESSAGES[scenario.locale],
      `${apiRoot}${scenario.root}`,
    )(scenario.method, scenario.params);

    outcome = result === undefined ? {} : { result };
  } catch (error) {
    outcome = { error: error.message };
  }

  return { ...scenario, outcome, requests: telegram.requests };
}

async function main() {
  process.umask(0o022);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));

  const apiRoot = `http://127.0.0.1:${server.address().port}`;
  const apiResults = [];
  const flowResults = [];

  for (const scenario of api) apiResults.push(await runApi(scenario, apiRoot));
  for (const scenario of flows) {
    flowResults.push(await runFlow(scenario, apiRoot));
  }

  server.closeAllConnections();
  await new Promise((done) => server.close(done));

  await writeFixture("setup-telegram.json", {
    now: NOW,
    token: TOKEN,
    pure,
    api: apiResults,
    flows: flowResults,
  });
}

if (process.argv[2] === "--child") {
  await runChild(process.argv[3], process.argv[4]);
} else {
  await main();
}
