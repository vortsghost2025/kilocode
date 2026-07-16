---
name: provider-model-routing
description: Select provider, model, and opaque credential reference per agent without inheriting or exposing secret values.
---

# provider-model-routing

## Activation conditions

Use when defining or reviewing agent identity, model fallback, provider routing, or credential ownership.

## Required inputs

Agent ID, approved providers/models, credential reference names, fallback policy, and task budget.

## Allowed tools

Read provider/model metadata and reference names; compare declared routing policy.

## Prohibited actions

Reading keys/tokens, copying parent credentials, changing auth storage, provider login, or silent fallback across identities.

## Stopping conditions

Stop when the credential owner is unknown, a direct secret appears, or the requested model lacks an approved reference.

## Required evidence

Agent, provider/model IDs, reference name, fallback decision, budget, and denied alternatives.

## When this skill must not be used

Do not use to authenticate, refresh OAuth, or reveal provider configuration values.
