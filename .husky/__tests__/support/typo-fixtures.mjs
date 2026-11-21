const split = (...parts) => parts.join("");

export const MISSPELLED = split("reci", "eve");
export const TYPOS_REPORT = `\`${MISSPELLED}\` should be \`receive\``;
export const PORTUGUESE_SENTENCE = `A versão ${split("ofi", "cial")} e ${split("atu", "al")} ${split("v", "ai")} responder.`;
