export interface VerifiedAuthUser {
  id: string;
}

export interface TokenVerifier {
  getUser(token: string): Promise<{
    data: { user: VerifiedAuthUser | null };
    error: unknown;
  }>;
}

export type VerifiedUserResult =
  | { ok: true; userId: string }
  | {
    ok: false;
    reason: "missing_or_invalid_header" | "verification_failed";
  };

export async function resolveVerifiedUser(
  authorization: string | null,
  verifier: TokenVerifier,
): Promise<VerifiedUserResult> {
  if (!authorization?.startsWith("Bearer ")) {
    return { ok: false, reason: "missing_or_invalid_header" };
  }

  const token = authorization.slice("Bearer ".length);
  if (!token || /\s/.test(token)) {
    return { ok: false, reason: "missing_or_invalid_header" };
  }

  try {
    const { data, error } = await verifier.getUser(token);
    const userId = data.user?.id;

    if (error || typeof userId !== "string" || userId.length === 0) {
      return { ok: false, reason: "verification_failed" };
    }

    return { ok: true, userId };
  } catch {
    return { ok: false, reason: "verification_failed" };
  }
}
