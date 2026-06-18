# Sprint review automation

This project generates a Confluence sprint review page from Jira sprint issues for project `YELLOW`.

## What it does

- Finds a sprint by name (or uses the latest closed sprint)
- Loads sprint issues from board `4`
- Excludes `Initiative` issue type
- Groups issues by status buckets:
  - `Done`
  - `In Review` (`merge request to still be assessed`)
  - `In Progress`
  - `To Do`
  - ignores `On Hold`
- Summarizes issue description text
- Creates or updates Confluence page `Sprint Review - <sprint name>` under the configured parent page

The page is always written under `CONFLUENCE_PARENT_PAGE_ID`, including updates of existing pages.

## Required GitHub secrets

Configure these in the repository settings:

- `JIRA_BASE_URL` = `https://zorgdomein.atlassian.net`
- `JIRA_EMAIL` = Jira/Confluence account email
- `JIRA_API_TOKEN` = Atlassian API token
- `JIRA_PROJECT_KEY` = `YELLOW`
- `JIRA_BOARD_ID` = `4`
- `CONFLUENCE_SPACE_KEY` = `IO`
- `CONFLUENCE_PARENT_PAGE_ID` = `1154711919`

## Run in GitHub Actions

Workflow: `.github/workflows/generate-sprint-review.yml`

Trigger manually via **Run workflow** and optionally set `sprint_name` (example: `2026-05-25`).

If `sprint_name` is empty, the script uses the latest closed sprint.

## Customize the page template

Default template file: `src/templates/sprint-review-storage-template.html`

You can edit this file directly to change structure/styling of the generated Confluence page.

Available placeholders are shown directly in `src/templates/sprint-review-storage-template.html` and can be expanded as needed.

The default template now follows the sprint review guideline format with sections for key results, sprint goals, detailed status per goal, additional work, and next sprint items.

Sprint goals are sourced from Jira sprint goal text (`sprint.goal`) when available.

Story-to-goal mapping is now keyword-based (strict): stories are mapped to goals by overlap with goal text using issue summary, description, labels, and components. If no clear match is found, the story remains outside the goal sections and appears in additional work sections.

Issue references in generated status text are formatted as markdown links:

- `[ISSUE-KEY](https://zorgdomein.atlassian.net/browse/ISSUE-KEY)`

Use `SPRINT_REVIEW_TEMPLATE_PATH` to point to a different template file if needed.
