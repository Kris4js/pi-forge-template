import type { TenantIdentity, TenantIdentityInput } from "../types.js";

export const DEFAULT_WORKSPACE = "demo";
export const DEFAULT_USER_ID = "anonymous";

export type TenantCompatibilityOptions = {
  /**
   * When true, callers must provide userId. When false, missing userId falls back
   * to DEFAULT_USER_ID for backward compatibility with existing API/CLI clients.
   */
  requireUserId?: boolean;
};

export type ResolvedTenantIdentity = TenantIdentity & {
  /** True when userId was omitted and compatibility fallback was used. */
  anonymousUserFallback: boolean;
};

export function shouldRequireUserIdFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanEnv(env.PI_REQUIRE_USER_ID, false);
}

export function resolveTenantIdentity(
  input: TenantIdentityInput = {},
  options: TenantCompatibilityOptions = {},
): ResolvedTenantIdentity {
  const workspace = normalizeTenantSegment(input.workspace, DEFAULT_WORKSPACE, { lowerCase: true });
  const rawUserId = input.userId?.trim();
  const requireUserId = options.requireUserId ?? shouldRequireUserIdFromEnv();

  if (requireUserId && !rawUserId) {
    throw new Error("Missing required userId");
  }

  const anonymousUserFallback = !rawUserId;
  const userId = normalizeTenantSegment(rawUserId || DEFAULT_USER_ID, DEFAULT_USER_ID, { lowerCase: false });
  const sessionId = input.sessionId?.trim() || undefined;
  const agentName = input.agentName
    ? normalizeTenantSegment(input.agentName, "default", { lowerCase: true })
    : undefined;

  return { workspace, userId, sessionId, agentName, anonymousUserFallback };
}

export function normalizeTenantSegment(
  input: string | undefined,
  fallback: string,
  options: { lowerCase?: boolean; maxLength?: number } = {},
): string {
  const maxLength = options.maxLength ?? 128;
  let value = (input ?? "").trim();
  if (options.lowerCase) value = value.toLowerCase();
  if (!value) value = fallback;

  value = value
    .replace(/[/\\]+/g, "-")
    .replace(/\.\.+/g, "-")
    .replace(/[^a-zA-Z0-9_.@-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!value || value === ".") value = fallback;
  if (value.length > maxLength) value = value.slice(0, maxLength).replace(/[-.]+$/g, "") || fallback;
  return value;
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on", "required", "strict"].includes(value.trim().toLowerCase());
}
