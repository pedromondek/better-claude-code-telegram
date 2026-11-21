const ISSUE_NUMBER = /\/issues\/(\d+)/u;

export function labeledIssues(gh, { label, color, description, search }) {
  const searchArgs = search === undefined ? [] : ["--search", search];

  return {
    openIssue: () => {
      const [found] = JSON.parse(
        gh([
          "issue",
          "list",
          "--label",
          label,
          "--state",
          "open",
          ...searchArgs,
          "--json",
          "number,body,comments",
          "--limit",
          "1",
        ]),
      );

      return found === undefined
        ? null
        : {
            number: found.number,
            texts: [found.body, ...found.comments.map(({ body }) => body)],
          };
    },
    ensureLabel: () => {
      gh([
        "label",
        "create",
        label,
        "--color",
        color,
        "--description",
        description,
        "--force",
      ]);
    },
    createIssue: ({ title, label: issueLabel, body }) =>
      Number(
        ISSUE_NUMBER.exec(
          gh([
            "issue",
            "create",
            "--title",
            title,
            "--label",
            issueLabel,
            "--body",
            body,
          ]),
        )[1],
      ),
    comment: (number, body) => {
      gh(["issue", "comment", String(number), "--body", body]);
    },
  };
}
