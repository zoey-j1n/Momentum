// Who the dashboard is acting for: the signed-in person and their workspace, from the session cookie
// (decision #9). Replaces the Milestone 6 stand-ins (requester-as-approver, most-recent workspace).
//
// The session carries ids only. We re-read the user row every request so a user deleted from the database
// stops working immediately even though the cookie is still valid for up to 7 days.
import { AuthError, readSession } from "../auth/session";
import { prisma } from "../db";

export type DashboardContext = {
  workspaceId: string;
  workspace: { id: string; name: string; slackTeamId: string };
  user: { id: string; displayName: string; hasToken: boolean };
};

export async function currentContext(): Promise<DashboardContext | null> {
  const session = await readSession();
  if (!session) return null;
  const user = await prisma.slackUser.findFirst({
    where: { id: session.userId, workspaceId: session.workspaceId }, // both: a cookie cannot pair a user with another workspace
    select: { id: true, displayName: true, userTokenEnc: true, workspace: { select: { id: true, name: true, slackTeamId: true } } },
  });
  if (!user) return null;
  return { workspaceId: user.workspace.id, workspace: user.workspace, user: { id: user.id, displayName: user.displayName, hasToken: user.userTokenEnc !== null } };
}

/** For server actions: the context, or an AuthError that becomes "sign in again". */
export async function requireContext(): Promise<DashboardContext> {
  const ctx = await currentContext();
  if (!ctx) throw new AuthError("not signed in");
  return ctx;
}
