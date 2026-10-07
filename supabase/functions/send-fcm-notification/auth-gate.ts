import {
  authorizeServiceRequest,
  type ServiceRoleAuthorization,
} from "../_shared/service-role-auth.ts";

export function gateSendFcmRequest(
  req: Request,
  serviceRoleKey: string,
): ServiceRoleAuthorization {
  return authorizeServiceRequest(req, serviceRoleKey);
}
