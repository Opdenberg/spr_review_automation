import { readFile } from "node:fs/promises";

const requiredEnv = [
  "JIRA_BASE_URL",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
  "JIRA_PROJECT_KEY",
  "JIRA_BOARD_ID",
  "CONFLUENCE_SPACE_KEY",
  "CONFLUENCE_PARENT_PAGE_ID"
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const config = {
  jiraBaseUrl: process.env.JIRA_BASE_URL.replace(/\/+$/, ""),
  email: process.env.JIRA_EMAIL,
  apiToken: process.env.JIRA_API_TOKEN,
  projectKey: process.env.JIRA_PROJECT_KEY,
  boardId: process.env.JIRA_BOARD_ID,
  sprintName: process.env.SPRINT_NAME,
  confluenceSpaceKey: process.env.CONFLUENCE_SPACE_KEY,
  confluenceParentPageId: process.env.CONFLUENCE_PARENT_PAGE_ID,
  statusBuckets: {
    Done: new Set(["Done"]),
    "In Review": new Set(["merge request to still be assessed"]),
    "In Progress": new Set(["In progress"]),
    "To Do": new Set(["To Do"])
  },
  ignoredStatuses: new Set(["On Hold"])
};

const defaultTemplateUrl = new URL("./templates/sprint-review-storage-template.html", import.meta.url);

const authHeader = `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`;

const jiraGet = async (path, query = {}) => {
  const url = new URL(`${config.jiraBaseUrl}${path}`);
  Object.entries(query).forEach(([k, v]) => {
    if (v !== undefined && v !== null) {
      url.searchParams.set(k, String(v));
    }
  });

  const response = await fetch(url, {
    headers: {
      Authorization: authHeader,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Jira request failed (${response.status}): ${body}`);
  }

  return response.json();
};

const confluenceRequest = async (method, path, body) => {
  const response = await fetch(`${config.jiraBaseUrl}${path}`, {
    method,
    headers: {
      Authorization: authHeader,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Confluence request failed (${response.status}): ${bodyText}`);
  }

  return response.json();
};

const normalize = (value) => (value || "").trim().toLowerCase();

const adfToText = (node) => {
  if (!node) {
    return "";
  }

  if (typeof node === "string") {
    return node;
  }

  if (Array.isArray(node)) {
    return node.map(adfToText).join(" ");
  }

  if (node.type === "text") {
    return node.text || "";
  }

  const content = node.content || [];
  return content.map(adfToText).join(" ");
};

const summarize = (description) => {
  const plain = adfToText(description).replace(/\s+/g, " ").trim();
  if (!plain) {
    return "No description provided.";
  }

  const firstSentence = plain.match(/^.+?[.!?](\s|$)/)?.[0]?.trim();
  const candidate = firstSentence || plain;
  return candidate.length > 220 ? `${candidate.slice(0, 217)}...` : candidate;
};

const resolveSprint = async () => {
  const sprintResponse = await jiraGet(`/rest/agile/1.0/board/${config.boardId}/sprint`, {
    state: "active,closed",
    maxResults: 100
  });

  const sprints = sprintResponse.values || [];
  if (sprints.length === 0) {
    throw new Error(`No sprints found on board ${config.boardId}.`);
  }

  if (config.sprintName) {
    const found = sprints.find((s) => s.name === config.sprintName);
    if (!found) {
      throw new Error(`Sprint "${config.sprintName}" not found on board ${config.boardId}.`);
    }
    return found;
  }

  // Prefer the current active sprint when no explicit sprint name is provided.
  const active = sprints
    .filter((s) => s.state === "active")
    .sort((a, b) => new Date(b.startDate || 0) - new Date(a.startDate || 0));
  if (active.length > 0) {
    return active[0];
  }

  const closed = sprints.filter((s) => s.state === "closed");
  if (closed.length === 0) {
    throw new Error("No closed sprint found and SPRINT_NAME was not provided.");
  }

  closed.sort((a, b) => new Date(b.completeDate || b.endDate || 0) - new Date(a.completeDate || a.endDate || 0));
  return closed[0];
};

const fetchSprintIssues = async (sprintId) => {
  const issues = [];
  let startAt = 0;
  const maxResults = 50;

  while (true) {
    const page = await jiraGet(`/rest/agile/1.0/sprint/${sprintId}/issue`, {
      startAt,
      maxResults,
      fields: "summary,description,status,issuetype,labels,components"
    });
    issues.push(...(page.issues || []));
    startAt += maxResults;
    if (startAt >= (page.total || 0)) {
      break;
    }
  }

  return issues.filter((issue) => issue.fields?.issuetype?.name !== "Initiative");
};

const bucketForStatus = (statusName) => {
  const key = normalize(statusName);
  if (config.ignoredStatuses.has(statusName)) {
    return null;
  }

  for (const [bucket, statuses] of Object.entries(config.statusBuckets)) {
    if (statuses.has(statusName) || statuses.has(key)) {
      return bucket;
    }
  }

  return "Other";
};

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatDate = (value) => {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toISOString().slice(0, 10);
};

const extractSprintNumber = (name) => {
  const match = String(name || "").match(/(?:sprint\s*#?\s*)(\d+)/i);
  return match ? match[1] : "";
};

const splitSprintGoals = (goalText) => {
  if (!goalText) {
    return [];
  }

  const lineParts = String(goalText)
    .replace(/\r/g, "")
    .split(/\n+/)
    .map((part) => part.trim().replace(/^[-*•\d.)\s]+/, ""))
    .filter(Boolean);

  const parts =
    lineParts.length > 1
      ? lineParts
      : lineParts
          .flatMap((part) => part.split(/[;|]+/))
          .map((part) => part.trim())
          .filter(Boolean);

  const unique = [];
  for (const part of parts) {
    if (!unique.includes(part)) {
      unique.push(part);
    }
  }

  return unique.slice(0, 5);
};

const stopwords = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "that",
  "this",
  "our",
  "are",
  "was",
  "were",
  "have",
  "has",
  "had",
  "your",
  "you",
  "about",
  "will",
  "can",
  "could",
  "would",
  "should",
  "done",
  "todo",
  "to",
  "in",
  "on",
  "of",
  "a",
  "an",
  "is",
  "be"
]);

const tokenize = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token && token.length > 2 && !stopwords.has(token));

const issueKeywordSet = (issue) => {
  const labels = (issue.labels || []).join(" ");
  const components = (issue.components || []).join(" ");
  const text = `${issue.summary} ${issue.descriptionSummary} ${labels} ${components}`;
  return new Set(tokenize(text));
};

const scoreGoalMatch = (goal, issue) => {
  const goalTokens = tokenize(goal);
  if (!goalTokens.length) {
    return 0;
  }

  const keywords = issueKeywordSet(issue);
  let score = 0;
  for (const token of goalTokens) {
    if (keywords.has(token)) {
      score += 1;
    }
  }

  return score;
};

const mapIssuesToGoals = (goals, issues) => {
  const matched = Array.from({ length: goals.length }, () => []);
  const unmatched = [];

  for (const issue of issues) {
    let bestGoalIndex = -1;
    let bestScore = 0;

    for (let i = 0; i < goals.length; i += 1) {
      const score = scoreGoalMatch(goals[i], issue);
      if (score > bestScore) {
        bestScore = score;
        bestGoalIndex = i;
      }
    }

    if (bestGoalIndex >= 0 && bestScore > 0) {
      matched[bestGoalIndex].push(issue);
    } else {
      unmatched.push(issue);
    }
  }

  return { matched, unmatched };
};

const markdownIssueLink = (issue) => `[${issue.key}](${issue.url})`;

const safeText = (value) =>
  String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[<>]/g, "")
    .trim();

const inferGoalStatus = (issues) => {
  if (!issues.length) {
    return "";
  }

  const statuses = issues.map((issue) => normalize(issue.status));
  if (statuses.every((status) => status === "done")) {
    return "Done";
  }

  if (statuses.some((status) => status.includes("review") || status.includes("test"))) {
    return "Testing";
  }

  return "In progress";
};

const issueContextLine = (issue) => {
  const base = `${markdownIssueLink(issue)}: ${safeText(issue.summary)}`;
  if (!issue.descriptionSummary || issue.descriptionSummary === "No description provided.") {
    return base;
  }

  return `${base} - ${safeText(issue.descriptionSummary)}`;
};

const itemFrom = (items, index, shouldEscape = true) => {
  if (!items[index]) {
    return "";
  }

  return shouldEscape ? escapeHtml(items[index]) : items[index];
};

const fallbackGoalsFromIssues = (allIssues) => {
  const issueBased = allIssues
    .map((issue) => safeText(issue.summary))
    .filter(Boolean)
    .slice(0, 5);

  if (issueBased.length > 0) {
    return issueBased;
  }

  return [
    "Progress sprint scope",
    "Validate in-review work",
    "Prepare upcoming sprint items",
    "Close completed work",
    "Handle additional requests"
  ];
};

const renderTemplate = (template, values) =>
  template.replace(/\{\{([a-z0-9_]+)\}\}/gi, (_, key) => (key in values ? String(values[key]) : ""));

const loadTemplate = async () => {
  const customTemplatePath = process.env.SPRINT_REVIEW_TEMPLATE_PATH;
  if (customTemplatePath) {
    return readFile(customTemplatePath, "utf8");
  }

  return readFile(defaultTemplateUrl, "utf8");
};

const buildStorageBody = (sprint, groupedIssues, template) => {
  const allIssues = [
    ...groupedIssues["In Progress"],
    ...groupedIssues["In Review"],
    ...groupedIssues["To Do"],
    ...groupedIssues.Done,
    ...groupedIssues.Other
  ];

  const sprintGoalText = String(sprint.goal || "").trim();
  const parsedGoals = splitSprintGoals(sprintGoalText);
  const effectiveGoals = parsedGoals.length > 0 ? parsedGoals : fallbackGoalsFromIssues(allIssues);
  const { matched: goalIssueBuckets, unmatched: unmatchedGoalIssues } = mapIssuesToGoals(effectiveGoals, allIssues);

  const objectiveTitle =
    parsedGoals[0] || sprintGoalText.split(/[.!?\n]/)[0] || `Sprint objective for ${safeText(sprint.name)}`;

  const values = {
    sprint_number: escapeHtml(extractSprintNumber(sprint.name) || sprint.name),
    sprint_start_date: escapeHtml(formatDate(sprint.startDate)),
    sprint_end_date: escapeHtml(formatDate(sprint.endDate || sprint.completeDate)),
    objective_title: escapeHtml(objectiveTitle),
    sprint_name: escapeHtml(sprint.name),
    project_key: escapeHtml(config.projectKey),
    generated_at: escapeHtml(new Date().toISOString().replace("T", " ").replace(".000Z", " UTC")),
    done_count: groupedIssues.Done.length,
    in_review_count: groupedIssues["In Review"].length,
    in_progress_count: groupedIssues["In Progress"].length,
    to_do_count: groupedIssues["To Do"].length,
    other_count: groupedIssues.Other.length,
    topic_1_title: "Done beyond sprint goals",
    topic_1_item_1: itemFrom(groupedIssues.Done.map(issueContextLine), 0, false),
    topic_1_item_2: itemFrom(groupedIssues.Done.map(issueContextLine), 1, false),
    topic_1_item_3_optional: itemFrom(groupedIssues.Done.map(issueContextLine), 2, false),
    topic_2_title: "In review or testing work",
    topic_2_item_1: itemFrom(groupedIssues["In Review"].map(issueContextLine), 0, false),
    topic_2_item_2: itemFrom(groupedIssues["In Review"].map(issueContextLine), 1, false),
    topic_2_item_3_optional: itemFrom(groupedIssues["In Review"].map(issueContextLine), 2, false),
    topic_3_title: "Other notable work",
    topic_3_item_1: itemFrom(unmatchedGoalIssues.map(issueContextLine), 0, false),
    topic_3_item_2: itemFrom(unmatchedGoalIssues.map(issueContextLine), 1, false),
    topic_3_item_3_optional: itemFrom(unmatchedGoalIssues.map(issueContextLine), 2, false),
    next_sprint_item_1: itemFrom([...groupedIssues["To Do"], ...groupedIssues["In Progress"]].map(issueContextLine), 0, false),
    next_sprint_item_2: itemFrom([...groupedIssues["To Do"], ...groupedIssues["In Progress"]].map(issueContextLine), 1, false),
    next_sprint_item_3: itemFrom([...groupedIssues["To Do"], ...groupedIssues["In Progress"]].map(issueContextLine), 2, false),
    next_sprint_item_4: itemFrom([...groupedIssues["To Do"], ...groupedIssues["In Progress"]].map(issueContextLine), 3, false),
    next_sprint_item_5: itemFrom([...groupedIssues["To Do"], ...groupedIssues["In Progress"]].map(issueContextLine), 4, false),
    next_sprint_item_6: itemFrom([...groupedIssues["To Do"], ...groupedIssues["In Progress"]].map(issueContextLine), 5, false),
    next_sprint_item_7: itemFrom([...groupedIssues["To Do"], ...groupedIssues["In Progress"]].map(issueContextLine), 6, false)
  };

  for (let i = 1; i <= 5; i += 1) {
    const goal = effectiveGoals[i - 1] || "";
    const goalIssues = goalIssueBuckets[i - 1] || [];
    const goalStatusItems = goalIssues.map(issueContextLine);

    values[`sprint_goal_${i}`] = escapeHtml(goal);
    values[`key_result_or_theme_${i}`] = escapeHtml(objectiveTitle);
    values[`status_goal_${i}`] = escapeHtml(inferGoalStatus(goalIssues));

    const topLinks = goalIssues.slice(0, 3).map(markdownIssueLink).join(", ");
    const goalDescription = topLinks
      ? `Stories linked to this goal: ${topLinks}. Context: ${goalIssues
          .slice(0, 2)
          .map((issue) => `${safeText(issue.summary)} (${safeText(issue.status)})`)
          .join("; ")}`
      : "";

    values[`goal_description_${i}`] = goalDescription;
    values[`status_item_${i}_1`] = itemFrom(goalStatusItems, 0, false);
    values[`status_item_${i}_2`] = itemFrom(goalStatusItems, 1, false);
    values[`status_item_${i}_3_optional`] = itemFrom(goalStatusItems, 2, false);
  }

  return renderTemplate(template, values);
};

const upsertConfluencePage = async (title, storageValue) => {
  const existing = await confluenceRequest(
    "GET",
    `/wiki/rest/api/content?spaceKey=${encodeURIComponent(config.confluenceSpaceKey)}&title=${encodeURIComponent(title)}&expand=version`
  );

  const page = existing.results?.[0];

  if (!page) {
    return confluenceRequest("POST", "/wiki/rest/api/content", {
      type: "page",
      title,
      space: { key: config.confluenceSpaceKey },
      ancestors: [{ id: config.confluenceParentPageId }],
      body: { storage: { value: storageValue, representation: "storage" } }
    });
  }

  return confluenceRequest("PUT", `/wiki/rest/api/content/${page.id}`, {
    id: page.id,
    type: "page",
    title,
    space: { key: config.confluenceSpaceKey },
    ancestors: [{ id: config.confluenceParentPageId }],
    version: { number: Number(page.version.number) + 1 },
    body: { storage: { value: storageValue, representation: "storage" } }
  });
};

const run = async () => {
  const sprint = await resolveSprint();
  const issues = await fetchSprintIssues(sprint.id);

  const groupedIssues = {
    Done: [],
    "In Review": [],
    "In Progress": [],
    "To Do": [],
    Other: []
  };

  for (const issue of issues) {
    const status = issue.fields?.status?.name || "Unknown";
    const bucket = bucketForStatus(status);
    if (!bucket) {
      continue;
    }

    groupedIssues[bucket].push({
      key: issue.key,
      summary: issue.fields?.summary || "",
      status,
      descriptionSummary: summarize(issue.fields?.description),
      labels: issue.fields?.labels || [],
      components: (issue.fields?.components || []).map((component) => component?.name || "").filter(Boolean),
      url: `${config.jiraBaseUrl}/browse/${issue.key}`
    });
  }

  const title = `Sprint Review - ${sprint.name}`;
  const template = await loadTemplate();
  const body = buildStorageBody(sprint, groupedIssues, template);
  const result = await upsertConfluencePage(title, body);
  const pageId = result.id || result?.results?.[0]?.id;
  const pageUrl = `${config.jiraBaseUrl}/wiki/spaces/${config.confluenceSpaceKey}/pages/${pageId}`;

  console.log(`Published: ${pageUrl}`);
};

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
