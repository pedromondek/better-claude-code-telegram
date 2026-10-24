"use strict";

const fs = require("node:fs");
const path = require("node:path");

function minimumNode() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  );

  return manifest.engines.node.replace(">=", "");
}

function parts(version) {
  return version.split(".").map(Number);
}

function nodeIsSupported(version, minimum) {
  const current = parts(version);
  const wanted = parts(minimum);

  for (let index = 0; index < wanted.length; index += 1) {
    if ((current[index] || 0) !== wanted[index]) {
      return (current[index] || 0) > wanted[index];
    }
  }

  return true;
}

function nodeTooOldMessage(version, minimum) {
  return [
    `[en-us] Node ${minimum} or newer is required, but this is Node ${version}. Install a newer Node (the .nvmrc of this repository pins the tested one) and run the command again.`,
    `[pt-br] É preciso o Node ${minimum} ou mais novo, mas este é o Node ${version}. Instale um Node mais novo (o .nvmrc deste repositório fixa o testado) e rode o comando de novo.`,
  ].join("\n");
}

module.exports = { minimumNode, nodeIsSupported, nodeTooOldMessage };
