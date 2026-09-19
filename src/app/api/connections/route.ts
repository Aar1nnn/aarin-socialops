import { NextResponse } from "next/server";
import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { listPlatformConnections } from "@/services/platform-connection-service";

export async function GET() {
  try {
    const context = await requireContext();
    return NextResponse.json({ connections: await listPlatformConnections(context) });
  } catch (error) {
    return errorResponse(error);
  }
}
