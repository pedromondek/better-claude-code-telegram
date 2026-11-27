export const DIST_TAGS = {
  alpha: "alpha",
  beta: "beta",
  rc: "next",
  stable: "latest",
};
export const MIN_STAGE_NPM = "11.15.0";
export const MIN_DIST_TAG_NPM = "11.21.0";
export const RELEASE_WORKFLOW = "release.yml";
export const BUILD_WORKFLOW = "build-binaries.yml";
export const RELEASE_ENVIRONMENT = "release";
export const STABLE_BRANCH = "stable";
export const TRUST_PAUSE_MS = 2000;
export const NPM_REGISTRY = "https://registry.npmjs.org";
export const PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";
export const ANNOUNCE_CHANNELS = {
  stable: [
    { chat: "@bcct_tips", language: "en-us" },
    { chat: "@bcct_tips_br", language: "pt-br" },
  ],
  prereleases: [
    { chat: "@bcct_tips_prereleases", language: "en-us" },
    { chat: "@bcct_tips_prelancamentos", language: "pt-br" },
  ],
};
export const TELEGRAM_API = "https://api.telegram.org";
export const ANNOUNCE_PAUSE_MS = 1000;
export const ANNOUNCE_RETRIES = 3;
export const BINARY_NAME = "bcct";
export const RUST_TARGET_DIR = "rust/target";

export function binaryFileName(os) {
  return os === "win32" ? `${BINARY_NAME}.exe` : BINARY_NAME;
}
