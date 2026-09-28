import { contactRequest } from "@/lib/api/contract";
import { errorResponse, json, parseBody } from "@/lib/server/http";
import { requireSession, saveContact } from "@/lib/server/session-service";

export async function POST(req: Request) {
  try {
    const id = await requireSession();
    await parseBody(req, contactRequest);
    return json(await saveContact(id));
  } catch (err) {
    return errorResponse(err);
  }
}
