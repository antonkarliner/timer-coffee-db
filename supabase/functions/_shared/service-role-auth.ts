export type ServiceRoleAuthorization =
  | { authorized: true }
  | { authorized: false; status: 401 | 403; error: string };

export function authorizeServiceRole(
  authorizationHeader: string | null,
  serviceRoleKey: string,
): ServiceRoleAuthorization {
  if (!authorizationHeader) {
    return {
      authorized: false,
      status: 401,
      error: "Missing Authorization header.",
    };
  }

  const match = /^Bearer\s+(.+)$/iu.exec(authorizationHeader);
  if (!match) {
    return {
      authorized: false,
      status: 401,
      error: "Authorization header must use Bearer authentication.",
    };
  }

  if (!constantTimeEqual(match[1], serviceRoleKey)) {
    return {
      authorized: false,
      status: 403,
      error: "Service-role authorization is required.",
    };
  }

  return { authorized: true };
}

function constantTimeEqual(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maxLength; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^
      (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
