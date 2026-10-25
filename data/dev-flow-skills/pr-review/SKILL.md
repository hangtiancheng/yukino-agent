---
name: pr-review
title: PR Review
version: 0.1.0
description: Review a synced Pull Request into a summary, key changes, P1/P2/P3 findings, blockers, test gaps and files to watch.
category: github-analysis
entrypoint: analyze_pr
tools:
  - list_pulls
  - get_pull
  - workspace_read_file
  - workspace_search_code
  - search_knowledge
input_modes:
  - latest_synced_pr
  - pr_context_from_chat
triggers:
  - pr
  - pull request
  - 合并请求
  - 代码审查
  - review
  - 能不能合并
workflow_steps:
  - collect_pr_diff_and_comments
  - summarize_key_changes
  - classify_findings_by_p1_p2_p3
  - identify_risky_files
  - propose_tests
  - produce_merge_readiness_notes
output_contract: PRReviewOutput
safety_level: read_only
---

# PR Review

Use this skill when the user asks whether a PR is safe to merge, what changed, what the risks are, or which tests to add.

## Workflow

1. Collect the PR title, body, changed files, patches and review comments (list_pulls / get_pull).
2. Summarize the implementation change in language a maintainer can scan quickly.
3. Emit findings graded P1/P2/P3; each finding needs evidence, a required action and whether it blocks.
4. Any P1/P2 must be treated as blocking — do not recommend merging while one stands.
5. Call out risky files and the areas that need focused attention (workspace_read_file / workspace_search_code for the current code).
6. Propose tests that match the change surface.

## Grading

- P1: functional bug, security issue, data risk, or failing CI that blocks — must be fixed before merge.
- P2: insufficient test coverage, missed edge cases, unaddressed review comments, or sensitive files lacking validation — must be verified before merge.
- P3: style, naming, maintainability or non-blocking improvements — can go to the backlog.

Never substitute "looks good" for a review conclusion. Even with no P1/P2, state the evidence, the remaining P3 suggestions and a final human-confirmation checklist.

## Boundaries

This skill only produces review advice. It must not approve, request changes, merge or comment on GitHub directly.
