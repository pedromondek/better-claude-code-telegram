import { describeIssueForm } from "../support/issue-form.mjs";

describeIssueForm("2-feature.yml", {
  name: "Feature request",
  type: "Feature",
  fields: ["problem", "proposal", "alternatives"],
  required: ["problem", "proposal"],
});
