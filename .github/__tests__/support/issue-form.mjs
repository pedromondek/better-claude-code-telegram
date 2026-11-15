import { describe, expect, it } from "vitest";

import { parse } from "yaml";

import { read } from "./workflow.mjs";

export const SECRET_WARNING = {
  en: "Never paste the bot token, a chat id or `access.json`, in any field or screenshot.",
  "pt-br":
    "Nunca cole o token do bot, um chat id nem o `access.json`, em nenhum campo ou print.",
};

export const issueForm = (file) =>
  parse(read(`.github/ISSUE_TEMPLATE/${file}`));

const inputs = (form) => form.body.filter((field) => field.type !== "markdown");

const shape = (form) =>
  inputs(form).map((field) => ({
    id: field.id,
    type: field.type,
    required: field.validations?.required === true,
    render: field.attributes.render,
    options: field.attributes.options?.length,
  }));

export function describeIssueForm(
  file,
  { name, type, labels, fields, required, language = "en" },
) {
  describe(`${file} issue form`, () => {
    const form = issueForm(file);
    const intro = form.body[0];

    it(`opens the issue as "${name}", of the ${type} issue type of the account`, () => {
      expect(Object.keys(form).toSorted()).toEqual(
        [
          "name",
          "description",
          "type",
          ...(labels === undefined ? [] : ["labels"]),
          "body",
        ].toSorted(),
      );
      expect(form.name).toBe(name);
      expect(form.type).toBe(type);
      expect(form.labels).toEqual(labels);
      expect(form.description.length).toBeGreaterThan(0);
    });

    it("starts by warning never to paste a secret of the bot", () => {
      expect(intro.type).toBe("markdown");
      expect(intro.attributes.value).toContain(SECRET_WARNING[language]);
    });

    it("leaves an optional list without an answer, like an optional text field", () => {
      const dropdowns = inputs(form).filter(
        (field) => field.type === "dropdown",
      );

      expect(
        dropdowns.filter(
          (field) =>
            field.attributes.options.length < 2 ||
            field.attributes.multiple === true ||
            field.attributes.default !== undefined,
        ),
      ).toEqual([]);
    });

    it("describes what each field asks for", () => {
      expect(
        inputs(form)
          .filter((field) => !(field.attributes.description?.length > 0))
          .map((field) => field.id),
      ).toEqual([]);
    });

    it("gives each field a unique kebab-case id and requires only the fields of the issue", () => {
      const ids = inputs(form).map((field) => field.id);

      expect(ids).toEqual(fields);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.filter((id) => !/^[a-z][a-z0-9-]*$/u.test(id))).toEqual([]);
      expect(
        inputs(form)
          .filter((field) => field.validations?.required === true)
          .map((field) => field.id),
      ).toEqual(required);
    });
  });
}

export function describeTranslatedForm(file, { from, name }) {
  describe(`${file} issue form, the pt-br of ${from}`, () => {
    const form = issueForm(file);
    const source = issueForm(from);

    it(`opens the issue as "${name}", with the type and labels of ${from}`, () => {
      expect(form.name).toBe(name);
      expect(form.name).not.toBe(source.name);
      expect(form.type).toBe(source.type);
      expect(form.labels).toEqual(source.labels);
    });

    it(`asks the same fields as ${from}, with the same ids, kinds, required fields, blocks and number of options`, () => {
      expect(shape(form)).toEqual(shape(source));
    });

    it(`translates every label and description of ${from}`, () => {
      const untranslated = inputs(form).filter((field, index) => {
        const original = inputs(source)[index].attributes;

        return (
          field.attributes.label === original.label ||
          field.attributes.description === original.description
        );
      });

      expect(untranslated.map((field) => field.id)).toEqual([]);
    });

    it("starts by warning never to paste a secret of the bot, in pt-br", () => {
      expect(form.body[0].attributes.value).toContain(SECRET_WARNING["pt-br"]);
    });

    it("points each form to the other language by its name", () => {
      expect(source.body[0].attributes.value).toContain(`**${form.name}**`);
      expect(form.body[0].attributes.value).toContain(`**${source.name}**`);
    });
  });
}
