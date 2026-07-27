// kilocode_change - new file
// Registers all Kilo-specific instance routes on a Hono app.
// Called from ../../server/instance.ts before the catch-all route.

import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { TelemetryRoutes } from "../../server/routes/telemetry"
import { CommitMessageRoutes } from "../../server/routes/commit-message"
import { EnhancePromptRoutes } from "../../server/routes/enhance-prompt"
import { KilocodeRoutes } from "../../server/routes/kilocode"
import { PermissionKilocodeRoutes } from "../permission/routes"
import { RemoteRoutes } from "../../server/routes/remote"
import { NetworkRoutes } from "../../server/routes/network"
import { createKiloRoutes } from "@kilocode/kilo-gateway"
import { Auth } from "../../auth"
import { errors } from "../../server/error"
import { ModelCache } from "../../provider/model-cache"
import { Database } from "../../storage/db"
import { Instance } from "../../project/instance"
import { Session } from "../../session"
import { Identifier } from "../../id/id"
import { SessionTable, MessageTable, PartTable } from "../../session/session.sql"
import { Bus } from "@/bus"
import { Flag } from "../../flag/flag" // kilocode_change
import { SharedTerminalRoutes } from "../shared-terminal/routes" // kilocode_change
import { sharedTerminalRuntime } from "../shared-terminal/runtime" // kilocode_change
import { ListenerPolicy } from "../../server/listener-policy" // kilocode_change

export function register(app: Hono): Hono {
  // kilocode_change start
  // ST-06Q1: mount the shared-terminal route only when the experimental flag
  // is on. Pass the runtime getter itself (sharedTerminalRuntime) rather than
  // its current result, so the lazily reused Hono app never captures one
  // workspace's runtime. The getter is NOT called here. Q1 returns a 503
  // quarantine response without ever invoking the getter.
  // kilocode_change end
  const withSharedTerminal: Hono = Flag.KILO_EXPERIMENTAL_SHARED_TERMINAL
    ? app.route(
        "/shared-terminal",
        SharedTerminalRoutes({
          listenerPolicy: ListenerPolicy.current,
          runtimeGetter: sharedTerminalRuntime,
        }),
      )
    : app
  return withSharedTerminal
    .route("/permission", PermissionKilocodeRoutes())
    .route("/network", NetworkRoutes())
    .route("/telemetry", TelemetryRoutes())
    .route("/remote", RemoteRoutes())
    .route("/commit-message", CommitMessageRoutes())
    .route("/enhance-prompt", EnhancePromptRoutes())
    .route("/kilocode", KilocodeRoutes())
    .route(
      "/kilo",
      createKiloRoutes({
        Hono,
        describeRoute,
        validator,
        resolver,
        errors,
        Auth,
        z,
        Database,
        Instance,
        SessionTable,
        MessageTable,
        PartTable,
        SessionToRow: Session.toRow,
        Bus,
        SessionCreatedEvent: Session.Event.Created,
        Identifier,
        ModelCache,
      }),
    )
}
