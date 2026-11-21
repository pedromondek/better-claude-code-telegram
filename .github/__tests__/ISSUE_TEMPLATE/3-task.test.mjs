import { describeIssueForm } from "../support/issue-form.mjs";

describeIssueForm("3-task.yml", {
  name: "Task",
  type: "Task",
  fields: ["what-to-do", "why", "done-criteria"],
  required: ["what-to-do", "why", "done-criteria"],
});
