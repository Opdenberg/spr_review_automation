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
      fields: "summary,description,status,issuetype"
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

const buildStorageBody = (sprint, groupedIssues) => {
  const sections = Object.entries(groupedIssues)
    .filter(([, items]) => items.length > 0)
    .map(([bucket, items]) => {
      const rows = items
        .map(
          (item) =>
            `<tr><td><a href="${escapeHtml(item.url)}">${escapeHtml(item.key)}</a></td><td>${escapeHtml(item.summary)}</td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.descriptionSummary)}</td></tr>`
        )
        .join("");

      return `<h2>${escapeHtml(bucket)} (${items.length})</h2><table><tbody><tr><th>Issue</th><th>Summary</th><th>Status</th><th>Description summary</th></tr>${rows}</tbody></table>`;
    })
    .join("");

  return `<h1>Sprint Review - ${escapeHtml(sprint.name)}</h1><p>Generated automatically for project ${escapeHtml(config.projectKey)}.</p>${sections || "<p>No issues matched the configured filters.</p>"}`;
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
      url: `${config.jiraBaseUrl}/browse/${issue.key}`
    });
  }

  const title = `Sprint Review - ${sprint.name}`;
  const body = buildStorageBody(sprint, groupedIssues);
  const result = await upsertConfluencePage(title, body);
  const pageId = result.id || result?.results?.[0]?.id;
  const pageUrl = `${config.jiraBaseUrl}/wiki/spaces/${config.confluenceSpaceKey}/pages/${pageId}`;

  console.log(`Published: ${pageUrl}`);
};

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
