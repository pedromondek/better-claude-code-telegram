import { isAbsolute, relative, resolve, sep } from "node:path";

export async function readHookInput() {
  const chunks = [];

  try {
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }

    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

export function projectRelativePath(file, projectDir) {
  const path = relative(resolve(projectDir), resolve(projectDir, file));

  if (
    path === "" ||
    path === ".." ||
    path.startsWith(`..${sep}`) ||
    isAbsolute(path)
  ) {
    return undefined;
  }

  return path.split(sep).join("/");
}
