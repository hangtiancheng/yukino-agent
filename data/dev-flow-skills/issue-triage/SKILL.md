---
name: issue-triage
title: Issue Triage
version: 0.1.0
description: Analyze a synced GitHub Issue into category, priority, complexity, an owner suggestion and action items.
category: github-analysis
entrypoint: analyze_issue
tools:
  - list_issues
  - get_issue
  - search_knowledge
  - memory_recall
input_modes:
  - latest_synced_issue
  - issue_context_from_chat
triggers:
  - issue
  - bug
  - 工单
  - 分诊
  - 优先级
  - 负责人
  - 分配
workflow_steps:
  - collect_issue_context
  - classify_impact_and_type
  - estimate_complexity
  - recommend_owner_or_skill_area
  - produce_action_items
output_contract: IssueAnalysisOutput
safety_level: read_only
---

# Issue Triage

Use this skill when the user wants to understand, classify, rank, assign or plan a GitHub Issue.

## Workflow

1. Gather the latest synced issue context (list_issues / get_issue) and read relevant repo knowledge when helpful (search_knowledge / memory_recall).
2. Decide category, priority and complexity only from explicit issue evidence.
3. Suggest an existing owner only when team context or the GitHub assignees give a concrete candidate.
4. If reproduction steps, acceptance criteria, impact scope or team context are insufficient, state exactly what needs clarification instead of guessing.
5. Return action items a maintainer can verify, and explain the WHY behind each core judgment.

## Boundaries

This skill runs read-only. It must not label, close, comment on or assign the issue directly — propose an action draft for any write.
