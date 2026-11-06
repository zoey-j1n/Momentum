// Sign out = forget the wristband. The server has nothing to revoke (signed cookie, decision #9); clearing
// the cookie is the whole operation. POST, not GET, so a link on some other site cannot sign you out.
import { NextResponse, type NextRequest } from "next/server";
import { clearSession } from "@/lib/auth/session";

export async function POST(req: NextRequest) {
  await clearSession();
  return NextResponse.redirect(new URL("/login", process.env.NEXT_PUBLIC_BASE_URL ?? req.url), { status: 303 });
}
