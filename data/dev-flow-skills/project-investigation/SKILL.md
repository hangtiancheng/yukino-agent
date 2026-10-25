---
name: project-investigation
title: Project Evidence Investigation
version: 0.1.0
description: Answer current-implementation and historical-decision questions by combining the workspace, project knowledge and conversation memory.
category: project-analysis
entrypoint: search_evidence
tools:
  - workspace_list_files
  - workspace_search_code
  - workspace_read_file
  - search_knowledge
  - search_project_docs
  - memory_recall
input_modes:
  - current_implementation
  - historical_decision
  - conversation_recall
triggers:
  - 当前实现
  - 源码
  - 代码在哪
  - 历史原因
  - 历史决策
  - 历史证据
  - 以前讨论
  - 项目证据
  - 项目记忆
  - 会话原话
workflow_steps:
  - identify_current_or_historical_question
  - search_current_workspace_for_current_code
  - search_project_evidence_for_history
  - read_exact_file_or_session_when_needed
  - answer_with_citations_and_uncertainty
output_contract: evidence_answer
safety_level: read_only
---

# Project Evidence Investigation

Use this skill when the user asks about the current implementation, a historical reason, or a prior discussion.

## Workflow

1. Decide whether the question targets current source code, project history, or the current conversation.
2. For current source, use workspace_search_code, then workspace_read_file for context.
3. For historical issues, PRs, CI, project knowledge and approved memory, use search_knowledge / search_project_docs / memory_recall.
4. When the user asks for the original conversation, use memory_recall to surface sealed thread context.
5. In the answer, separate evidence, inference and unknowns, and keep verifiable citations.

## Boundaries

This skill runs read-only. It must not modify source, write to GitHub, approve memory candidates or execute external actions on the user's behalf.
