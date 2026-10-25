---
name: ci-debug
title: CI Debug
version: 0.1.0
description: Diagnose a failed GitHub Actions workflow run from job metadata and logs, and propose likely causes plus next debug steps.
category: github-analysis
entrypoint: analyze_workflow_run
tools:
  - list_ci_runs
  - get_ci_run
  - workspace_search_code
  - workspace_read_file
  - search_knowledge
input_modes:
  - latest_failed_workflow_run
  - ci_context_from_chat
triggers:
  - ci
  - workflow
  - github actions
  - 流水线
  - 构建失败
  - 测试失败
workflow_steps:
  - collect_failed_jobs_and_logs
  - classify_failure_type
  - identify_likely_root_causes
  - map_failure_to_code_or_config
  - produce_debug_steps
output_contract: CIDebugOutput
safety_level: read_only
---

# CI Debug

Use this skill when the user asks why CI failed, which test or job errored, or how to troubleshoot a failed workflow run.

## Workflow

1. Read the latest failed workflow run, its jobs, steps and any available logs (list_ci_runs / get_ci_run).
2. Classify the failure type before proposing a fix direction.
3. Tie each likely cause to evidence in the logs or repo context; when there is no log evidence, mark it as inference and lower the confidence.
4. Prefer the FIRST key error block as the root-cause entry; do not substitute downstream cascading errors for it.
5. Return focused debug steps and the relevant files (workspace_search_code / workspace_read_file) when available.

## Boundaries

This skill only diagnoses and drafts next steps. It must not push commits, re-run workflows or edit repository files.
