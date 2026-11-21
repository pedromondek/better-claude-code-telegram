import { describe, expect, it } from "vitest";

import { describeTranslatedForm, issueForm } from "../support/issue-form.mjs";

describeTranslatedForm("1-bug.pt-br.yml", {
  from: "1-bug.yml",
  name: "Relatar um bug",
});

describe("1-bug.pt-br.yml: o que ajuda a reproduzir", () => {
  const form = issueForm("1-bug.pt-br.yml");
  const field = (id) => form.body.find((element) => element.id === id);

  it("pede para rodar o health do comando publicado, como o formulário em inglês", () => {
    expect(form.body[0].attributes.value).toContain(
      "`npx @pedromondek/better-claude-code-telegram health`",
    );
  });

  it("diz onde cada comando imprime a versão do bcct e a do Claude Code", () => {
    expect(field("bcct-version").attributes.description).toContain("`bcct -v`");
    expect(field("claude-code-version").attributes.description).toContain(
      "`claude --version`",
    );
  });

  it("pergunta o sistema, se é regressão e com que frequência acontece, em listas em pt-br", () => {
    expect(field("os").attributes.options).toEqual([
      "Linux",
      "macOS",
      "Windows",
      "WSL",
    ]);
    expect(field("regression").attributes.options).toEqual([
      "Sim, funcionava antes",
      "Não, nunca funcionou",
      "Não sei",
    ]);
    expect(field("frequency").attributes.options).toEqual([
      "Sempre",
      "Às vezes",
      "Só uma vez",
    ]);
  });
});
