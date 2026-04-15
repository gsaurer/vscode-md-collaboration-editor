# Fabric AI Framework — Platform Agent MVP

> **Status**: Draft | **Last Updated**: 2026-04-15 | **Owner**: Gerd Saurer
> **Priority**: P0 | **Delivery Target**: MVP | **Total Stories**: 111 (21 F1 + 8 F3 + 4 F4 + 2 F5 + 18 F6 + 8 F7 + 5 F8 + 9 F9 + 14 F10 + 5 F11 + 5 F12 + 5 F14 + 5 F15)
> **Key Decision (2026-03-26)**: Sessions managed by infrastructure storage (no Copilot item in MVP); all sessions private (no sharing in MVP)
> **Scope**: Platform agent (Fabric portal) only; local development managed separately

> ⚠️ **MVP Constraint — Private Sessions Only**
> All sessions in MVP are **private to the user who created them**. There is no session sharing, collaboration, or visibility across users. A session belongs to one user; only that user can view, resume, or delete it. Session sharing is explicitly deferred to P1+.

> 📌 **Design Decision — No Workload Opt-Out**
> The Copilot pane is a **global portal capability**. Workloads **cannot opt out** of the unified Copilot. The Copilot nav bar button is active on every portal page — including hubs (OneLake catalog, database hub), deployment pipelines, and admin experiences. Context-setting must support all of these locations: the platform detects the current portal location and populates context accordingly, falling back to the user’s last active workspace when no workspace/item can be determined. A workload that has not registered skills will have no dedicated skill coverage for their surface, but base skills remain active. See [F1-S21](../features/f1-portal-integration.md) for the story.

***

## Table of Contents

1. [Document Purpose](#document-purpose)
2. [Executive Summary](#executive-summary)
3. [Error Handling Principles](#error-handling-principles)
4. [MVP Feature Summary](#mvp-feature-summary)
5. [Success Metrics (MVP Exit Criteria)](#success-metrics-mvp-exit-criteria)
6. [Dependencies & Risks](#dependencies--risks)
7. [MVP Implementation Stages](#mvp-implementation-stages)
8. [Post-MVP Roadmap (P1+)](#post-mvp-roadmap-p1)
9. [Appendix: MVP Documentation Map](#appendix-mvp-documentation-map)

***

## Document Purpose

This document defines the **Platform Agent MVP** — the Fabric AI assistant experience within the **Microsoft Fabric portal**. This is organized by **features** to enable direct conversion to feature backlog. Each feature represents a cohesive user-facing capability built from multiple architectural building blocks. Each feature section defines:

* **P0 Scope** — What must ship in platform MVP

* **Out of Scope** — What is deferred post-MVP or handled separately

* **User Stories** — Mapped to backlog items

* **Success Criteria** — Measurable outcomes

**What This Document Covers:**

* Fabric portal side pane experience

* Platform-hosted sessions (infrastructure-managed storage)

* Portal-based authentication and RBAC

* Skills and plugins loaded in portal context

**What This Document Does NOT Cover:**

* Local development surfaces (GitHub CLI, GitHub Copilot, VS Code, Claude) — see [Local Agent Development](./local-agent-dev.md)

* M365 Copilot integration (Teams, Outlook) — P2+

**Related Architectural Documents:**

* [Building Blocks Overview](../building-blocks/README.md) — Architectural foundation (referenced by features)

* [Session](../building-blocks/session.md) — Session runtime behavior

* [Copilot Service](../building-blocks/copilot-service.md) — Service runtime, execution environment management

* [Session Context](../building-blocks/session-context.md) — Context composition and history

* [Local Development](../building-blocks/local-development.md) — CLI, VS Code, Claude Code integration

***

## Executive Summary

The **Platform Agent MVP** delivers AI-assisted capabilities **within the Microsoft Fabric portal**, enabling users to:

* Open Copilot side pane from workspace or item views in the Fabric portal

* Start AI-assisted conversations scoped to their workspace or item

* Store sessions in infrastructure-managed storage (private to each user)

* Execute operations via natural language using workload-specific skills and tools

* Leverage multiple AI models based on their subscription (GitHub Copilot, BYOM, Fabric Capacity)

**MVP Principle:** Focus on **platform-hosted experience first** — prove the session model, skill routing, and MCP tool execution in the primary surface (Fabric portal). Local development tools managed separately.

**MVP Scope:**

* **Surface:** Fabric portal side pane only

* **Sessions:** **Private to the creating user only** — no sharing, no collab, no cross-user visibility in MVP (P1+)

* **Skills pipeline:** Internal contribution repo → testing → cloud deployment + public repo sync

* **Local development** (GitHub CLI, GitHub Copilot, VS Code, Claude) managed separately — see [Local Agent Development](./local-agent-dev.md)

**Out of Scope:** Session sharing (P1), local development surfaces (see [local-agent-dev.md](./local-agent-dev.md)), M365 Copilot (P2+).

***

## Error Handling Principles

**User-Facing Error Philosophy:**

All errors presented to users must be:

* **Actionable** — Tell user what they can do (retry, contact admin, check permissions)

* **Jargon-free** — No stack traces, internal error codes, or technical terminology

* **Context-aware** — Reference the specific workspace/item/operation that failed

* **Recovery-oriented** — Explain whether the system auto-retried, what succeeded, what needs manual action

**Error Categories & Recovery:**

| Category          | Examples                                        | Auto-Recovery                    | User Action                                             |
| ----------------- | ----------------------------------------------- | -------------------------------- | ------------------------------------------------------- |
| **Transient**     | Network timeout, MCP server 503, token refresh  | Auto-retry up to 3x with backoff | None (transparent)                                      |
| **Permissions**   | RBAC denial, capacity quota exceeded            | No retry                         | Check workspace permissions, verify capacity assignment |
| **Configuration** | Invalid skill frontmatter, missing MCP endpoint | No retry                         | Fix configuration, contact workload team                |
| **Capacity**      | Execution environment unavailable, queue full   | Queue or return 503              | Retry later, check capacity dashboard                   |
| **Model**         | LLM timeout, token limit exceeded               | Retry with fallback model        | Shorten prompt, start new session                       |

**Key Patterns:**

* **Automatic retry** — Transient errors (network, timeout) retry 3x before surfacing to user

* **Graceful degradation** — MCP tools unavailable → read-only mode with notification

* **Session preservation** — Model failures → retry with fallback model, keep conversation history

* **Admin visibility** — All errors logged with full context (user, session, workspace, error category, recovery action)

***

## MVP Feature Summary

**Total P0 User Stories: 111**

| Feature                                                                               | Stories | Focus                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[Portal Integration](../features/f1-portal-integration.md)**                        | 21      | Entry points (workspace, nav bar, item editors, hubs, deployment pipelines, all portal locations), side pane UI, item integration, context awareness, auth, session list/history UX, session deletion, session restoration, session resume, workspace-scoped session creation, workspace visibility in history, resource attachment UX, session instructions management UX, model picker UX, model access error UX, error display, progress indicators, chat hooks for workload telemetry, universal context support for non-item portal locations |
| **[Model Support](../features/f11-model-support.md)**                                 | 5       | GitHub Copilot, BYOM (Azure AI Foundry), Fabric Capacity models, model switching, provider authentication, cost visibility                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **[Session Management](../features/f3-session-management.md)**                        | 8       | Authentication & token management, context switching, permission handling, approval workflows, session context & history, resource attachment, cancellation                                                                                                                                                                                                                                                                                                                                                                                        |
| **[Session Storage & History](../features/f4-session-storage-history.md)**            | 4       | Infrastructure-managed storage (OneLake/PowerBIStore), conversation history persistence, state persistence, token truncation, privacy (all sessions private in MVP)                                                                                                                                                                                                                                                                                                                                                                                |
| **[Session Instructions](../features/f5-session-configuration.md)**                   | 2       | Session-level instruction files (upload .md, inject into execution environment), live instruction updates at prompt boundary                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **[Agent Execution Environment](../features/f6-agent-execution-environment.md)**      | 18      | Execution environments, capacity integration, governance, FUSE virtual filesystem, transparent token handling, session instruction loading, instruction change propagation, skill auto-update (<5min), skill version visibility, error monitoring                                                                                                                                                                                                                                                                                                  |
| **[Headless Sessions](../features/f15-headless-sessions.md)**                         | 5       | Workload-initiated AI sessions via API, no chat UI, no session history, no user token access, billed to the item's workspace capacity, item-type skill loading                                                                                                                                                                                                                                                                                                                                                                                     |
| **[Long-Running Operations](../features/f9-long-running-operations.md)**              | 9       | Task initiation UX, task tracking view, progress monitoring, task lifecycle, cross-surface visibility, Osmos integration                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **[Billing & Metering](../features/f12-billing-metering.md)**                         | 5       | LLM token metering, session runtime compute metering, capacity attribution (workspace vs tenant), F64 SKU enforcement, tenant admin opt-in error handling, standard Fabric capacity report integration                                                                                                                                                                                                                                                                                                                                             |
| **[Copilot Governance](../features/f14-copilot-governance.md)**                       | 5       | Workspace Copilot settings panel, workspace-level Azure AI Foundry model management, capacity source selection (workspace vs dedicated Copilot capacity), tenant admin policy enforcement, workspace default model                                                                                                                                                                                                                                                                                                                                 |
| **[Workload Extension Skills](../features/f7-workload-extension-skills.md)**          | 8       | Skill definition, routing, coverage, testing, contribution pipeline, cloud deployment, public sync                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **[Workload Extension Remote MCP](../features/f8-workload-extension-remote-mcp.md)**  | 5       | MCP endpoint registration, agent-side client, auth injection, error handling, health monitoring                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **[Workload Extension Evaluation](../features/f10-workload-extension-evaluation.md)** | 14      | Evaluation set definition (prompt, prerequisites, expected results), test execution framework, token usage & time measurement, model benchmarking (Fabric Capacity + Claude Sonnet 4.6), workload team submission, CI/CD integration, minimum 50 tests per workload, trend tracking over time                                                                                                                                                                                                                                                      |

**Deferred to P1+:**

* ❌ **Session sharing** — Collaborative sessions, shared session links, read-only session viewers (P1+)

* ❌ **Cross-user session visibility** — Admins or teammates cannot see another user's sessions in MVP

* ❌ **Copilot item (Fabric item type)** — Sessions use infrastructure storage in MVP; the named Copilot Fabric item (workspace-visible, Git-backed, configurable) is deferred to P1+

* ❌ **Copilot Settings item** — Workspace-level persistent configuration item (custom skills directories, Git versioning, zero-config auto-creation) deferred to P1+ ([spec](../features/f13-copilot-settings-item.md))

* ❌ **Portal Copilot CLI** — Browser-based CLI terminal with Fabric skills ([spec](../features/f2-portal-copilot-cli.md))

* Session discovery UI across workspaces

* Third-party skill contributions (ISV/partner)

* Model governance (allowlists, cost controls)

* Advanced billing analytics

* Skills Simulator (interactive testing environment)

***

## Success Metrics (MVP Exit Criteria)

> Feature-specific success metrics and acceptance criteria live in each feature document. This section defines the **overall exit gate** — conditions that must all be true before MVP is considered complete.

**Overall MVP Exit Criteria:**

* ✅ All 105 P0 stories completed and tested

* ✅ All 5 P0 workload skills delivered (SQL DW, Spark, Notebook, Pipeline, Base)

* ✅ Portal side pane accessible on 100% of workspaces

* ✅ Session continuity after browser refresh

* ✅ Minimum one MCP endpoint registered and operational per P0 workload

* ✅ Error messages contain no stack traces or internal codes (100% compliance)

* ✅ Capacity dashboard shows AI consumption accurately

* ✅ Task tracking view functional for Osmos-delegated tasks

* ✅ Minimum 50 evaluation sets per P0 workload with ≥95% pass rate

***

## Dependencies & Risks

### External Dependencies

| Dependency                   | Owner           | Risk                                                      | Mitigation                                                     |
| ---------------------------- | --------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| **GitHub Copilot SDK**       | GitHub          | Model availability tied to GitHub service health          | Support BYOM and Fabric Capacity as fallbacks                  |
| **Azure AI Foundry**         | Azure           | BYOM users require active Azure subscriptions             | Default to GitHub Copilot for users without Azure              |
| **Fabric RBAC**              | Fabric Platform | Session permissions depend on Fabric auth system          | Inherit portal auth; degrade gracefully on permission failures |
| **Fabric Capacity Metering** | Fabric Billing  | CU attribution for compute execution                      | Detailed logging and reconciliation with billing API           |
| **Osmos Orchestrator**       | Osmos Team      | Long-running task execution depends on Osmos availability | Clear API contract; fallback to read-only mode if unavailable  |
| **Workload MCP Endpoints**   | Workload Teams  | Tool availability depends on workload-hosted servers      | Health monitoring; graceful degradation to read-only mode      |

### Key Risks

| Risk                               | Impact                                 | Mitigation                                                                          |
| ---------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| **GitHub Copilot outage**          | Users cannot access models             | Support BYOM and Fabric Capacity as fallback paths                                  |
| **MCP server downtime**            | Tools unavailable for workload         | Health checks every 60s; fallback to read-only mode; retry logic (3x with backoff)  |
| **Token budget exceeded**          | AI loses context mid-conversation      | Auto-summarization + hard truncation; surface error to user with guidance           |
| **Fabric Capacity model costs**    | Unpredictable CU consumption           | Keep exploratory; default to GitHub Copilot; show consumption in capacity dashboard |
| **Osmos orchestrator unavailable** | Long-running tasks cannot be created   | Clear error message; allow retry; task tracking view shows "unavailable" state      |
| **Skill quality issues**           | AI provides incorrect/harmful guidance | Manual quality validation (5 P0 skills); CI checks on all PRs; rollback capability  |

***

## MVP Implementation Stages

This section defines a phased rollout strategy for fast time-to-market while proving critical capabilities incrementally.

### Stage 1 — Portal Side Pane + E2E Flow

**Goal:** Prove the full stack works end-to-end in the portal — side pane open, model responds, skill executes MCP tools

**Philosophy:** Transient sessions without persistence. Deliberately simple to deliver fast feedback — side pane is the surface, not the CLI.

**Stories in Scope:**

* **F1-S1** — Side pane opens from workspace hub

* **F1-S5** — Authentication (inherit from portal)

* **F11-S1** — GitHub Copilot model integration

* **F7-S1** — Base skills loaded and context routing

* **F8-S1** — MCP server registration (one workload: Data Warehouse)

* **F6-S1** — Execution environment spawns containers

* **F6-S2** — Container isolation and lifecycle

**Validation Criteria:**

* User opens side pane from workspace hub

* AI responds using GitHub Copilot model

* AI responds with MCP tool calls (e.g., `get_table_schema`)

* Container executes tools successfully

* Conversation ends when session terminates (no persistence)

**What's Deferred:** Workspace/item context, session storage, approval workflow, item editor integration

***

### Stage 2 — Workspace/Item Context

**Goal:** Prove context routing works — AI knows where the user is in the portal

**Stories in Scope:**

* **F1-S2** — Item editor integration (object context passing)

* **F1-S3** — Automatic context awareness (where user is in UI)

* **F1-S4** — Manual context switching

* **F7-S1** — Context-based skill routing

* **F4-S1** — Session storage (basic persistence added here)

**Validation Criteria:**

* User opens from warehouse item editor → table context passed automatically

* User selects multiple tables → AI knows selection

* Skills load/unload when switching workspace ↔ warehouse

* Session persists across page refreshes (infrastructure-managed storage)

**What's Deferred:** Session management UI, user configuration (custom skills), approval workflow, long-running tasks

**UX Integration:** Portal provides context automatically via editor integration; no need for manual context commands.

***

### Stage 3 — User Customization + Session Management

**Goal:** Prove session model and user configuration work

**User Context Definition:** This stage adds **user-specific customization** (custom skills directories, instructions, configuration) — NOT workspace/item context (that's Stage 2).

**Stories in Scope:**

* **F1-S6** — Portal session persistence

* **F1-S7** — Session history (list sessions, navigate)

* **F1-S8** — Session deletion with confirmation

* **F1-S9** — Last session restoration

* **F5-S1** — Upload instruction files into session (injected into execution environment)

* **F3-S1, F3-S2, F3-S3, F3-S4** — Approval workflow

* **F5-S3** — Bulk approval toggle

**Validation Criteria:**

* User can view all sessions in workspace

* User can switch between sessions without losing context

* User uploads an instruction .md file → AI follows instructions from next prompt

* AI asks for approval before editing warehouse table

**What's Deferred:** Multi-model, task tracking, FUSE, CLI integration, headless sessions

***

### Stage 4 — Multi-Model & Advanced Operations

**Goal:** Prove multi-model strategy and long-running operations work

**Stories in Scope:**

* **F11-S2** — BYOM (Azure AI Foundry)

* **F11-S3** — Fabric Capacity models

* **F11-S4** — Model switching during session

* **F3-S7** — Request cancellation

* **F12-S1** — LLM token metering (Fabric Billing API contract)

* **F12-S3** — Consumption visible in standard capacity report

**Validation Criteria:**

* User switches from GitHub Copilot to BYOM mid-conversation

* User starts long-running query → leaves page → comes back → query still running

* User cancels long-running operation mid-execution

* Capacity dashboard shows CU consumption for Fabric Capacity model usage

**What's Deferred:** Task tracking UX, FUSE, skill contributions

***

### Stage 5 — Ecosystem Integration

**Goal:** Prove third-party integrations and advanced workflows

**Stories in Scope:**

* **F9-S1, F9-S2, F9-S9** — Long-running task tracking (Osmos UX integration)

* **F15-S1 – F15-S5** — Headless sessions (item-embedded AI, workload-initiated)

* **F7-S3** — Skill contribution workflow (PR-based)

* **F6-S10** — FUSE virtual filesystem

**Validation Criteria:**

* Osmos long-running task appears in task tracking view

* Workload team contributes skill via PR → deployed after CI evals pass

* Agent can browse `/fabric/skills/` and dynamically load skill

* Item-embedded AI (e.g., notebook auto-suggest) works via headless session (F15)

**Post-Stage 5 Remaining for P1:**

* Session sharing (collaborative sessions with multiple users)

* Cross-session memory

* Multimodal inputs (images, audio)

* Session sharing UI

* Session branching/forking

***

## Appendix: MVP Documentation Map

| Document                                                                      | Purpose                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| [platform-agent-mvp.md](platform-agent-mvp.md)                                | **This document** — consolidated MVP definition        |
| **Building Blocks**                                                           | <br />                                                 |
| [README.md](../building-blocks/README.md)                                     | Building blocks overview and architecture              |
| [copilot-ux.md](../building-blocks/copilot-ux.md)                             | Portal user experience patterns                        |
| [copilot-item.md](../building-blocks/copilot-item.md)                         | Storage and configuration container (P1+ Copilot item) |
| [session.md](../building-blocks/session.md)                                   | Session runtime behavior and lifecycle                 |
| [session-context.md](../building-blocks/session-context.md)                   | Context composition and history                        |
| [copilot-service.md](../building-blocks/copilot-service.md)                   | Service runtime, execution environment management      |
| [models.md](../building-blocks/models.md)                                     | Model acquisition and selection                        |
| [plugin.md](../building-blocks/plugin.md)                                     | Skill format and plugin model                          |
| [billing.md](../building-blocks/billing.md)                                   | Billing and metering                                   |
| [governance.md](../building-blocks/governance.md)                             | RBAC and governance                                    |
| [ecosystem-integration.md](../building-blocks/ecosystem-integration.md)       | Platform boundaries                                    |
| [local-development.md](../building-blocks/local-development.md)               | CLI, VS Code, Claude Code integration (separate track) |
| **Deferred Building Blocks**                                                  | <br />                                                 |
| [autonomous-agents.md](../building-blocks/autonomous-agents.md)               | Long-running background agents (P1+)                   |
| [plugin-contribution.md](../building-blocks/plugin-contribution.md)           | ISV/partner skill contributions (P1+)                  |
| [plugin-testing-framework.md](../building-blocks/plugin-testing-framework.md) | Automated testing pipeline (P1+)                       |
