import { createHash } from "node:crypto";

import { PACKAGE, PLATFORMS, REPOSITORY } from "./shim.constants.mjs";

const DOWNLOAD_FLAG = "--download-binary";
const LOCALE_VARIABLES = ["LC_ALL", "LC_MESSAGES", "LANG"];
const LOCALES = ["en-us", "pt-br"];
const YES = new Set(["y", "yes", "s", "sim"]);
const NO = new Set(["n", "no", "não", "nao"]);
const TOP_LEVEL_COMMANDS = new Set(["health", "uninstall"]);

const MESSAGES = {
  "en-us": {
    unsupported: (name) =>
      `✗ bcct has no binary for ${name}. Supported: ${PLATFORMS.join(", ")}.`,
    noHash: (asset, version) =>
      `✗ The checksums.txt of ${PACKAGE} has no hash for ${asset} ${version}. Reinstall ${PACKAGE}.`,
    missing: (packageName) => [
      `✗ The package ${packageName}, with the bcct binary for this machine, was not installed.`,
      "  It is an optional dependency: npm skips it with --omit=optional or optional=false, and some registry mirrors do not serve it.",
    ],
    manual: (url, hash) => [
      `  To install it: run again without --omit=optional, or run again with ${DOWNLOAD_FLAG},`,
      `  or download ${url},`,
      `  make it executable and run: <file> self-install <file> --sha256 ${hash}`,
    ],
    ask: (asset, version) =>
      `Download ${asset} ${version} from the GitHub Release and check it against checksums.txt? [y/n] `,
    mismatch: (asset, expected, actual) =>
      `✗ ${asset} does not match the hash in checksums.txt (expected ${expected}, got ${actual}); nothing was installed.`,
    downloadFailed: (url, reason) => `✗ Could not download ${url}: ${reason}`,
    spawnFailed: (binary, reason) =>
      `✗ Could not run ${binary}: ${reason}. If the temporary folder does not allow running programs (noexec), set TMPDIR to one that does.`,
  },
  "pt-br": {
    unsupported: (name) =>
      `✗ O bcct não tem binário para ${name}. Disponíveis: ${PLATFORMS.join(", ")}.`,
    noHash: (asset, version) =>
      `✗ O checksums.txt do ${PACKAGE} não tem o hash de ${asset} ${version}. Reinstale o ${PACKAGE}.`,
    missing: (packageName) => [
      `✗ O pacote ${packageName}, com o binário do bcct para esta máquina, não foi instalado.`,
      "  Ele é uma dependência opcional: o npm o pula com --omit=optional ou optional=false, e alguns mirrors do registry não o servem.",
    ],
    manual: (url, hash) => [
      `  Para instalar: rode de novo sem --omit=optional, ou rode de novo com ${DOWNLOAD_FLAG},`,
      `  ou baixe ${url},`,
      `  torne o arquivo executável e rode: <arquivo> self-install <arquivo> --sha256 ${hash}`,
    ],
    ask: (asset, version) =>
      `Baixar ${asset} ${version} do GitHub Release e conferir pelo checksums.txt? [s/n] `,
    mismatch: (asset, expected, actual) =>
      `✗ ${asset} não bate com o hash do checksums.txt (esperado ${expected}, veio ${actual}); nada foi instalado.`,
    downloadFailed: (url, reason) =>
      `✗ Não foi possível baixar ${url}: ${reason}`,
    spawnFailed: (binary, reason) =>
      `✗ Não foi possível executar ${binary}: ${reason}. Se a pasta temporária não permite executar programas (noexec), aponte o TMPDIR para uma que permita.`,
  },
};

export function platformOf(platform, arch) {
  const name = `${platform}-${arch}`;

  if (!PLATFORMS.includes(name)) {
    return null;
  }

  const extension = platform === "win32" ? ".exe" : "";

  return {
    name,
    asset: `bcct-${name}${extension}`,
    packageName: `${PACKAGE}-${name}`,
    binary: `bcct${extension}`,
  };
}

export function expectedHash(checksums, version, asset) {
  for (const line of checksums.split("\n")) {
    if (line.trimStart().startsWith("#")) {
      continue;
    }

    const [lineVersion, lineAsset, hash] = line.trim().split(/\s+/u);

    if (lineVersion === version && lineAsset === asset && hash !== undefined) {
      return hash;
    }
  }

  return null;
}

export function binaryCommand(args) {
  const download = args.includes(DOWNLOAD_FLAG);
  const rest = args.filter((arg) => arg !== DOWNLOAD_FLAG);
  const command = TOP_LEVEL_COMMANDS.has(rest[0]) ? rest : ["setup", ...rest];

  return { command, download };
}

export function localeOf({ config, env }) {
  const saved = config?.language;

  if (LOCALES.includes(saved)) {
    return saved;
  }

  const system = (
    LOCALE_VARIABLES.map((name) => env[name]).find(
      (value) => value !== undefined && value !== "",
    ) ?? ""
  )
    .toLowerCase()
    .replaceAll("_", "-");

  return LOCALES.find((locale) => system.startsWith(locale)) ?? "en-us";
}

export function releaseUrl(version, asset) {
  return `https://github.com/${REPOSITORY}/releases/download/v${version}/${asset}`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function agreesToDownload(ask, question) {
  for (;;) {
    const answer = await ask(question).then(
      (text) => text.trim().toLowerCase(),
      () => null,
    );

    if (answer === null || NO.has(answer)) {
      return false;
    }

    if (YES.has(answer)) {
      return true;
    }
  }
}

export function runBinary({ spawnSync, signals, onSignal }, binary, args) {
  const ignoreInterrupt = () => {};

  signals.on("SIGINT", ignoreInterrupt);

  try {
    const result = spawnSync(binary, args, { stdio: "inherit" });

    if (result.error !== undefined) {
      throw result.error;
    }

    if (typeof result.signal === "string") {
      onSignal(result.signal);
    }

    return result.status ?? 1;
  } finally {
    signals.off("SIGINT", ignoreInterrupt);
  }
}

export function exitAsChild(current, code, signal) {
  current.exitCode = code;

  if (signal !== null) {
    current.kill(current.pid, signal);
  }
}

export async function run(args, deps) {
  const text = MESSAGES[localeOf({ config: deps.readConfig(), env: deps.env })];
  const platform = platformOf(deps.platform, deps.arch);

  if (platform === null) {
    deps.err(text.unsupported(`${deps.platform}-${deps.arch}`));

    return 1;
  }

  const hash = expectedHash(deps.readChecksums(), deps.version, platform.asset);

  if (hash === null) {
    deps.err(text.noHash(platform.asset, deps.version));

    return 1;
  }

  const { command, download } = binaryCommand(args);
  let bytes = deps.readInstalled(platform.packageName);
  let origin = "npm";

  if (bytes === null) {
    const url = releaseUrl(deps.version, platform.asset);

    for (const line of text.missing(platform.packageName)) {
      deps.err(line);
    }

    const agreed =
      download ||
      (deps.isTTY &&
        (await agreesToDownload(
          deps.ask,
          text.ask(platform.asset, deps.version),
        )));

    if (!agreed) {
      for (const line of text.manual(url, hash)) {
        deps.err(line);
      }

      return 1;
    }

    try {
      bytes = await deps.download(url);
    } catch (error) {
      deps.err(
        text.downloadFailed(
          url,
          error instanceof Error ? error.message : String(error),
        ),
      );

      return 1;
    }

    origin = "release";
  }

  const actual = sha256(bytes);

  if (actual !== hash) {
    deps.err(text.mismatch(platform.asset, hash, actual));

    return 1;
  }

  const binary = deps.writeExecutable(bytes, platform.binary);

  try {
    const installed = deps.spawn(binary, [
      "self-install",
      binary,
      "--sha256",
      hash,
      "--from",
      origin,
    ]);

    if (installed !== 0) {
      return installed;
    }

    return deps.spawn(binary, command);
  } catch (error) {
    deps.err(
      text.spawnFailed(
        binary,
        error instanceof Error ? error.message : String(error),
      ),
    );

    return 1;
  } finally {
    deps.removeExecutable(binary);
  }
}
