/**
 * PR-body gate: every PR body must carry the sections of
 * .github/PULL_REQUEST_TEMPLATE.md, and UI-touching PRs must carry visual
 * evidence. The template is the single source — headings are read from it, so
 * editing the template updates this gate without touching this script.
 *
 * Structure is enforced here; truth is the reviewer's job. The script checks
 * that each section exists and says something, not that what it says is right
 * (that's why checkbox state is deliberately not enforced: "not applicable,
 * because…" is a legitimate checked-nothing answer the template invites).
 *
 * Usage: node tools/ci/check-pr-body.mjs <changed-files.txt>
 *   PR_BODY  — the pull request body (env, to avoid shell interpolation of
 *              attacker-controlled markdown)
 */
import { readFileSync } from "node:fs";

const TEMPLATE_PATH = ".github/PULL_REQUEST_TEMPLATE.md";

// UI sources whose change obligates visual evidence. Tests and colocated
// knowledge files change without changing pixels.
const UI_FILE = /^apps\/(app|www)\/src\/.+\.(tsx|css)$/;
const NON_VISUAL_FILE = /(\.test\.|\.context\/|\.stories\.)/;

// The escape hatch for UI-file diffs that change no pixels (pure refactors,
// type-only churn). Writing it is a reviewable claim, not a free pass.
const NO_VISUAL_CLAIM = /no visual change/i;
const IMAGE = /!\[[^\]]*\]\([^)]+\)|<img\s/;

function templateHeadings(template) {
  return template
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.trim());
}

/** Section content by heading: text between one `## ` heading and the next. */
function sectionContent(body, heading) {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim().startsWith("## "));
  return rest.slice(0, end === -1 ? rest.length : end).join("\n");
}

function isSubstantive(content) {
  const stripped = content
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*-\s*\[[ x]\]\s*$/gm, "");
  return /\S/.test(stripped);
}

const body = process.env.PR_BODY ?? "";
const changedFiles = readFileSync(process.argv[2], "utf8")
  .split("\n")
  .filter(Boolean);
const template = readFileSync(TEMPLATE_PATH, "utf8");

const failures = [];

for (const heading of templateHeadings(template)) {
  const content = sectionContent(body, heading);
  if (content === null) {
    failures.push(`missing section: ${heading}`);
  } else if (!isSubstantive(content)) {
    failures.push(`empty section: ${heading}`);
  }
}

const touchesUi = changedFiles.some(
  (file) => UI_FILE.test(file) && !NON_VISUAL_FILE.test(file),
);
if (touchesUi && !IMAGE.test(body) && !NO_VISUAL_CLAIM.test(body)) {
  failures.push(
    "UI sources changed but the body has no screenshot/GIF and no explicit " +
      '"no visual change" claim — the merge gate is visual',
  );
}

if (failures.length > 0) {
  console.error(`PR body does not follow ${TEMPLATE_PATH}:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "\nAgents: gh pr create --body-file bypasses GitHub's template " +
      "auto-fill; copy the template's sections into the body file.",
  );
  process.exit(1);
}

console.log(`PR body carries all ${templateHeadings(template).length} template sections.`);
