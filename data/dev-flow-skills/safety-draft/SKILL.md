---
name: safety-draft
title: Safety Draft
version: 0.1.0
description: Detect risky external sends or GitHub writes and produce a human-reviewable action draft instead of executing the write.
category: safety
entrypoint: classify_action_risk
tools:
  - create_action_draft
  - memory_recall
input_modes:
  - write_intent_from_chat
  - external_send_intent
triggers:
  - 评论
  - 回复
  - comment
  - 打标签
  - label
  - 关闭 issue
  - 创建 issue
  - 发送报告
  - 外部发送
  - 写入
workflow_steps:
  - detect_write_or_send_intent
  - classify_action_risk
  - draft_human_reviewable_output
  - require_confirmation
output_contract: SafetyDraft
safety_level: guarded_write_draft
---

# Safety Draft

Use this skill when the user asks to comment, reply, label, close an issue, create an issue, send a report, or perform any write outside the conversation.

## Workflow

1. Detect the external write or send intent.
2. Classify the action risk and identify sensitive context.
3. Produce a human-reviewable draft via create_action_draft (never call GitHub directly).
4. Explain why human confirmation is required and which tool or human step completes the action after approval.
5. Stop before any external action is executed.

## Boundaries

This skill never executes a write directly; it only returns a draft and a confirmation requirement.
