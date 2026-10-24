import { emitKeypressEvents } from "node:readline";
import { styleText } from "node:util";

import { cut } from "./ui.mjs";

const HIDE_CURSOR = "\u001B[?25l";
const SHOW_CURSOR = "\u001B[?25h";

function paint(format, text, stream) {
  return styleText(format, text, { stream });
}

export function renderChoices(
  { choices, index, hint, columns },
  stream = process.stdout,
) {
  const max = columns ? columns - 1 : Infinity;
  const width = Math.max(
    ...choices
      .filter(({ heading }) => !heading)
      .map(({ label }) => label.length),
  );
  const lines = choices.map((choice, position) => {
    if (choice.heading) return paint("bold", cut(choice.label, max), stream);

    const chosen = position === index;
    const label = choice.hint ? choice.label.padEnd(width) : choice.label;
    const head = `${chosen ? "❯" : " "} ${label}`;
    const line = cut(choice.hint ? `${head}  ${choice.hint}` : head, max);
    const shownHead = line.slice(0, head.length);
    const tail = line.slice(head.length);
    const styledHead = chosen
      ? paint(["cyan", "bold"], shownHead, stream)
      : choice.previous
        ? paint("green", shownHead, stream)
        : shownHead;

    return tail
      ? `${styledHead}  ${paint("dim", tail.slice(2), stream)}`
      : styledHead;
  });

  return [...lines, paint("dim", cut(hint, max), stream)];
}

export function selectOnTerminal({
  title,
  choices,
  index,
  hint,
  cancelled,
  input = process.stdin,
  output = process.stdout,
}) {
  return new Promise((resolveChoice, rejectChoice) => {
    let current = index;
    let rows = 0;

    const clear = () => {
      if (rows > 0) output.write(`\u001B[${rows}A\r\u001B[0J`);
    };

    const draw = () => {
      const lines = renderChoices(
        { choices, index: current, hint, columns: output.columns },
        output,
      );

      clear();
      output.write(`${lines.join("\n")}\n`);
      rows = lines.length;
    };

    const finish = (callback) => {
      input.removeListener("keypress", onKeypress);
      input.setRawMode(false);
      input.pause();
      callback();
      output.write(SHOW_CURSOR);
    };

    const move = (step) => {
      do {
        current = (current + step + choices.length) % choices.length;
      } while (choices[current].heading);
      draw();
    };

    function onKeypress(_text, key = {}) {
      if (key.ctrl && key.name === "c") {
        finish(() =>
          rejectChoice(
            Object.assign(new Error(cancelled), { cancelled: true }),
          ),
        );
        return;
      }

      if (key.name === "up" || key.name === "k") move(-1);
      if (key.name === "down" || key.name === "j") move(1);

      if (key.name === "return" || key.name === "enter") {
        const choice = choices[current];

        finish(() => {
          clear();
          output.write(`${paint("cyan", `❯ ${choice.label}`, output)}\n`);
          resolveChoice(choice.value);
        });
      }
    }

    emitKeypressEvents(input);
    output.write(`${HIDE_CURSOR}${title}\n`);
    draw();
    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
  });
}
