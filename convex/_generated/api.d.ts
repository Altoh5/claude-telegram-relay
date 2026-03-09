/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as assets from "../assets.js";
import type * as asyncTasks from "../asyncTasks.js";
import type * as boardSessions from "../boardSessions.js";
import type * as callTranscripts from "../callTranscripts.js";
import type * as logs from "../logs.js";
import type * as memory from "../memory.js";
import type * as messages from "../messages.js";
import type * as nodeHeartbeat from "../nodeHeartbeat.js";
import type * as projects from "../projects.js";
import type * as twinmindMeetings from "../twinmindMeetings.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  assets: typeof assets;
  asyncTasks: typeof asyncTasks;
  boardSessions: typeof boardSessions;
  callTranscripts: typeof callTranscripts;
  logs: typeof logs;
  memory: typeof memory;
  messages: typeof messages;
  nodeHeartbeat: typeof nodeHeartbeat;
  projects: typeof projects;
  twinmindMeetings: typeof twinmindMeetings;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
