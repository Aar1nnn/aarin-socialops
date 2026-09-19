import { NextResponse } from "next/server";
import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { listPlatformConnectionAccounts } from "@/services/platform-connection-service";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    return NextResponse.json({ accounts: await listPlatformConnectionAccounts(context, id) });
  } catch (error) {
    return errorResponse(error);
  }
}
