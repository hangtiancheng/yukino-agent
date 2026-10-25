---
name: weekly-report
title: Weekly Engineering Report
version: 0.1.0
description: Generate a repository engineering weekly report from the issues, pull requests and CI runs in a requested window.
category: reporting
entrypoint: generate_weekly_report
tools:
  - list_issues
  - list_pulls
  - list_ci_runs
input_modes:
  - repository_activity_window
  - report_request_from_chat
triggers:
  - 周报
  - weekly report
  - 工程摘要
  - 活动摘要
  - 项目健康
  - 仓库报告
workflow_steps:
  - collect_activity_window
  - summarize_issue_and_pr_flow
  - summarize_ci_health
  - identify_risks_and_next_actions
  - persist_report_to_archive
output_contract: WeeklyReportResponse
safety_level: read_only
---

# Weekly Engineering Report

Use this skill when the user asks for a weekly report, engineering summary, activity summary or project-health overview.

## Workflow

1. Constrain issues, pull requests and workflow runs to the user-requested time window (list_issues / list_pulls / list_ci_runs).
2. Summarize completed work, open risks and CI health.
3. Produce a Markdown report suitable for a team sync.
4. The full persisted report is generated from the Reports page; in chat, summarize the window and offer to run the full report.

## Boundaries

This skill only reads structured facts inside the requested window and drafts an internal report. Sending the report externally must first go through the safety-draft skill.
