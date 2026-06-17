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
