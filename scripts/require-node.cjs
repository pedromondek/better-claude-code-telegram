#!/usr/bin/env node
"use strict";

const {
  minimumNode,
  nodeIsSupported,
  nodeTooOldMessage,
} = require("./node-version.cjs");

const minimum = minimumNode();

if (!nodeIsSupported(process.versions.node, minimum)) {
  process.stderr.write(
    `${nodeTooOldMessage(process.versions.node, minimum)}\n`,
  );
  process.exit(1);
}
